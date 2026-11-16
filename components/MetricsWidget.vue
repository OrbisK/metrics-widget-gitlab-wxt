<script setup lang="ts">
import { computed, reactive, ref, shallowRef, useId, useTemplateRef, watch } from 'vue';
import {
  formatDelta,
  formatRatio,
  formatValue,
  isBytes,
  splitMetricName,
  type MetricName,
} from '@/lib/metrics';
import { compileQuery, QUERY_HELP, suggest, type Suggestion } from '@/lib/query';
import { formatResumeTime } from '@/lib/rate-limit';
import type { Settings } from '@/lib/storage';
import {
  isRunning,
  type Comparison,
  type MetricChange,
  type MetricStatus,
  type WidgetState,
} from '@/lib/types';

const props = defineProps<{
  state: WidgetState;
  settings: Settings;
  /** A refresh the user asked for is in flight. */
  refreshing?: boolean;
  /** GitLab answered 429; nothing is requested before this (epoch ms). */
  rateLimitedUntil?: number | null;
  /** Pre-fills the filter box. For tests; the box is never stored. */
  initialQuery?: string;
}>();

const emit = defineEmits<{
  refresh: [];
}>();

const collapsed = ref(props.settings.startCollapsed);
/** Lives only as long as the page: a search is a question, not a preference. */
const query = shallowRef(props.initialQuery ?? '');
const compiledQuery = computed(() => compileQuery(query.value));
/** How many rows each section shows, by section key, beyond the first page. */
const shown = reactive<Record<string, number>>({});

const result = computed(() => (props.state.status === 'ok' ? props.state.result : null));

const comparison = computed<Comparison | null>(() => {
  const value = result.value?.comparison;
  return value?.status === 'ready' ? value.comparison : null;
});

const readableReports = computed(
  () => result.value?.reports.filter((report) => !report.error) ?? [],
);
const unreadableReports = computed(
  () => result.value?.reports.filter((report) => report.error) ?? [],
);
const allFailed = computed(
  () => result.value !== null && readableReports.value.length === 0,
);

const running = computed(() => (result.value ? isRunning(result.value.progress) : false));

const changeCount = computed(() => {
  const value = comparison.value;
  return value ? value.changed.length + value.added.length + value.removed.length : 0;
});

type Icon = 'spinner' | 'warning' | 'changed' | 'unchanged';

const icon = computed<Icon>(() => {
  if (props.state.status === 'loading') return 'spinner';
  if (props.state.status === 'error' || allFailed.value) return 'warning';
  if (comparison.value && changeCount.value === 0) return 'unchanged';
  return 'changed';
});

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

const summary = computed(() => {
  const { state } = props;
  if (state.status === 'loading') return 'Loading the metrics report…';
  if (state.status === 'error') return 'Could not load the metrics report';
  if (allFailed.value) return 'The metrics report could not be read';

  const total = state.result.metrics.length;
  if (total === 0) return 'The metrics report is empty';

  const value = comparison.value;
  if (!value) return `Metrics report: ${plural(total, 'metric')}`;
  if (changeCount.value === 0) return 'Metrics report: no changes';

  const parts = [
    value.changed.length ? `${value.changed.length} changed` : '',
    value.added.length ? `${value.added.length} new` : '',
    value.removed.length ? `${value.removed.length} removed` : '',
  ].filter(Boolean);
  return `Metrics report: ${parts.join(', ')}`;
});

const rateLimitNotice = computed(() =>
  props.rateLimitedUntil
    ? `GitLab is rate limiting requests from this browser; checking again after ${formatResumeTime(props.rateLimitedUntil)}.`
    : undefined,
);

const errorMessage = computed(() => {
  if (props.state.status === 'error') return props.state.message;
  if (!allFailed.value) return undefined;
  const error = unreadableReports.value[0]?.error;
  // The notice below already says it, with a time that stays current.
  if (error?.kind === 'rate-limited' && rateLimitNotice.value) return undefined;
  return error?.message;
});

const STRATEGY_LABELS: Record<Comparison['base']['strategy'], string> = {
  'merge-base': 'merge base',
  'target-branch': 'latest finished pipeline',
};

interface Section {
  key: MetricStatus | 'all';
  title: string;
  rows: MetricChange[];
}

/**
 * Without a comparison every metric is listed as it stands. With one, the
 * metrics are grouped by what happened to them, the changes first.
 */
const sections = computed<Section[]>(() => {
  const value = result.value;
  if (!value) return [];

  const ready = comparison.value;
  if (!ready) {
    return [
      {
        key: 'all',
        title: 'Metrics',
        rows: value.metrics.map((metric) => ({
          name: metric.name,
          status: 'uncompared',
          value: metric.value,
          jobName: metric.jobName,
          jobWebUrl: metric.jobWebUrl,
        })),
      },
    ];
  }

  const list: Section[] = [
    { key: 'changed', title: 'Changed', rows: ready.changed },
    { key: 'new', title: 'New', rows: ready.added },
    { key: 'removed', title: 'Removed', rows: ready.removed },
    { key: 'uncompared', title: 'Not compared', rows: ready.uncompared },
  ];
  if (props.settings.showUnchanged) {
    list.push({ key: 'unchanged', title: 'Unchanged', rows: ready.unchanged });
  }
  return list.filter((section) => section.rows.length > 0);
});

/** Each section filtered and sorted on its own, so the grouping by status stays. */
const filteredSections = computed(() => {
  const compiled = compiledQuery.value;
  return sections.value
    .map((section) => ({
      ...section,
      total: section.rows.length,
      rows: compiled.order(
        compiled.isEmpty ? section.rows : section.rows.filter((row) => compiled.test(row)),
      ),
    }))
    .filter((section) => section.rows.length > 0);
});

const hiddenUnchanged = computed(() =>
  comparison.value && !props.settings.showUnchanged ? comparison.value.unchanged.length : 0,
);

function limit(key: string): number {
  return shown[key] ?? props.settings.metricsPerPage;
}

function showMore(key: string): void {
  shown[key] = limit(key) + props.settings.metricsPerPage;
}

type Row = MetricChange & MetricName;

/**
 * A run of rows from one metric family. A family listed under several label
 * sets gets its name once, as a heading, and each row only its labels.
 */
interface RowGroup {
  family: string;
  /** Show the family as a heading over the rows rather than in each row. */
  headed: boolean;
  rows: Row[];
}

function groupRows(rows: MetricChange[]): RowGroup[] {
  const groups: RowGroup[] = [];
  for (const row of rows) {
    const split = splitMetricName(row.name);
    const last = groups.at(-1);
    if (split.labels.length > 0 && last?.family === split.family && last.rows[0].labels.length > 0) {
      last.rows.push({ ...row, ...split });
      last.headed = true;
    } else {
      groups.push({ family: split.family, headed: false, rows: [{ ...row, ...split }] });
    }
  }
  return groups;
}

function display(value: string | undefined, row: Row): string {
  return value === undefined ? '' : formatValue(value, row.family);
}

/** The value as written, when the display scaled it. */
function written(value: string | undefined, row: Row): string | undefined {
  return value !== undefined && display(value, row) !== value ? value : undefined;
}

function deltaLabel(row: Row): string | undefined {
  if (row.delta === undefined) return undefined;
  const delta = formatDelta(row.delta, isBytes(row.family));
  return row.ratio === undefined ? delta : `${delta} (${formatRatio(row.ratio)})`;
}

function deltaClass(row: Row): string {
  if (!row.delta) return 'glmw-delta-flat';
  return row.delta > 0 ? 'glmw-delta-up' : 'glmw-delta-down';
}

const searchInput = useTemplateRef<HTMLInputElement>('searchInput');
const suggestionsId = useId();
/** Where the cursor is, which decides which term is being completed. */
const cursor = shallowRef(0);
/** Closed by Esc or blur, reopened by typing. */
const suggesting = shallowRef(false);
const activeSuggestion = shallowRef(0);

const suggestions = computed(() =>
  suggesting.value ? suggest(query.value, cursor.value) : { from: 0, items: [] },
);

watch(suggestions, () => {
  activeSuggestion.value = 0;
});

function syncCursor(): void {
  cursor.value = searchInput.value?.selectionStart ?? query.value.length;
}

function onSearchInput(): void {
  syncCursor();
  suggesting.value = true;
}

/**
 * Edits the input in place, which also leaves the cursor after the insertion,
 * and then takes the model from it — so Vue finds nothing to write back and
 * the cursor stays put.
 */
function pickSuggestion(item: Suggestion): void {
  const input = searchInput.value;
  if (!input) return;
  input.setRangeText(item.insert, suggestions.value.from, cursor.value, 'end');
  query.value = input.value;
  syncCursor();
}

function onKeydown(event: KeyboardEvent): void {
  const { items } = suggestions.value;
  if (event.key === 'Escape') {
    // First Esc closes the suggestions, the next one clears the search.
    if (items.length) suggesting.value = false;
    else query.value = '';
    return;
  }
  if (!items.length) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    activeSuggestion.value = (activeSuggestion.value + step + items.length) % items.length;
  } else if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault();
    pickSuggestion(items[activeSuggestion.value]);
  }
}
</script>

<template>
  <section
    class="glmw"
    :class="{ 'glmw-tone-warning': icon === 'warning' }"
    aria-label="Metrics report"
  >
    <div class="glmw-head">
      <span class="glmw-status" aria-hidden="true">
        <svg v-if="icon === 'spinner'" class="glmw-spin" viewBox="0 0 16 16" width="16" height="16">
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="2" />
          <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
        <svg v-else-if="icon === 'warning'" viewBox="0 0 16 16" width="16" height="16">
          <path
            fill="currentColor"
            d="M8.9 1.5a1 1 0 0 0-1.8 0L.6 13.5A1 1 0 0 0 1.5 15h13a1 1 0 0 0 .9-1.5L8.9 1.5ZM8 5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 5Zm0 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"
          />
        </svg>
        <svg v-else-if="icon === 'unchanged'" viewBox="0 0 16 16" width="16" height="16">
          <path fill="currentColor" d="M2 6.25h12v1.5H2zm0 3h12v1.5H2z" />
        </svg>
        <svg v-else viewBox="0 0 16 16" width="16" height="16">
          <path
            fill="currentColor"
            d="M1.75 1a.75.75 0 0 1 .75.75v11.75h11.75a.75.75 0 0 1 0 1.5H1.75a.75.75 0 0 1-.75-.75V1.75A.75.75 0 0 1 1.75 1Zm12.03 3.22a.75.75 0 0 1 0 1.06l-4 4a.75.75 0 0 1-1.06 0L6.5 7.06 4.53 9.03a.75.75 0 0 1-1.06-1.06l2.5-2.5a.75.75 0 0 1 1.06 0L9.25 7.69l3.47-3.47a.75.75 0 0 1 1.06 0Z"
          />
        </svg>
      </span>

      <div class="glmw-head-body">
        <p class="glmw-summary">{{ summary }}</p>

        <p v-if="errorMessage" class="glmw-sub glmw-danger-text">{{ errorMessage }}</p>

        <p v-if="rateLimitNotice" class="glmw-sub glmw-warning-text" role="status">
          {{ rateLimitNotice }}
        </p>

        <p v-if="result" class="glmw-sub">
          <template v-if="result.pipelineWebUrl">
            <a class="glmw-link" :href="result.pipelineWebUrl">Pipeline #{{ result.pipelineId }}</a>
          </template>
          <template v-else>Pipeline #{{ result.pipelineId }}</template>
          <template v-if="running"> · still running, more metrics may follow</template>
          <template v-if="unreadableReports.length > 0 && !allFailed">
            · {{ plural(unreadableReports.length, 'report') }} could not be read
          </template>
        </p>

        <p v-if="result && !allFailed" class="glmw-sub">
          <template v-if="result.comparison.status === 'loading'">
            Comparing with the target branch…
          </template>
          <template
            v-else-if="result.comparison.status === 'unavailable' && result.comparison.retry && rateLimitNotice"
          >
            Not compared with the target branch yet — waiting for the rate limit to lift.
          </template>
          <template v-else-if="result.comparison.status === 'unavailable'">
            Not compared with the target branch: {{ result.comparison.reason }}
          </template>
          <template v-else-if="comparison">
            Compared with
            <a
              v-if="comparison.base.pipelineWebUrl"
              class="glmw-link"
              :href="comparison.base.pipelineWebUrl"
              >pipeline #{{ comparison.base.pipelineId }}</a
            ><template v-else>pipeline #{{ comparison.base.pipelineId }}</template>
            on <span class="glmw-mono">{{ comparison.base.targetBranch }}</span>
            ({{ STRATEGY_LABELS[comparison.base.strategy] }}<template v-if="comparison.base.sha"
              >,
              <a
                v-if="comparison.base.commitWebUrl"
                class="glmw-link glmw-mono"
                :href="comparison.base.commitWebUrl"
                >{{ comparison.base.sha.slice(0, 8) }}</a
              ><span v-else class="glmw-mono">{{ comparison.base.sha.slice(0, 8) }}</span></template
            >)
            <template v-if="comparison.unchanged.length > 0">
              · {{ comparison.unchanged.length }} unchanged
            </template>
            <template v-if="comparison.uncompared.length > 0">
              · {{ comparison.uncompared.length }} not compared
            </template>
            <template v-if="comparison.pendingJobs.length > 0">
              · removals not checked until {{ comparison.pendingJobs.join(', ') }} finishes
            </template>
            <template v-if="comparison.baseUnreadableCount > 0">
              · {{ comparison.baseUnreadableCount }} of {{ comparison.baseReportCount }} target
              branch reports could not be read
            </template>
          </template>
        </p>
      </div>

      <div v-if="state.status !== 'loading'" class="glmw-actions">
        <button
          type="button"
          class="glmw-toggle glmw-refresh"
          :disabled="refreshing || Boolean(rateLimitNotice)"
          :title="rateLimitNotice ?? (refreshing ? 'Refreshing…' : 'Refresh')"
          :aria-label="refreshing ? 'Refreshing' : 'Refresh'"
          @click="emit('refresh')"
        >
          <svg
            :class="{ 'glmw-spin': refreshing }"
            viewBox="0 0 16 16"
            width="14"
            height="14"
            aria-hidden="true"
          >
            <path
              fill="currentColor"
              d="M8 2.5a5.5 5.5 0 1 0 5.38 6.64.75.75 0 1 1 1.47.31A7 7 0 1 1 12.95 3.05V1.75a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-.75.75h-3.5a.75.75 0 0 1 0-1.5h1.67A5.48 5.48 0 0 0 8 2.5Z"
            />
          </svg>
        </button>
        <button
          v-if="result && result.metrics.length + (comparison?.removed.length ?? 0) > 0"
          type="button"
          class="glmw-toggle"
          :aria-expanded="!collapsed"
          @click="collapsed = !collapsed"
        >
          {{ collapsed ? 'Expand' : 'Collapse' }}
        </button>
      </div>
    </div>

    <div v-if="result && !collapsed && sections.length + hiddenUnchanged > 0" class="glmw-body">
      <div v-if="settings.showFilter" class="glmw-filter">
        <input
          ref="searchInput"
          v-model="query"
          class="glmw-input"
          type="search"
          role="combobox"
          placeholder="Filter or sort, e.g. is:changed sort:abs-change"
          aria-label="Filter and sort metrics"
          aria-autocomplete="list"
          :aria-expanded="suggestions.items.length > 0"
          :aria-controls="suggestionsId"
          :aria-activedescendant="
            suggestions.items.length ? `${suggestionsId}-${activeSuggestion}` : undefined
          "
          :title="QUERY_HELP"
          spellcheck="false"
          autocomplete="off"
          @input="onSearchInput"
          @click="syncCursor"
          @keyup.left.right.home.end="syncCursor"
          @keydown="onKeydown"
          @blur="suggesting = false"
        />
        <!-- In the flow rather than floating: the widget clips overflow, and a
             dropdown would be cut off when the list below it is short. -->
        <ul
          v-show="suggestions.items.length"
          :id="suggestionsId"
          class="glmw-suggestions"
          role="listbox"
          aria-label="Suggestions"
        >
          <li
            v-for="(item, index) in suggestions.items"
            :id="`${suggestionsId}-${index}`"
            :key="item.label"
            class="glmw-suggestion"
            :class="{ 'glmw-suggestion-active': index === activeSuggestion }"
            role="option"
            :aria-selected="index === activeSuggestion"
            @mousedown.prevent="pickSuggestion(item)"
          >
            {{ item.label }}
          </li>
          <li class="glmw-muted glmw-suggestions-hint" aria-hidden="true">Tab to complete</li>
        </ul>

        <p v-for="error in compiledQuery.errors" :key="error.term" class="glmw-sub glmw-danger-text">
          Ignoring <span class="glmw-mono">{{ error.term }}</span>: {{ error.message }}
        </p>
      </div>

      <div v-for="section in filteredSections" :key="section.key" class="glmw-section">
        <h3 class="glmw-section-title">
          {{ section.title }}
          <span class="glmw-muted">
            {{ section.rows.length === section.total ? section.total : `${section.rows.length} of ${section.total}` }}
          </span>
        </h3>

        <table class="glmw-table">
          <thead class="glmw-sr-only">
            <tr>
              <th scope="col">Metric</th>
              <th scope="col">Value</th>
              <th scope="col">Change</th>
            </tr>
          </thead>
          <tbody
            v-for="(group, index) in groupRows(section.rows.slice(0, limit(section.key)))"
            :key="`${index}:${group.rows[0].name}`"
            :class="{ 'glmw-group': group.headed }"
          >
            <tr v-if="group.headed" class="glmw-family-row">
              <th scope="colgroup" colspan="3" class="glmw-family glmw-mono">{{ group.family }}</th>
            </tr>
            <tr
              v-for="row in group.rows"
              :key="row.name"
              :class="`glmw-row-${row.status}`"
            >
              <th
                scope="row"
                class="glmw-name glmw-mono"
                :title="`${row.name}\nFrom job ${row.jobName}`"
              >
                <span v-if="group.headed" class="glmw-sr-only">{{ group.family }}</span>
                <span v-else class="glmw-family">{{ row.family }}</span>
                <span v-if="row.labels.length" class="glmw-labels">
                  <span v-for="[key, value] in row.labels" :key="key" class="glmw-label"
                    ><span class="glmw-label-key">{{ key }}=</span>{{ value }}</span
                  >
                </span>
              </th>
              <td class="glmw-value glmw-mono">
                <template v-if="row.status === 'changed'">
                  <span class="glmw-previous" :title="written(row.previous, row)">{{
                    display(row.previous, row)
                  }}</span>
                  <span class="glmw-arrow" aria-label="changed to"> → </span>
                  <strong :title="written(row.value, row)">{{ display(row.value, row) }}</strong>
                </template>
                <template v-else-if="row.status === 'removed'">
                  <del class="glmw-previous" :title="written(row.previous, row)">{{
                    display(row.previous, row)
                  }}</del>
                </template>
                <span v-else :title="written(row.value, row)">{{ display(row.value, row) }}</span>
              </td>
              <td class="glmw-change">
                <span v-if="row.status === 'changed' && deltaLabel(row)" :class="deltaClass(row)">
                  {{ deltaLabel(row) }}
                </span>
                <span v-else-if="row.status === 'new'" class="glmw-badge">New</span>
                <span v-else-if="row.status === 'removed'" class="glmw-badge glmw-badge-muted">
                  Removed
                </span>
              </td>
            </tr>
          </tbody>
        </table>

        <button
          v-if="section.rows.length > limit(section.key)"
          type="button"
          class="glmw-more"
          @click="showMore(section.key)"
        >
          Show more ({{ section.rows.length - limit(section.key) }} left)
        </button>
      </div>

      <p v-if="!compiledQuery.isEmpty && filteredSections.length === 0" class="glmw-empty glmw-muted">
        No metric matches “{{ query.trim() }}”.
      </p>

      <p v-if="hiddenUnchanged > 0" class="glmw-empty glmw-muted">
        {{ plural(hiddenUnchanged, 'unchanged metric') }} not listed — turn on
        <em>Show unchanged metrics</em> in the extension settings to see them.
      </p>
    </div>
  </section>
</template>
