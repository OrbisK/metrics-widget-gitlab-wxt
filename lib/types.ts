/**
 * The GitLab CI artifact `file_type` of a metrics report. It maps onto
 * `artifacts:reports:metrics` in .gitlab-ci.yml and onto `?file_type=` on the
 * artifact download route.
 */
export const METRICS_REPORT_TYPE = 'metrics';

/** A single job artifact that we can download a metrics report from. */
export interface ReportSource {
  jobId: number;
  jobName: string;
  /** Absolute URL of the job, e.g. https://gitlab.example/group/proj/-/jobs/42 */
  jobWebUrl: string;
  /** URL the raw metrics report is downloaded from. */
  downloadUrl: string;
  /**
   * `artifacts_expire_at` for the owning job, when the jobs API reported one.
   * Only used to tell a definitely-expired artifact from one that 404s for some
   * other reason.
   */
  artifactsExpireAt?: string;
}

/**
 * Why an artifact we discovered could not be read.
 *
 * `expired` is the benign case: the job listed the artifact but the file is
 * gone, so there is nothing to show and nothing for the user to fix.
 * `rate-limited` means GitLab refused to serve it for now; it is retried once
 * the limit lifts. `unavailable` is anything else and is worth surfacing as a
 * fault.
 */
export interface ReportError {
  kind: 'expired' | 'rate-limited' | 'unavailable';
  message: string;
}

/** One line of a metrics report. */
export interface Metric {
  /**
   * The metric name including its label set, exactly as written —
   * `http_requests{method="get"}`. Two lines are the same metric only if this
   * matches, which is also how GitLab's own metrics widget keys them.
   */
  name: string;
  /** The value as written. Metrics are not required to be numeric. */
  value: string;
  /** The job whose report it came from. */
  jobName: string;
  jobWebUrl: string;
}

/** Everything one report artifact contributed. */
export interface ParsedReport {
  source: ReportSource;
  metrics: Metric[];
  /** Lines that could not be read as a metric, for diagnostics. */
  skippedLines: number;
  /** Set when the artifact was found but could not be read. */
  error?: ReportError;
}

/**
 * Where a metric stands relative to the target branch.
 *
 * `uncompared` is the honest answer when no base report was read from the job
 * that produced the metric: it may well be new, but nothing could rule that out.
 */
export type MetricStatus = 'changed' | 'new' | 'removed' | 'unchanged' | 'uncompared';

export interface MetricChange {
  name: string;
  status: MetricStatus;
  /** This merge request's value. Absent for `removed`. */
  value?: string;
  /** The target branch's value. Absent for `new` and `uncompared`. */
  previous?: string;
  /** `value - previous`, when both parse as finite numbers. */
  delta?: number;
  /**
   * `delta / |previous|`, when both parse as finite numbers and `previous` is not
   * zero — a relative change from zero is not a number worth printing.
   */
  ratio?: number;
  jobName: string;
  jobWebUrl: string;
}

/**
 * The pipeline the comparison was made against, and how it was chosen — the two
 * strategies support different claims, so the widget names the one it used.
 *
 * `merge-base` is the pipeline for the commit this merge request branched from,
 * which is what GitLab's own comparison uses. `target-branch` is the target
 * branch's latest finished pipeline, used when the merge base has none; it can
 * include commits this merge request never saw.
 */
export interface BasePipeline {
  strategy: 'merge-base' | 'target-branch';
  pipelineId: number;
  pipelineWebUrl?: string;
  targetBranch: string;
  sha?: string;
  /** The commit the comparison was made against, so it can be inspected. */
  commitWebUrl?: string;
}

export interface MetricsComparison {
  changed: MetricChange[];
  added: MetricChange[];
  removed: MetricChange[];
  unchanged: MetricChange[];
  uncompared: MetricChange[];
  /** How many base reports were found, and how many of them could not be read. */
  baseReportCount: number;
  baseUnreadableCount: number;
  /**
   * Base jobs whose metrics were held back from `removed` because this merge
   * request's run of the same job has not finished: a report not uploaded yet is
   * no evidence that a metric is gone.
   */
  pendingJobs: string[];
}

export interface Comparison extends MetricsComparison {
  base: BasePipeline;
}

/**
 * How far a pipeline has got, as far as its reports are concerned. Jobs that
 * have not finished have not uploaded a report yet.
 */
export interface PipelineProgress {
  /**
   * Jobs that have not finished, including manual ones nobody has started —
   * their reports are missing all the same. Trigger jobs are listed here too.
   */
  unfinishedJobs: string[];
  /**
   * The unfinished jobs that wait for someone to start them, such as a manual
   * deploy. They may never run, so they do not make the pipeline running.
   */
  manualJobs: string[];
  /** Every job listed, finished or not. */
  jobNames: string[];
  /**
   * A trigger job has yet to create its downstream pipeline, so that
   * pipeline's jobs are not listed at all — finished or not.
   */
  awaitingDownstream: boolean;
}

/**
 * True while the pipeline is still making progress on its own. Says nothing
 * about which of its jobs produce metrics: a deploy still running counts too.
 */
export function isRunning(progress: PipelineProgress): boolean {
  const manual = new Set(progress.manualJobs);
  return progress.unfinishedJobs.some((name) => !manual.has(name));
}

/**
 * The comparison is fetched after the head metrics are already on screen, so it
 * has its own lifecycle. `off` means the user turned it off; `unavailable`
 * means we could not establish a base and therefore label nothing.
 */
export type ComparisonState =
  | { status: 'off' }
  | { status: 'loading' }
  /** `retry` marks a reason that will pass, such as a rate limit; polling tries again. */
  | { status: 'unavailable'; reason: string; retry?: boolean }
  | { status: 'ready'; comparison: Comparison };

export interface ScanResult {
  reports: ParsedReport[];
  /** Every metric across the head reports, one per name. */
  metrics: Metric[];
  pipelineId: number;
  pipelineWebUrl?: string;
  progress: PipelineProgress;
  comparison: ComparisonState;
}

/** What the injected widget is currently displaying. */
export type WidgetState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; result: ScanResult };
