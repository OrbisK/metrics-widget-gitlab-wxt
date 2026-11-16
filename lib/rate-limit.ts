/**
 * Backing off when GitLab says to.
 *
 * gitlab.com answers `429 Too Many Requests` with a `Retry-After` header once a
 * budget is spent, and the budget is usually per IP or per user — shared with
 * every other tab, and with GitLab's own frontend. Retrying on our own schedule
 * would keep spending a budget that is already gone, and could get the user's
 * ordinary GitLab browsing refused for longer. So the first 429 stops every
 * request this content script makes until GitLab's deadline has passed; polling
 * waits for it too.
 *
 * Module state rather than per merge request: the limit is GitLab's, not the
 * page's, and soft navigation to another merge request is the same budget.
 */

/** Used when a 429 carries no usable `Retry-After`, doubled on each repeat. */
const FALLBACK_BACKOFF_MS = 60_000;
/**
 * The longest we wait. gitlab.com's hourly windows can answer with most of an
 * hour, which is worth honouring, but a garbled header should not park the
 * widget for a day.
 */
const MAX_BACKOFF_MS = 60 * 60_000;

let until = 0;
let strikes = 0;

/**
 * `Retry-After` in milliseconds from `now`: either delay-seconds or an HTTP
 * date. Undefined when absent or unreadable.
 */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Records a 429 and returns when requests may resume. */
export function noteRateLimited(retryAfter: string | null, now = Date.now()): number {
  const fallback = FALLBACK_BACKOFF_MS * 2 ** Math.min(strikes, 6);
  const wait = Math.min(MAX_BACKOFF_MS, parseRetryAfter(retryAfter, now) ?? fallback);
  strikes += 1;
  until = Math.max(until, now + wait);
  return until;
}

/** Any answer other than a 429 resets the fallback's doubling. */
export function noteAnswered(): void {
  strikes = 0;
}

/** When requests may resume, while that is still in the future. */
export function rateLimitedUntil(now = Date.now()): number | undefined {
  return until > now ? until : undefined;
}

/** For tests. */
export function resetRateLimit(): void {
  until = 0;
  strikes = 0;
}

/** `14:05`, in the reader's locale. */
export function formatResumeTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
