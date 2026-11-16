import { storage } from 'wxt/utils/storage';

/**
 * Extra GitLab origins the user has added (e.g. "https://gitlab.example.com").
 * gitlab.com is always enabled and is not stored here.
 */
export const instanceOrigins = storage.defineItem<string[]>('sync:instanceOrigins', {
  fallback: [],
});

export interface Settings {
  /** Start the widget collapsed rather than expanded. */
  startCollapsed: boolean;
  /**
   * Compare the head pipeline's metrics against the target branch's, so changed,
   * new and removed metrics can be told apart. Costs a second pipeline's worth of
   * requests, after the metrics are already on screen.
   */
  compareWithTargetBranch: boolean;
  /** List metrics whose value did not change, below the ones that did. */
  showUnchanged: boolean;
  /**
   * Log each step to the page console. Always on in dev builds; this only
   * affects production builds.
   */
  verboseLogging: boolean;
  /** How many metrics a section lists before "show more". */
  metricsPerPage: number;
  /** Show a filter and sort box above the metrics. What is typed into it is not stored. */
  showFilter: boolean;
  /**
   * How many base pipeline candidates the comparison tries before giving up.
   * Each attempt costs a jobs listing plus a download per report it finds.
   */
  maxBasePipelines: number;
  /**
   * How many levels of child (downstream) pipelines to follow when looking for
   * report artifacts. Zero stays within the pipeline itself; each level costs a
   * bridges listing plus a jobs listing per child pipeline found.
   */
  childPipelineDepth: number;
  /**
   * Keep an open merge request's widget current: pick up metrics jobs as they
   * finish and a new pipeline after a push, without reloading the page.
   */
  autoRefresh: boolean;
  /**
   * How often a running pipeline is checked, in seconds. A finished one is
   * checked half as often, since only a push can change it then.
   */
  refreshIntervalSeconds: number;
}

export const DEFAULT_SETTINGS: Settings = {
  startCollapsed: true,
  compareWithTargetBranch: true,
  showUnchanged: false,
  verboseLogging: false,
  metricsPerPage: 20,
  showFilter: true,
  maxBasePipelines: 3,
  childPipelineDepth: 1,
  autoRefresh: true,
  refreshIntervalSeconds: 30,
};

/**
 * What each numeric setting is allowed to be, enforced on every read rather
 * than only where it is written. The stored value can come from an older
 * version, from another device via sync, or from a hand-edited storage entry.
 */
export const SETTING_LIMITS = {
  metricsPerPage: { min: 5, max: 500 },
  /**
   * The cap is `PIPELINE_LOOKUP_PAGE_SIZE` in lib/gitlab-api.ts: asking to try
   * more pipelines than a lookup returns would not reach any further back.
   */
  maxBasePipelines: { min: 1, max: 10 },
  childPipelineDepth: { min: 0, max: 3 },
  /** Each check is at least one request per open merge request tab. */
  refreshIntervalSeconds: { min: 10, max: 600 },
} as const satisfies Record<string, { min: number; max: number }>;

export type NumericSetting = keyof typeof SETTING_LIMITS;

export const settings = storage.defineItem<Settings>('sync:settings', {
  fallback: DEFAULT_SETTINGS,
});

/**
 * A `fallback` only covers the case where nothing is stored at all, so a key
 * added in a later version reads back as `undefined` for everyone who already
 * has settings. Every read goes through here, which is also where the numeric
 * settings are brought back inside their limits.
 */
export function withDefaults(value: Partial<Settings> | null | undefined): Settings {
  const merged = { ...DEFAULT_SETTINGS, ...(value ?? {}) };
  return {
    ...merged,
    metricsPerPage: clampSetting(merged.metricsPerPage, 'metricsPerPage'),
    maxBasePipelines: clampSetting(merged.maxBasePipelines, 'maxBasePipelines'),
    childPipelineDepth: clampSetting(merged.childPipelineDepth, 'childPipelineDepth'),
    refreshIntervalSeconds: clampSetting(merged.refreshIntervalSeconds, 'refreshIntervalSeconds'),
  };
}

/**
 * Brings one numeric setting inside its limits, falling back to the default for
 * anything that is not a number at all — which is what an emptied number input
 * hands over.
 */
export function clampSetting(value: unknown, setting: NumericSetting): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SETTINGS[setting];
  const { min, max } = SETTING_LIMITS[setting];
  return Math.min(max, Math.max(min, Math.round(value)));
}

export async function getSettings(): Promise<Settings> {
  return withDefaults(await settings.getValue());
}

/** Normalizes user input like "gitlab.example.com/" into an origin. */
export function toOrigin(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Match pattern covering a whole origin, for permissions and script registration. */
export function originToMatchPattern(origin: string): string {
  return `${origin}/*`;
}

export const GITLAB_COM_ORIGIN = 'https://gitlab.com';

export async function addOrigin(origin: string): Promise<string[]> {
  const current = await instanceOrigins.getValue();
  if (current.includes(origin) || origin === GITLAB_COM_ORIGIN) return current;

  const next = [...current, origin].sort();
  await instanceOrigins.setValue(next);
  return next;
}

export async function removeOrigin(origin: string): Promise<string[]> {
  const current = await instanceOrigins.getValue();
  const next = current.filter((o) => o !== origin);
  await instanceOrigins.setValue(next);
  return next;
}
