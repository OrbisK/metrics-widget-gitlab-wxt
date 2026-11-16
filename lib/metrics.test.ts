import { describe, expect, it } from 'vitest';
import {
  compareMetrics,
  formatDelta,
  formatRatio,
  mergeMetrics,
  parseMetrics,
  toNumber,
  toParsedReport,
} from './metrics';
import type { ParsedReport, PipelineProgress, ReportSource } from './types';

function source(jobName: string, jobId = 1): ReportSource {
  const jobWebUrl = `https://gitlab.example/g/p/-/jobs/${jobId}`;
  return {
    jobId,
    jobName,
    jobWebUrl,
    downloadUrl: `${jobWebUrl}/artifacts/download?file_type=metrics`,
  };
}

function report(text: string, jobName = 'metrics', jobId = 1): ParsedReport {
  return toParsedReport(text, source(jobName, jobId));
}

function unreadable(jobName = 'metrics', jobId = 1): ParsedReport {
  return {
    source: source(jobName, jobId),
    metrics: [],
    skippedLines: 0,
    error: { kind: 'expired', message: 'gone' },
  };
}

const finished: PipelineProgress = {
  unfinishedJobs: [],
  manualJobs: [],
  jobNames: ['metrics'],
  awaitingDownstream: false,
};

describe('parseMetrics', () => {
  it('reads the report a plain `echo name value` job writes', () => {
    // What https://gitlab.com/OrbisK/ci-metrics-test writes.
    expect(parseMetrics('bundle_size_kb 412\ntest_count 128\n').metrics).toEqual([
      { name: 'bundle_size_kb', value: '412', jobName: '', jobWebUrl: '' },
      { name: 'test_count', value: '128', jobName: '', jobWebUrl: '' },
    ]);
  });

  it('skips comments, blank lines and timestamps, and keeps values as written', () => {
    const { metrics, skippedLines } = parseMetrics(
      [
        '# HELP coverage Line coverage',
        '# TYPE coverage gauge',
        '',
        'coverage 81.50 1700000000',
        '  memory_mb   1.0e3  ',
        'status passing',
        '# EOF',
      ].join('\r\n'),
    );

    expect(metrics.map(({ name, value }) => [name, value])).toEqual([
      ['coverage', '81.50'],
      ['memory_mb', '1.0e3'],
      ['status', 'passing'],
    ]);
    expect(skippedLines).toBe(0);
  });

  it('keeps label sets as part of the name, spaces and escaped quotes included', () => {
    const { metrics } = parseMetrics(
      [
        'requests{method="get"} 10',
        'requests{method="post", path="/a b"} 3',
        'odd{label="say \\"hi\\" } there"} 1',
      ].join('\n'),
    );

    expect(metrics.map(({ name, value }) => [name, value])).toEqual([
      ['requests{method="get"}', '10'],
      ['requests{method="post", path="/a b"}', '3'],
      ['odd{label="say \\"hi\\" } there"}', '1'],
    ]);
  });

  it('counts lines it cannot read instead of failing', () => {
    const { metrics, skippedLines } = parseMetrics('lonely\nbroken{a="b" 1\nok 1\n');

    expect(metrics.map((metric) => metric.name)).toEqual(['ok']);
    expect(skippedLines).toBe(2);
  });
});

describe('mergeMetrics', () => {
  it('pools every report into one set sorted by name, the later report winning', () => {
    const merged = mergeMetrics([
      report('b 1\nshared 1', 'build', 1),
      report('a 2\nshared 2', 'test', 2),
      unreadable('expired', 3),
    ]);

    expect(merged.map(({ name, value, jobName }) => [name, value, jobName])).toEqual([
      ['a', '2', 'test'],
      ['b', '1', 'build'],
      ['shared', '2', 'test'],
    ]);
  });
});

describe('compareMetrics', () => {
  it('sorts metrics into changed, new, removed and unchanged', () => {
    const result = compareMetrics(
      [report('bundle_size_kb 4122\ntest_count 128\nlint_warnings 3')],
      [report('bundle_size_kb 412\ntest_count 128\ncoverage 80')],
      finished,
    );

    expect(result.changed).toEqual([
      expect.objectContaining({
        name: 'bundle_size_kb',
        status: 'changed',
        value: '4122',
        previous: '412',
        delta: 3710,
        ratio: 9.00485436893,
      }),
    ]);
    expect(result.added.map((m) => m.name)).toEqual(['lint_warnings']);
    expect(result.removed).toEqual([
      expect.objectContaining({ name: 'coverage', previous: '80', value: undefined }),
    ]);
    expect(result.unchanged.map((m) => m.name)).toEqual(['test_count']);
    expect(result.uncompared).toEqual([]);
  });

  it('compares values as written, so a non-numeric change has no delta', () => {
    const result = compareMetrics(
      [report('status failing\nratio 1.0')],
      [report('status passing\nratio 1')],
      finished,
    );

    expect(result.changed.map((m) => [m.name, m.delta])).toEqual([
      ['ratio', 0],
      ['status', undefined],
    ]);
  });

  it('has no relative change from zero', () => {
    const [metric] = compareMetrics([report('errors 4')], [report('errors 0')], finished).changed;

    expect(metric.delta).toBe(4);
    expect(metric.ratio).toBeUndefined();
  });

  it('does not call a metric new when its job’s base report could not be read', () => {
    const result = compareMetrics(
      [report('size 1', 'build', 1), report('tests 5', 'test', 2)],
      [unreadable('build', 3), report('tests 5', 'test', 4)],
      finished,
    );

    expect(result.uncompared.map((m) => m.name)).toEqual(['size']);
    expect(result.added).toEqual([]);
    expect(result.baseReportCount).toBe(2);
    expect(result.baseUnreadableCount).toBe(1);
  });

  it('calls metrics from a job the target branch never had new', () => {
    const result = compareMetrics(
      [report('size 1', 'build', 1), report('tests 5', 'test', 2)],
      [report('tests 5', 'test', 4)],
      finished,
    );

    expect(result.added.map((m) => m.name)).toEqual(['size']);
  });

  it('holds back removals until this merge request’s run of the job has finished', () => {
    const result = compareMetrics(
      [report('tests 5', 'test', 2)],
      [report('size 1', 'build', 3), report('tests 5', 'test', 4)],
      { ...finished, unfinishedJobs: ['build'] },
    );

    expect(result.removed).toEqual([]);
    expect(result.pendingJobs).toEqual(['build']);
  });

  it('holds back removals when this merge request’s report for the job could not be read', () => {
    const result = compareMetrics(
      [unreadable('build', 1)],
      [report('size 1', 'build', 3)],
      finished,
    );

    expect(result.removed).toEqual([]);
  });
});

describe('toNumber', () => {
  it.each([
    ['412', 412],
    ['-1.5', -1.5],
    ['+2', 2],
    ['.5', 0.5],
    ['1e3', 1000],
  ])('reads %s', (value, expected) => {
    expect(toNumber(value)).toBe(expected);
  });

  it.each(['', 'passing', 'NaN', '+Inf', '0x10', '1,000'])('leaves %j alone', (value) => {
    expect(toNumber(value)).toBeUndefined();
  });
});

describe('formatting', () => {
  it('signs deltas', () => {
    expect(formatDelta(3710)).toBe('+3,710');
    expect(formatDelta(-0.25)).toBe('-0.25');
    expect(formatDelta(0)).toBe('±0');
  });

  it('formats ratios as percentages', () => {
    expect(formatRatio(9.00485436893)).toBe('+900.5%');
    expect(formatRatio(-0.5)).toBe('-50%');
    expect(formatRatio(0.0001)).toBe('+<0.1%');
  });
});
