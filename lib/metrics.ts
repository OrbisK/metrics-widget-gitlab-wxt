import type {
  Metric,
  MetricChange,
  MetricsComparison,
  ParsedReport,
  PipelineProgress,
  ReportSource,
} from './types';

export interface ParsedMetrics {
  metrics: Metric[];
  skippedLines: number;
}

/**
 * Reads a metrics report: the OpenMetrics text format GitLab documents for
 * `artifacts:reports:metrics`, one `name value` pair per line.
 *
 * - `#` lines (`# HELP`, `# TYPE`, `# EOF`) and blank lines are skipped;
 * - a label set is part of the name, so `requests{method="get"}` and
 *   `requests{method="post"}` are two metrics. Label values may hold spaces and
 *   escaped quotes, so the set is scanned rather than split on whitespace;
 * - the value is kept as written. GitLab does not require it to be numeric, and
 *   a widget that turned `1.0` into `1` would be showing something the
 *   pipeline never wrote;
 * - a trailing timestamp is ignored.
 *
 * A line with a name but no value is skipped and counted, rather than failing
 * the report.
 */
export function parseMetrics(text: string): ParsedMetrics {
  const metrics: Metric[] = [];
  let skippedLines = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const parsed = parseLine(line);
    if (!parsed) {
      skippedLines += 1;
      continue;
    }
    metrics.push({ ...parsed, jobName: '', jobWebUrl: '' });
  }

  return { metrics, skippedLines };
}

function parseLine(line: string): { name: string; value: string } | null {
  const nameEnd = metricNameEnd(line);
  if (nameEnd <= 0) return null;

  const name = line.slice(0, nameEnd);
  const [value] = line.slice(nameEnd).trim().split(/\s+/);
  if (!value) return null;

  return { name, value };
}

/** Index just past the metric name and its label set, or -1 if malformed. */
function metricNameEnd(line: string): number {
  const brace = line.search(/[{\s]/);
  if (brace === -1) return -1; // a name with nothing after it
  if (line[brace] !== '{') return brace;

  let quoted = false;
  for (let i = brace + 1; i < line.length; i += 1) {
    const char = line[i];
    if (quoted && char === '\\') {
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === '}' && !quoted) {
      return i + 1;
    }
  }
  return -1; // unterminated label set
}

/** Parses a downloaded report and attributes each metric to its job. */
export function toParsedReport(text: string, source: ReportSource): ParsedReport {
  const { metrics, skippedLines } = parseMetrics(text);
  return {
    source,
    metrics: metrics.map((metric) => ({
      ...metric,
      jobName: source.jobName,
      jobWebUrl: source.jobWebUrl,
    })),
    skippedLines,
  };
}

/**
 * Every metric across several reports, one per name, sorted by name.
 *
 * Several jobs may declare a metrics report, and GitLab's own widget pools them
 * into a single set. A name two jobs both report keeps the value of the later
 * report — the caller passes the reports in a stable order, so which one wins
 * does not change between reloads.
 */
export function mergeMetrics(reports: ParsedReport[]): Metric[] {
  const byName = new Map<string, Metric>();
  for (const report of reports) {
    if (report.error) continue;
    for (const metric of report.metrics) byName.set(metric.name, metric);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** The value as a number, if it is written as a plain finite number. */
export function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!NUMBER.test(trimmed)) return undefined;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : undefined;
}

/** Strips the float noise subtraction leaves behind (`0.30000000000000004`). */
function clean(value: number): number {
  return Number(value.toPrecision(12));
}

function change(
  status: MetricChange['status'],
  head: Metric | undefined,
  base: Metric | undefined,
): MetricChange {
  const owner = (head ?? base)!;
  const result: MetricChange = {
    name: owner.name,
    status,
    value: head?.value,
    previous: base?.value,
    jobName: owner.jobName,
    jobWebUrl: owner.jobWebUrl,
  };

  const now = toNumber(head?.value);
  const before = toNumber(base?.value);
  if (now !== undefined && before !== undefined) {
    result.delta = clean(now - before);
    if (before !== 0) result.ratio = clean((now - before) / Math.abs(before));
  }
  return result;
}

/**
 * Diffs this merge request's metrics against the target branch's.
 *
 * Values are compared as written, the way GitLab's own widget does: `1.0` and
 * `1` differ. That also means a metric whose value is not a number is still
 * reported as changed, only without a delta.
 *
 * Two cases are held back rather than guessed at, both about not overclaiming:
 *
 * - a head metric whose job's base report could not be read is `uncompared`,
 *   not `new` — an expired artifact on the target branch would otherwise make
 *   every metric look newly added;
 * - a base metric missing from the head is only `removed` once this merge
 *   request's run of the same job has finished and its report was readable. A
 *   report not uploaded yet is no evidence the metric is gone.
 */
export function compareMetrics(
  head: ParsedReport[],
  base: ParsedReport[],
  headProgress: PipelineProgress,
): MetricsComparison {
  const headMetrics = new Map(mergeMetrics(head).map((metric) => [metric.name, metric]));
  const baseMetrics = new Map(mergeMetrics(base).map((metric) => [metric.name, metric]));

  const baseUnreadableJobs = new Set(
    base.filter((report) => report.error).map((report) => report.source.jobName),
  );
  const headUnreadableJobs = new Set(
    head.filter((report) => report.error).map((report) => report.source.jobName),
  );
  const unfinished = new Set(headProgress.unfinishedJobs);

  const result: MetricsComparison = {
    changed: [],
    added: [],
    removed: [],
    unchanged: [],
    uncompared: [],
    baseReportCount: base.length,
    baseUnreadableCount: base.filter((report) => report.error).length,
    pendingJobs: [],
  };

  for (const metric of headMetrics.values()) {
    const previous = baseMetrics.get(metric.name);
    if (previous) {
      const same = previous.value === metric.value;
      (same ? result.unchanged : result.changed).push(
        change(same ? 'unchanged' : 'changed', metric, previous),
      );
    } else if (baseUnreadableJobs.has(metric.jobName)) {
      result.uncompared.push(change('uncompared', metric, undefined));
    } else {
      result.added.push(change('new', metric, undefined));
    }
  }

  const pending = new Set<string>();
  for (const metric of baseMetrics.values()) {
    if (headMetrics.has(metric.name)) continue;
    if (unfinished.has(metric.jobName)) {
      pending.add(metric.jobName);
      continue;
    }
    if (headUnreadableJobs.has(metric.jobName)) continue;
    result.removed.push(change('removed', undefined, metric));
  }
  result.pendingJobs = [...pending].sort();

  return result;
}

/** `+3`, `-0.25`, `±0`; with `bytes`, `+12.3 kB`. */
export function formatDelta(delta: number, bytes = false): string {
  if (delta === 0) return '±0';
  const formatted = bytes
    ? formatBytes(Math.abs(delta))
    : Math.abs(delta).toLocaleString('en-US', { maximumFractionDigits: 6 });
  return `${delta > 0 ? '+' : '-'}${formatted}`;
}

/** Upper bounds of the relative change for intensity steps 1 to 3; above is 4. */
const CHANGE_STEPS = [0.01, 0.05, 0.2];

/**
 * How strongly a change is tinted, from 1 (under 1%) to 4 (20% or more), or 0
 * when nothing moved. Says nothing about whether the change is good. A change
 * with no ratio (from zero) gets the faintest step: its direction is known,
 * its size relative to anything is not.
 */
export function changeIntensity(delta: number | undefined, ratio: number | undefined): number {
  if (!delta) return 0;
  if (ratio === undefined) return 1;
  const size = Math.abs(ratio);
  const step = CHANGE_STEPS.findIndex((bound) => size < bound);
  return step === -1 ? CHANGE_STEPS.length + 1 : step + 1;
}

/** `+12.5%`, `-0.3%`; below 0.1% in either direction is `<0.1%` with its sign. */
export function formatRatio(ratio: number): string {
  if (ratio === 0) return '±0%';
  const percent = Math.abs(ratio) * 100;
  const sign = ratio > 0 ? '+' : '-';
  if (percent < 0.1) return `${sign}<0.1%`;
  return `${sign}${percent.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
}

export interface MetricName {
  /** The name without its label set — `http_requests`. */
  family: string;
  /** The label pairs in the order written, values unescaped. */
  labels: Array<[key: string, value: string]>;
}

const LABEL_ESCAPES: Record<string, string> = { n: '\n', '"': '"', '\\': '\\' };

/**
 * Splits `http_requests{method="get",code="200"}` into its family and labels,
 * for display only — the full name stays the key. A label set that does not
 * read cleanly is left in the family rather than half-parsed.
 */
export function splitMetricName(name: string): MetricName {
  const brace = name.indexOf('{');
  if (brace === -1 || !name.endsWith('}')) return { family: name, labels: [] };

  const family = name.slice(0, brace);
  const body = name.slice(brace + 1, -1);
  const labels: MetricName['labels'] = [];
  let i = 0;

  while (i < body.length) {
    while (body[i] === ',' || body[i] === ' ') i += 1;
    if (i >= body.length) break;

    const eq = body.indexOf('=', i);
    if (eq === -1 || body[eq + 1] !== '"') return { family: name, labels: [] };
    const key = body.slice(i, eq).trim();

    let value = '';
    let j = eq + 2;
    for (; j < body.length && body[j] !== '"'; j += 1) {
      if (body[j] === '\\' && j + 1 < body.length) {
        j += 1;
        value += LABEL_ESCAPES[body[j]] ?? `\\${body[j]}`;
      } else {
        value += body[j];
      }
    }
    if (j >= body.length || !key) return { family: name, labels: [] };

    labels.push([key, value]);
    i = j + 1;
  }

  return { family, labels };
}

/**
 * Whether a family's values are byte counts, by the Prometheus convention of
 * naming the unit as the last word (`nuxt_bundle_bytes`).
 */
export function isBytes(family: string): boolean {
  return /(^|_)bytes(_total)?$/.test(family);
}

const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB'];

/**
 * `910599` → `910.6 kB`, in powers of 1000 like browser devtools. Four
 * significant digits, so a change of a few percent still shows on a MB value.
 */
export function formatBytes(bytes: number): string {
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const formatted = value.toLocaleString('en-US', {
    maximumSignificantDigits: Math.max(4, Math.ceil(Math.log10(value + 1))),
  });
  return `${bytes < 0 ? '-' : ''}${formatted} ${BYTE_UNITS[unit]}`;
}

/**
 * A value for display. Values are shown as written, except byte counts, which
 * read far better scaled; the caller keeps the written value at hand.
 */
export function formatValue(value: string, family: string): string {
  if (!isBytes(family)) return value;
  const number = toNumber(value);
  return number === undefined ? value : formatBytes(number);
}
