import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import MetricsWidget from './MetricsWidget.vue';
import { compareMetrics, mergeMetrics, toParsedReport } from '@/lib/metrics';
import { DEFAULT_SETTINGS, type Settings } from '@/lib/storage';
import type {
  BasePipeline,
  ComparisonState,
  ParsedReport,
  PipelineProgress,
  ScanResult,
  WidgetState,
} from '@/lib/types';

function report(text: string, jobName = 'metrics', jobId = 7): ParsedReport {
  const jobWebUrl = `https://gitlab.example/g/p/-/jobs/${jobId}`;
  return toParsedReport(text, {
    jobId,
    jobName,
    jobWebUrl,
    downloadUrl: `${jobWebUrl}/artifacts/download?file_type=metrics`,
  });
}

const base: BasePipeline = {
  strategy: 'merge-base',
  pipelineId: 55,
  pipelineWebUrl: 'https://gitlab.example/g/p/-/pipelines/55',
  targetBranch: 'main',
  sha: 'abcdef1234567890',
  commitWebUrl: 'https://gitlab.example/g/p/-/commit/abcdef1234567890',
};

const finished: PipelineProgress = {
  unfinishedJobs: [],
  manualJobs: [],
  jobNames: ['metrics'],
  awaitingDownstream: false,
};

function renderState(
  state: WidgetState,
  settings: Partial<Settings> = {},
  query?: string,
  rateLimitedUntil?: number,
) {
  return renderToString(
    createSSRApp(() =>
      h(MetricsWidget, {
        state,
        settings: { ...DEFAULT_SETTINGS, startCollapsed: false, ...settings },
        initialQuery: query,
        rateLimitedUntil,
      }),
    ),
  );
}

async function render(
  head: ParsedReport[],
  options: {
    base?: ParsedReport[];
    comparison?: ComparisonState;
    progress?: PipelineProgress;
    settings?: Partial<Settings>;
    query?: string;
  } = {},
): Promise<string> {
  const progress = options.progress ?? finished;
  const comparison: ComparisonState = options.base
    ? { status: 'ready', comparison: { base, ...compareMetrics(head, options.base, progress) } }
    : (options.comparison ?? { status: 'off' });

  const result: ScanResult = {
    reports: head,
    metrics: mergeMetrics(head),
    pipelineId: 99,
    pipelineWebUrl: 'https://gitlab.example/g/p/-/pipelines/99',
    progress,
    comparison,
  };

  return renderState({ status: 'ok', result }, options.settings, options.query);
}

/** Text content without tags or the comment markers SSR leaves behind. */
function text(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('MetricsWidget', () => {
  it('summarises the changes against the target branch', async () => {
    // The shape of https://gitlab.com/OrbisK/ci-metrics-test/-/merge_requests/1.
    const html = await render([report('bundle_size_kb 4122\ntest_count 128\nlint 2')], {
      base: [report('bundle_size_kb 412\ntest_count 128\ncoverage 80', 'metrics', 6)],
    });
    const content = text(html);

    expect(content).toContain('Metrics report: 1 changed, 1 new, 1 removed');
    expect(content).toMatch(/Compared with pipeline #55 on main \(merge base, abcdef12 ?\)/);
    expect(content).toContain('412 → 4122');
    expect(content).toContain('+3,710 (+900.5%)');
    expect(content).toContain('1 unchanged');
    // Unchanged metrics are counted, not listed, by default.
    expect(content).not.toMatch(/test_count/);
  });

  it('shows the largest relative change in the head, collapsed or not', async () => {
    const head = [report('a 110\nb 50\nc 300\nd 5')];
    const baseReports = [report('a 100\nb 100\nc 200\nd 0', 'metrics', 6)];
    for (const startCollapsed of [true, false]) {
      const html = await render(head, { base: baseReports, settings: { startCollapsed } });
      // b fell by half, more than c rose; d grew from zero and has no ratio.
      expect(text(html)).toContain('Metrics report: 4 changed max -50%');
      expect(html).toContain('title="Largest change: b');
    }
  });

  it('lists unchanged metrics when asked to', async () => {
    const html = await render([report('test_count 128')], {
      base: [report('test_count 128', 'metrics', 6)],
      settings: { showUnchanged: true },
    });

    expect(text(html)).toContain('Metrics report: no changes');
    expect(text(html)).toContain('test_count');
  });

  it('lists every metric as it stands without a comparison', async () => {
    const html = await render([report('a 1\nb 2')], {
      comparison: { status: 'unavailable', reason: 'main has no finished pipeline to compare against' },
    });
    const content = text(html);

    expect(content).toContain('Metrics report: 2 metrics');
    expect(content).toContain('Not compared with the target branch: main has no finished pipeline');
    expect(content).toMatch(/a 1 .*b 2/);
  });

  it('narrows the list by name without changing the summary', async () => {
    const html = await render([report('bundle_size 2\ntest_count 2')], {
      base: [report('bundle_size 1\ntest_count 1', 'metrics', 6)],
      query: 'bundle',
    });
    const content = text(html);

    expect(content).toContain('Metrics report: 2 changed');
    expect(content).toContain('bundle_size');
    expect(content).not.toContain('test_count');
  });

  it('sorts each section by what the query asks for', async () => {
    const html = await render([report('a 110\nb 300\nc 50\nd 1')], {
      base: [report('a 100\nb 100\nc 100', 'metrics', 6)],
      query: 'sort:abs-change',
    });
    const content = text(html);

    expect(content).toMatch(/b 100 → 300 .*c 100 → 50 .*a 100 → 110 .*New 1 .*d 1/);
  });

  it('says which terms of the query it ignored', async () => {
    const html = await render([report('a 1')], { query: 'sort:size a' });

    expect(text(html)).toMatch(/Ignoring sort:size ?: unknown sort &quot;size&quot;/);
  });

  it('says when a running job’s removals have not been checked', async () => {
    const html = await render([report('a 1', 'test', 1)], {
      base: [report('a 1', 'test', 2), report('size 3', 'build', 3)],
      progress: { ...finished, unfinishedJobs: ['build'] },
    });
    const content = text(html);

    expect(content).not.toContain('removed');
    expect(content).toContain('removals not checked until build finishes');
    expect(content).toContain('still running');
  });

  it('shows the reason when the only report could not be read', async () => {
    const failed: ParsedReport = {
      ...report(''),
      error: { kind: 'expired', message: 'The report artifact expired on Jan 1, 2026.' },
    };
    const content = text(await render([failed]));

    expect(content).toContain('The metrics report could not be read');
    expect(content).toContain('expired on Jan 1, 2026');
  });

  it('says when GitLab is rate limiting, once, and holds off the refresh button', async () => {
    const failed: ParsedReport = {
      ...report(''),
      error: { kind: 'rate-limited', message: 'GitLab is rate limiting requests from this browser.' },
    };
    const result: ScanResult = {
      reports: [failed],
      metrics: [],
      pipelineId: 99,
      progress: finished,
      comparison: { status: 'unavailable', reason: 'rate limited', retry: true },
    };
    const html = await renderState({ status: 'ok', result }, {}, undefined, Date.now() + 60_000);
    const content = text(html);

    expect(content.match(/rate limiting/g)).toHaveLength(1);
    expect(content).toMatch(/checking again after \S+/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*glmw-refresh|glmw-refresh[^>]*disabled/);
  });

  it('names a labelled family once and lists each label set under it', async () => {
    const html = await render([
      report(
        [
          'nuxt_bundle_bytes{bundle="client",compression="brotli"} 910599',
          'nuxt_bundle_bytes{bundle="server",compression="brotli"} 107016',
          'requests{method="get"} 3',
        ].join('\n'),
      ),
    ]);
    const content = text(html);

    expect(html.match(/glmw-family-row/g)).toHaveLength(1);
    expect(content).toMatch(/nuxt_bundle_bytes .*bundle= client compression= brotli 910\.6 kB/);
    expect(html).toContain('title="910599"');
    // A family with one label set keeps its name on the row.
    expect(content).toMatch(/requests method= get 3/);
  });

  it('renders the loading and error states', async () => {
    expect(text(await renderState({ status: 'loading' }))).toContain('Loading the metrics report');
    expect(text(await renderState({ status: 'error', message: 'HTTP 403' }))).toContain('HTTP 403');
  });
});
