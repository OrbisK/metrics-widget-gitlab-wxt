import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  discoverReportSources,
  downloadReportText,
  fetchMrDiffRefs,
  findBasePipelines,
  RateLimitedError,
} from './gitlab-api';
import { rateLimitedUntil, resetRateLimit } from './rate-limit';
import { isRunning } from './types';

const info = { apiBase: '/api/v4', projectId: 7 };

type Handler = (url: string) => unknown;

/**
 * Answers each request from `routes`, matched by substring on the URL. An
 * unmatched URL is a test bug, not a 404, so it throws.
 */
function stubFetch(routes: Record<string, Handler | unknown>): () => string[] {
  const seen: string[] = [];

  vi.stubGlobal('fetch', async (url: string) => {
    seen.push(url);
    const match = Object.keys(routes).find((pattern) => url.includes(pattern));
    if (!match) throw new Error(`unexpected request: ${url}`);

    const route = routes[match];
    const body = typeof route === 'function' ? (route as Handler)(url) : route;
    if (body instanceof Error) throw body;

    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    });
  });

  return () => seen;
}

function pipeline(id: number, status: string, sha = `sha${id}`) {
  return { id, status, sha, web_url: `https://gitlab.example/g/p/-/pipelines/${id}` };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetRateLimit();
});

describe('fetchMrDiffRefs', () => {
  it('reads the target branch and the merge base', async () => {
    stubFetch({
      '/merge_requests/41': {
        target_branch: 'main',
        diff_refs: { base_sha: 'abc123', head_sha: 'def456' },
      },
    });

    expect(await fetchMrDiffRefs(info, 41)).toEqual({ targetBranch: 'main', baseSha: 'abc123' });
  });

  it('tolerates a merge request with no diff refs', async () => {
    stubFetch({ '/merge_requests/41': { target_branch: 'main', diff_refs: null } });

    expect(await fetchMrDiffRefs(info, 41)).toEqual({ targetBranch: 'main', baseSha: undefined });
  });

  it('refuses to guess when no target branch comes back', async () => {
    stubFetch({ '/merge_requests/41': {} });

    await expect(fetchMrDiffRefs(info, 41)).rejects.toThrow(/target branch/);
  });
});

describe('findBasePipelines', () => {
  const refs = { targetBranch: 'main', baseSha: 'abc123' };

  it('puts the merge base ahead of the target branch tip', async () => {
    stubFetch({
      'sha=abc123': [pipeline(10, 'success')],
      'ref=main': [pipeline(30, 'success'), pipeline(20, 'failed')],
    });

    const { candidates } = await findBasePipelines(info, refs, 99);

    expect(candidates.map((c) => [c.pipelineId, c.strategy])).toEqual([
      [10, 'merge-base'],
      [30, 'target-branch'],
      [20, 'target-branch'],
    ]);
    expect(candidates[0]).toMatchObject({
      targetBranch: 'main',
      sha: 'sha10',
      pipelineWebUrl: 'https://gitlab.example/g/p/-/pipelines/10',
    });
  });

  it('skips pipelines that have not finished', async () => {
    // A running pipeline may not have reached its metrics jobs, and a base missing
    // half its metrics would report the other half as newly added.
    stubFetch({
      'sha=abc123': [pipeline(12, 'running'), pipeline(11, 'pending'), pipeline(10, 'success')],
      'ref=main': [pipeline(30, 'created')],
    });

    const { candidates } = await findBasePipelines(info, refs, 99);
    expect(candidates.map((c) => c.pipelineId)).toEqual([10]);
  });

  it('falls back to the target branch when the merge base has no pipeline', async () => {
    stubFetch({ 'sha=abc123': [], 'ref=main': [pipeline(30, 'success')] });

    expect(await findBasePipelines(info, refs, 99)).toMatchObject({
      candidates: [{ pipelineId: 30, strategy: 'target-branch' }],
      failure: undefined,
    });
  });

  it('does not query the merge base when the merge request has none', async () => {
    const seen = stubFetch({ 'ref=main': [pipeline(30, 'success')] });

    await findBasePipelines(info, { targetBranch: 'main' }, 99);

    expect(seen().some((url) => url.includes('sha='))).toBe(false);
  });

  it('keeps the merge-base strategy for a pipeline both queries return', async () => {
    // The target branch has not moved since the merge request branched off it.
    stubFetch({ 'sha=abc123': [pipeline(10, 'success')], 'ref=main': [pipeline(10, 'success')] });

    expect((await findBasePipelines(info, refs, 99)).candidates).toMatchObject([
      { pipelineId: 10, strategy: 'merge-base' },
    ]);
  });

  it('never offers the head pipeline as its own base', async () => {
    stubFetch({ 'sha=abc123': [pipeline(10, 'success')], 'ref=main': [pipeline(10, 'success')] });

    expect((await findBasePipelines(info, refs, 10)).candidates).toEqual([]);
  });

  it('still falls back when the merge base lookup fails outright', async () => {
    stubFetch({ 'sha=abc123': new Error('boom'), 'ref=main': [pipeline(30, 'success')] });

    expect((await findBasePipelines(info, refs, 99)).candidates).toMatchObject([{ pipelineId: 30 }]);
  });

  it('reports no candidates rather than throwing when both lookups fail', async () => {
    stubFetch({ 'sha=abc123': new Error('boom'), 'ref=main': new Error('boom') });

    // The failure travels with the empty list: "we were not allowed to ask" and
    // "the branch has no pipeline" are the same empty list otherwise.
    expect(await findBasePipelines(info, refs, 99)).toMatchObject({
      candidates: [],
      failure: expect.stringContaining('boom'),
    });
  });

  it('does not blame the branch for a merge-base lookup that failed', async () => {
    stubFetch({ 'sha=abc123': new Error('boom'), 'ref=main': [] });

    expect((await findBasePipelines(info, refs, 99)).failure).toContain('boom');
  });
});

describe('discoverReportSources', () => {
  /** A job carrying one metrics report artifact, named after the pipeline. */
  function job(pipelineId: number) {
    return {
      id: pipelineId * 10,
      name: `metrics-${pipelineId}`,
      web_url: `https://gitlab.example/g/p/-/jobs/${pipelineId * 10}`,
      artifacts: [{ file_type: 'metrics' }],
    };
  }

  /** A pipeline whose jobs carry a report and which bridges to `child`. */
  function routes(child: Record<number, number>) {
    return {
      '/jobs': (url: string) => [job(pipelineOf(url))],
      '/bridges': (url: string) => {
        const downstream = child[pipelineOf(url)];
        return downstream ? [{ downstream_pipeline: { id: downstream, project_id: 7 } }] : [];
      },
    };
  }

  function pipelineOf(url: string): number {
    return Number(/\/pipelines\/(\d+)\//.exec(url)![1]);
  }

  it('follows as many levels of child pipelines as it is asked for', async () => {
    stubFetch(routes({ 1: 2, 2: 3 }));

    const { sources } = await discoverReportSources(info, 1, 2);

    expect(sources.map((source) => source.jobName)).toEqual(['metrics-1', 'metrics-2', 'metrics-3']);
  });

  it('stays in the pipeline itself at depth zero', async () => {
    const seen = stubFetch(routes({ 1: 2 }));

    const { sources } = await discoverReportSources(info, 1, 0);

    expect(sources.map((source) => source.jobName)).toEqual(['metrics-1']);
    // Nothing downstream is even asked about, which is the point of the setting.
    expect(seen().some((url) => url.includes('/bridges'))).toBe(false);
  });

  it('names the jobs that have not finished, here and downstream', async () => {
    stubFetch({
      '/pipelines/1/jobs': [
        { ...job(1), status: 'success' },
        { id: 11, name: 'bundle-size', web_url: 'https://gitlab.example/g/p/-/jobs/11', status: 'running' },
        { id: 12, name: 'deploy', web_url: 'https://gitlab.example/g/p/-/jobs/12', status: 'manual' },
      ],
      '/pipelines/1/bridges': [{ status: 'success', downstream_pipeline: { id: 2, project_id: 7 } }],
      '/pipelines/2/jobs': [{ ...job(2), artifacts: [], status: 'pending' }],
      '/pipelines/2/bridges': [],
    });

    const { progress } = await discoverReportSources(info, 1, 1);

    expect(progress).toEqual({
      unfinishedJobs: ['bundle-size', 'deploy', 'metrics-2'],
      manualJobs: ['deploy'],
      jobNames: ['metrics-1', 'bundle-size', 'deploy', 'metrics-2'],
      awaitingDownstream: false,
    });
  });

  it('notices a trigger job that has not created its pipeline yet', async () => {
    stubFetch({
      '/jobs': [{ ...job(1), status: 'success' }],
      '/bridges': [{ status: 'created', downstream_pipeline: null }],
    });

    const { progress } = await discoverReportSources(info, 1, 1);

    expect(progress.awaitingDownstream).toBe(true);
  });

  it('counts a manual trigger job as waiting, not running', async () => {
    stubFetch({
      '/jobs': [{ ...job(1), status: 'success' }],
      '/bridges': [{ name: 'deploy-child', status: 'manual', downstream_pipeline: null }],
    });

    const { progress } = await discoverReportSources(info, 1, 1);

    expect(progress.awaitingDownstream).toBe(true);
    expect(progress.manualJobs).toEqual(['deploy-child']);
    expect(isRunning(progress)).toBe(false);
  });
});

describe('discoverReportSources, artifact types', () => {
  it('keeps only metrics artifacts and builds their download URL from the job', async () => {
    stubFetch({
      '/jobs': [
        {
          id: 5,
          name: 'metrics',
          status: 'success',
          web_url: 'https://gitlab.example/g/p/-/jobs/5/',
          artifacts: [{ file_type: 'trace' }, { file_type: 'metrics' }],
          artifacts_expire_at: '2026-12-01T00:00:00Z',
        },
        {
          id: 6,
          name: 'semgrep-sast',
          status: 'success',
          web_url: 'https://gitlab.example/g/p/-/jobs/6',
          artifacts: [{ file_type: 'sast' }],
        },
      ],
    });

    const { sources } = await discoverReportSources(info, 1, 0);

    expect(sources).toEqual([
      {
        jobId: 5,
        jobName: 'metrics',
        jobWebUrl: 'https://gitlab.example/g/p/-/jobs/5/',
        downloadUrl: 'https://gitlab.example/g/p/-/jobs/5/artifacts/download?file_type=metrics',
        artifactsExpireAt: '2026-12-01T00:00:00Z',
      },
    ]);
  });
});

describe('downloadReportText', () => {
  it('gunzips a report served as gzip, the way gitlab.com serves it', async () => {
    const gzipped = await new Response(
      new Blob(['bundle_size_kb 412\n']).stream().pipeThrough(new CompressionStream('gzip')),
    ).arrayBuffer();
    vi.stubGlobal('fetch', async () => new Response(gzipped));

    expect(await downloadReportText('/x')).toBe('bundle_size_kb 412\n');
  });

  it('reads a report the browser already decompressed', async () => {
    vi.stubGlobal('fetch', async () => new Response('test_count 128\n'));

    expect(await downloadReportText('/x')).toBe('test_count 128\n');
  });
});

describe('rate limiting', () => {
  function limited(retryAfter = '120') {
    return new Response('Rate limit exceeded; see https://docs.gitlab.com/user/gitlab_com/rate_limits/', {
      status: 429,
      headers: { 'retry-after': retryAfter, 'ratelimit-name': 'unauthenticated_traffic_per_ip' },
    });
  }

  it('stops every request until GitLab’s Retry-After has passed', async () => {
    const fetch = vi.fn(async () => limited());
    vi.stubGlobal('fetch', fetch);

    await expect(fetchMrDiffRefs(info, 41)).rejects.toBeInstanceOf(RateLimitedError);
    expect(rateLimitedUntil()).toBeGreaterThan(Date.now() + 100_000);

    // Nothing reaches the network while the limit lasts, whichever call it is.
    await expect(downloadReportText('/x')).rejects.toMatchObject({ status: 429 });
    await expect(discoverReportSources(info, 1, 0)).rejects.toBeInstanceOf(RateLimitedError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('lets requests through again once the deadline is gone', async () => {
    vi.stubGlobal('fetch', async () => limited('0'));
    await expect(downloadReportText('/x')).rejects.toBeInstanceOf(RateLimitedError);

    vi.stubGlobal('fetch', async () => new Response('a 1\n'));
    expect(await downloadReportText('/x')).toBe('a 1\n');
  });
});
