import {
  discoverReportSources,
  downloadReportText,
  fetchMrDiffRefs,
  fetchMrInfo,
  findBasePipelines,
  HttpError,
  RateLimitedError,
  type BasePipelineCandidate,
  type MrDiffRefs,
  type MrInfo,
} from './gitlab-api';
import { log } from './debug';
import type { MrPageContext } from './gitlab-page';
import { compareMetrics, mergeMetrics, toParsedReport } from './metrics';
import { formatResumeTime, rateLimitedUntil } from './rate-limit';
import type { Settings } from './storage';
import {
  isRunning,
  type ComparisonState,
  type ParsedReport,
  type PipelineProgress,
  type ReportError,
  type ReportSource,
  type ScanResult,
} from './types';

export interface Discovery {
  info: MrInfo;
  sources: ReportSource[];
  progress: PipelineProgress;
}

export type DiscoveryOutcome =
  /** Not an MR we understand, or it has no pipeline — stay invisible. */
  | { status: 'not-applicable'; reason: string }
  /** A pipeline exists but we could not enumerate its artifacts. Worth showing. */
  | { status: 'error'; message: string }
  /** GitLab refused for now. Says nothing about the merge request; ask again later. */
  | { status: 'rate-limited'; until: number }
  | { status: 'found'; discovery: Discovery };

/**
 * Phase one: work out whether this merge request has a metrics report at all.
 *
 * Split from the download step so the widget can appear with a loading state as
 * soon as we know there is something to show, without flashing on merge
 * requests that have no metrics.
 *
 * Failures are classified rather than thrown: a merge request whose widget data
 * we cannot read is almost certainly not our business, whereas a pipeline whose
 * jobs we cannot list points at a real problem (API disabled, missing scope)
 * that the user should see.
 */
export async function discoverReports(
  page: MrPageContext,
  settings: Settings,
): Promise<DiscoveryOutcome> {
  let info: MrInfo;
  try {
    info = await fetchMrInfo(page.pathPrefix, page.iid);
  } catch (error) {
    if (error instanceof RateLimitedError) return { status: 'rate-limited', until: error.until };
    return {
      status: 'not-applicable',
      reason: `could not read the merge request widget data: ${describe(error)}`,
    };
  }

  if (!info.pipelineId) {
    return { status: 'not-applicable', reason: 'this merge request has no head pipeline' };
  }

  try {
    const { sources, progress } = await discoverReportSources(
      info,
      info.pipelineId,
      settings.childPipelineDepth,
    );
    return { status: 'found', discovery: { info, sources, progress } };
  } catch (error) {
    if (error instanceof RateLimitedError) return { status: 'rate-limited', until: error.until };
    return {
      status: 'error',
      message: `Could not list the pipeline's job artifacts: ${describe(error)}`,
    };
  }
}

/**
 * Phase one again, for a merge request already on screen.
 *
 * A finished pipeline's reports cannot change, so all that is worth asking then
 * is whether a push has started a new one — one cheap request rather than
 * listing every job again. A running pipeline is listed in full, since that is
 * the only way to see its jobs finish.
 */
export async function rediscoverReports(
  page: MrPageContext,
  settings: Settings,
  previous: Discovery,
): Promise<DiscoveryOutcome> {
  if (!isRunning(previous.progress)) {
    let info: MrInfo;
    try {
      info = await fetchMrInfo(page.pathPrefix, page.iid);
    } catch (error) {
      if (error instanceof RateLimitedError) return { status: 'rate-limited', until: error.until };
      return { status: 'error', message: describe(error) };
    }
    if (info.pipelineId === previous.info.pipelineId) {
      return { status: 'found', discovery: previous };
    }
  }
  return discoverReports(page, settings);
}

/**
 * Whether a fresh discovery would show anything the current one does not: a
 * new head pipeline, a new report artifact, or a job that has since finished.
 */
export function discoveryChanged(before: Discovery, after: Discovery): boolean {
  return discoverySignature(before) !== discoverySignature(after);
}

function discoverySignature({ info, sources, progress }: Discovery): string {
  return JSON.stringify([
    info.pipelineId,
    sources.map((source) => source.jobId).sort((a, b) => a - b),
    [...progress.unfinishedJobs].sort(),
    progress.awaitingDownstream,
  ]);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Turns a failed artifact download into something worth reading.
 *
 * A 404 here is usually an expired artifact: we only ask for URLs the jobs API
 * just listed, and GitLab erases the file while the job itself stays. The list
 * can also simply be stale, so the wording is hedged unless
 * `artifacts_expire_at` is a date that has actually passed.
 *
 * A 404 for an artifact whose expiry is still ahead is not expiry, though.
 * GitLab answers 404 rather than 403 when the user may see the job but not its
 * artifacts (`artifacts:access`, or a public project restricting artifacts to
 * members), so that case is reported as unavailable rather than waved off.
 */
export function describeDownloadFailure(error: unknown, source: ReportSource, now: Date): ReportError {
  if (error instanceof RateLimitedError) {
    return { kind: 'rate-limited', message: rateLimitMessage(error.until) };
  }
  if (!(error instanceof HttpError) || error.status !== 404) {
    return { kind: 'unavailable', message: describe(error) };
  }

  if (futureExpiry(source.artifactsExpireAt, now)) {
    return {
      kind: 'unavailable',
      message:
        'The report artifact has not expired but could not be downloaded — your account may not have access to job artifacts in this project.',
    };
  }

  const expiredOn = pastExpiry(source.artifactsExpireAt, now);
  return {
    kind: 'expired',
    message: expiredOn
      ? `The report artifact expired on ${expiredOn} and is no longer stored.`
      : 'The report artifact is no longer available — it has most likely expired.',
  };
}

function rateLimitMessage(until: number): string {
  return `GitLab is rate limiting requests from this browser; trying again after ${formatResumeTime(until)}.`;
}

/** A comparison that gave up because of a rate limit, to be retried once it lifts. */
function rateLimitedComparison(): ComparisonState | undefined {
  const until = rateLimitedUntil();
  return until ? { status: 'unavailable', reason: rateLimitMessage(until), retry: true } : undefined;
}

/** True only if `artifacts_expire_at` parses and is still in the future. */
function futureExpiry(value: string | undefined, now: Date): boolean {
  if (!value) return false;
  const at = new Date(value);
  return !Number.isNaN(at.getTime()) && at.getTime() > now.getTime();
}

/** Formats `artifacts_expire_at` only if it parses and is in the past. */
function pastExpiry(value: string | undefined, now: Date): string | null {
  if (!value) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime()) || at.getTime() > now.getTime()) return null;
  return at.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Parsed head reports keyed by job, for one merge request. A job's artifact does
 * not change once uploaded, so a refresh while the pipeline runs only needs to
 * download the reports of jobs that have finished since.
 */
export type ReportCache = Map<number, Promise<ParsedReport>>;

/**
 * Phase two: download and parse each report.
 *
 * A failure to read one report does not fail the scan — that report carries an
 * `error` and the others are still shown.
 */
export async function loadReports(
  { info, sources, progress }: Discovery,
  cache?: ReportCache,
): Promise<ScanResult> {
  const reports = sortReports(await downloadReports(sources, cache));

  return {
    reports,
    metrics: mergeMetrics(reports),
    pipelineId: info.pipelineId!,
    pipelineWebUrl: info.pipelineWebUrl,
    progress,
    // Filled in by phase three, which runs once these are already on screen.
    comparison: { status: 'loading' },
  };
}

/** Downloads and parses each source; a failure becomes that report's `error`. */
async function downloadReports(
  sources: ReportSource[],
  cache?: ReportCache,
): Promise<ParsedReport[]> {
  return Promise.all(
    sources.map((source) => {
      const cached = cache?.get(source.jobId);
      if (cached) return cached;

      const pending = downloadReport(source);
      // A failure may be passing, so only a report that was read is kept.
      void pending.then((report) => {
        if (!report.error) cache?.set(source.jobId, pending);
      });
      return pending;
    }),
  );
}

async function downloadReport(source: ReportSource): Promise<ParsedReport> {
  try {
    const report = toParsedReport(await downloadReportText(source.downloadUrl), source);
    if (report.skippedLines > 0) {
      log(
        `${source.jobName}#${source.jobId}: skipped ${report.skippedLines} line(s) that are not a metric`,
      );
    }
    return report;
  } catch (cause) {
    const failure = describeDownloadFailure(cause, source, new Date());
    log(
      `could not read metrics from job ${source.jobName}#${source.jobId}:`,
      `${failure.kind} —`,
      failure.message,
    );
    return { source, metrics: [], skippedLines: 0, error: failure };
  }
}

/**
 * By job name, so that when two jobs report the same metric the one whose value
 * wins (see `mergeMetrics`) stays the same between reloads.
 */
function sortReports(reports: ParsedReport[]): ParsedReport[] {
  return reports.sort(
    (a, b) => a.source.jobName.localeCompare(b.source.jobName) || a.source.jobId - b.source.jobId,
  );
}

/**
 * Base reports keyed by `projectId:pipelineId:depth`.
 *
 * Every merge request targeting one branch compares against the same pipeline,
 * and soft navigation between merge requests keeps this content script alive, so
 * the second one is free. Reports for a finished pipeline do not change.
 */
const baseReportCache = new Map<string, Promise<ParsedReport[]>>();

/** How many pipelines' base reports stay in memory, per tab. */
const BASE_CACHE_LIMIT = 8;

/**
 * Phase three: compare the head pipeline's metrics with the target branch's.
 *
 * Deliberately fallible and deliberately last. It costs a second pipeline's
 * worth of requests, so it runs after the metrics are on screen; and when no
 * base can be established it returns `unavailable` with a reason rather than
 * labelling anything, because a missing base makes every metric look new.
 */
export async function loadComparison(
  page: MrPageContext,
  info: MrInfo,
  head: ScanResult,
  settings: Settings,
): Promise<ComparisonState> {
  let refs: MrDiffRefs;
  try {
    refs = await fetchMrDiffRefs(info, page.iid);
  } catch (error) {
    const limited = rateLimitedComparison();
    if (limited) return limited;
    return {
      status: 'unavailable',
      reason: `could not read the merge request's target branch: ${describe(error)}`,
    };
  }

  const { candidates, failure } = await findBasePipelines(info, refs, head.pipelineId);

  if (candidates.length === 0) {
    const limited = rateLimitedComparison();
    if (limited) return limited;
    return {
      status: 'unavailable',
      reason: failure
        ? `could not list the pipelines on ${refs.targetBranch}: ${failure}`
        : `${refs.targetBranch} has no finished pipeline to compare against`,
    };
  }

  for (const candidate of candidates.slice(0, settings.maxBasePipelines)) {
    let reports: ParsedReport[];
    try {
      reports = await loadBaseReports(info, candidate, settings);
    } catch (error) {
      log(`base pipeline ${candidate.pipelineId} could not be read:`, describe(error));
      const limited = rateLimitedComparison();
      if (limited) return limited;
      continue;
    }

    // A base read only partly before GitLab started refusing would mark the
    // unread job's metrics as not compared for good; wait and redo it instead.
    if (reports.some((report) => report.error?.kind === 'rate-limited')) {
      return rateLimitedComparison() ?? {
        status: 'unavailable',
        reason: 'GitLab rate limited the target branch reports',
        retry: true,
      };
    }

    // No metrics artifact at all, or none of them readable: this pipeline cannot
    // stand in for the target branch, so try an older one.
    if (reports.length === 0 || reports.every((report) => report.error)) {
      log(`base pipeline ${candidate.pipelineId} has no readable metrics report`);
      continue;
    }

    const comparison = {
      base: {
        ...candidate,
        commitWebUrl: candidate.sha ? `${page.pathPrefix}/-/commit/${candidate.sha}` : undefined,
      },
      ...compareMetrics(head.reports, reports, head.progress),
    };
    log(
      `compared with pipeline ${candidate.pipelineId} (${candidate.strategy})`,
      `${comparison.changed.length} changed, ${comparison.added.length} new,`,
      `${comparison.removed.length} removed, ${comparison.unchanged.length} unchanged,`,
      `${comparison.uncompared.length} not compared`,
      comparison.pendingJobs.length
        ? `(removals not checked for ${comparison.pendingJobs.join(', ')})`
        : '',
    );
    return { status: 'ready', comparison };
  }

  // Every candidate may have failed for the one reason that says nothing about
  // the branch.
  const limited = rateLimitedComparison();
  if (limited) return limited;

  return {
    status: 'unavailable',
    reason:
      candidates.length > settings.maxBasePipelines
        ? `none of the last ${settings.maxBasePipelines} pipelines on ${refs.targetBranch} has a readable metrics report`
        : `no pipeline on ${refs.targetBranch} has a readable metrics report`,
  };
}

/**
 * Forgets every cached base report. Finished pipelines do not change, but a
 * report that could not be read might be readable now, and a refresh the user
 * asked for should not answer from memory.
 */
export function clearBaseReportCache(): void {
  baseReportCache.clear();
}

function loadBaseReports(
  info: MrInfo,
  candidate: BasePipelineCandidate,
  settings: Settings,
): Promise<ParsedReport[]> {
  // The depth is part of the key: raising it is a request to look somewhere the
  // cached entry never looked.
  const key = `${info.projectId}:${candidate.pipelineId}:${settings.childPipelineDepth}`;
  const cached = baseReportCache.get(key);
  if (cached) {
    // Re-inserted so eviction below drops the least recently used.
    baseReportCache.delete(key);
    baseReportCache.set(key, cached);
    return cached;
  }

  const pending = (async () => {
    // Candidates are finished pipelines, so their progress has nothing to add.
    const { sources } = await discoverReportSources(
      info,
      candidate.pipelineId,
      settings.childPipelineDepth,
    );
    if (sources.length === 0) return [];
    return sortReports(await downloadReports(sources));
  })();

  // A rejection is not worth remembering; a reload should be able to retry. Nor
  // is a report GitLab only declined to serve for now.
  pending.then(
    (reports) => {
      if (reports.some((report) => report.error?.kind === 'rate-limited')) {
        baseReportCache.delete(key);
      }
    },
    () => baseReportCache.delete(key),
  );

  if (baseReportCache.size >= BASE_CACHE_LIMIT) {
    baseReportCache.delete(baseReportCache.keys().next().value!);
  }
  baseReportCache.set(key, pending);

  return pending;
}
