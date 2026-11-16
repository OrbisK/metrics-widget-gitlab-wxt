import { toNumber } from './metrics';
import type { MetricChange, MetricStatus } from './types';

/**
 * A small query language for the widget's filter box, e.g.
 *
 *   is:changed bundle -job:lint sort:abs-change
 *
 * - Whitespace separates terms, and every filter term has to match (AND).
 * - The same key given more than once, or a comma list (`is:changed,new`),
 *   matches any of its values (OR).
 * - `-key:value` and `key:!value` both negate a filter term.
 * - A bare word is a case-insensitive search over the metric's full name,
 *   labels included.
 * - Double quotes keep spaces in a value: `"total time"`. They are not part of
 *   the value, so labels are matched without theirs: `method=get`.
 * - Values containing `*` or `?` are globs matched against the whole field;
 *   anything else is a substring.
 * - `change:>2%` and `delta:>=1000` compare the relative change (in percent)
 *   or the absolute delta with `>`, `>=`, `<`, `<=` or `=`. An unsigned number
 *   compares the size of the change either way; a signed one (`>+2%`, `<-2%`)
 *   compares the change itself. Rows without that number — new, removed and
 *   non-numeric metrics, or a ratio from zero — are let through, so a threshold
 *   hides noise without hiding them. Unlike other keys, repeated comparison
 *   terms all have to hold (`change:>1% change:<50%` is a range); commas still
 *   mean any of.
 * - `sort:field` orders the rows within each section, `-asc` or `-desc` on the
 *   field picks the direction. Several sort fields break ties in the order
 *   given. Rows without a value for the field (no number to compare) go last
 *   whichever the direction.
 *
 * Parsing never throws: a term it cannot make sense of is reported in `errors`
 * and skipped, so a half-typed query never empties the list.
 */

export interface QueryError {
  term: string;
  message: string;
}

export type SortField =
  | 'name'
  | 'change'
  | 'abs-change'
  | 'delta'
  | 'abs-delta'
  | 'value'
  | 'previous';

export interface SortKey {
  field: SortField;
  direction: 'asc' | 'desc';
}

export interface CompiledQuery {
  /** True when there is nothing to filter by, so every metric matches. */
  isEmpty: boolean;
  /** The order asked for with `sort:`; empty keeps the report's order. */
  sort: SortKey[];
  errors: QueryError[];
  test(row: MetricChange): boolean;
  /** The rows in the order asked for, as a new array. Stable. */
  order(rows: readonly MetricChange[]): MetricChange[];
}

type Matcher = (row: MetricChange) => boolean;

/** Key aliases, mapped onto the field they filter. */
const FIELDS = {
  name: 'name',
  metric: 'name',
  job: 'job',
  is: 'is',
  status: 'is',
  change: 'change',
  percent: 'change',
  delta: 'delta',
  diff: 'delta',
  sort: 'sort',
} as const;

type Field = (typeof FIELDS)[keyof typeof FIELDS];

const IS_VALUES = ['changed', 'new', 'removed', 'unchanged', 'uncompared'] as const satisfies
  readonly MetricStatus[];

/** Sort aliases, mapped onto the field they sort by. */
const SORT_FIELDS: Record<string, SortField> = {
  name: 'name',
  change: 'change',
  percent: 'change',
  ratio: 'change',
  'abs-change': 'abs-change',
  delta: 'delta',
  diff: 'delta',
  'abs-delta': 'abs-delta',
  value: 'value',
  new: 'value',
  previous: 'previous',
  old: 'previous',
};

/** The sort fields offered while typing; the aliases still work. */
const SUGGESTED_SORTS: readonly SortField[] = [
  'change',
  'abs-change',
  'delta',
  'abs-delta',
  'value',
  'previous',
  'name',
];

export const QUERY_HELP =
  'Filter and sort metrics, e.g. is:changed bundle -job:lint sort:abs-change\n' +
  'Keys: name, job, is:changed|new|removed|unchanged|uncompared, change, delta, sort\n' +
  'change:>2% and delta:>1000 hide smaller changes (either way; >+2% or <-2% for one way); ' +
  'new, removed and non-numeric metrics stay\n' +
  'sort: change (%), abs-change, delta, abs-delta, value, previous (old), name; add -asc or -desc\n' +
  'Prefix a term with - or its value with ! to exclude; commas mean "any of"; * and ? are wildcards.';

interface Token {
  text: string;
  /** Whether a quote opened the token, which keeps `"a:b"` a plain search. */
  quotedStart: boolean;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let text = '';
  let inToken = false;
  let quotedStart = false;
  let inQuotes = false;

  for (const char of input) {
    if (char === '"') {
      if (!inToken) quotedStart = true;
      inToken = true;
      inQuotes = !inQuotes;
    } else if (/\s/.test(char) && !inQuotes) {
      if (inToken) tokens.push({ text, quotedStart });
      text = '';
      inToken = false;
      quotedStart = false;
    } else {
      inToken = true;
      text += char;
    }
  }
  if (inToken) tokens.push({ text, quotedStart });
  return tokens;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** A glob when the value has wildcards, a substring search otherwise. */
function textMatcher(value: string): (candidate: string | undefined) => boolean {
  if (/[*?]/.test(value)) {
    const pattern = escapeRegExp(value).replace(/\*/g, '.*').replace(/\?/g, '.');
    const regex = new RegExp(`^${pattern}$`, 'i');
    return (candidate) => candidate !== undefined && regex.test(candidate);
  }
  const needle = value.toLowerCase();
  return (candidate) => candidate !== undefined && candidate.toLowerCase().includes(needle);
}

function isMatcher(raw: string): Matcher | string {
  const value = raw.toLowerCase();
  if (!(IS_VALUES as readonly string[]).includes(value)) {
    return `unknown "is:${value}", expected one of ${IS_VALUES.join(', ')}`;
  }
  return (row) => row.status === value;
}

function fieldMatcher(field: 'name' | 'job' | 'is', value: string): Matcher | string {
  if (field === 'is') return isMatcher(value);
  if (field === 'job') {
    const match = textMatcher(value);
    return (row) => match(row.jobName);
  }
  return nameMatcher(value);
}

/**
 * Matches the name as written and without its quotes: quotes group words in a
 * query, so `method=get` is how a label value can be typed at all.
 */
function nameMatcher(value: string): Matcher {
  const match = textMatcher(value);
  return (row) => match(row.name) || match(row.name.replaceAll('"', ''));
}

type NumericField = 'change' | 'delta';

const COMPARISON = /^(>=|<=|>|<|=)([+-])?(\d+(?:\.\d*)?|\.\d+)(%)?$/;

/**
 * A comparison such as `>2%`, or null while only the operator is typed. The
 * relative change is always written in percent; the `%` is optional.
 */
function parseComparison(
  field: NumericField,
  raw: string,
): ((value: number) => boolean) | string | null {
  if (/^(>=?|<=?|=)$/.test(raw)) return null;
  const parts = COMPARISON.exec(raw);
  if (!parts || (field === 'delta' && parts[4])) {
    const example = field === 'change' ? '>2%' : '>1000';
    return `cannot read "${field}:${raw}", expected a comparison such as ${field}:${example}`;
  }
  const [, operator, sign, digits] = parts;
  const magnitude = Number(digits) / (field === 'change' ? 100 : 1);
  const threshold = sign === '-' ? -magnitude : magnitude;
  // Without a sign it is about the size of the change, either way.
  const read = sign ? (value: number) => value : Math.abs;
  switch (operator) {
    case '>':
      return (value) => read(value) > threshold;
    case '>=':
      return (value) => read(value) >= threshold;
    case '<':
      return (value) => read(value) < threshold;
    case '<=':
      return (value) => read(value) <= threshold;
    default:
      return (value) => read(value) === threshold;
  }
}

function numericValue(row: MetricChange, field: NumericField): number | undefined {
  return field === 'change' ? row.ratio : row.delta;
}

function parseSort(raw: string): SortKey | string {
  const [, name, direction] = /^(.+?)(?:-(asc|desc))?$/i.exec(raw.toLowerCase())!;
  const field = Object.hasOwn(SORT_FIELDS, name) ? SORT_FIELDS[name] : undefined;
  if (!field) {
    return `unknown sort "${name}", expected one of ${SUGGESTED_SORTS.join(', ')}`;
  }
  // Names read A to Z; for numbers the biggest is usually what one is after.
  const fallback = field === 'name' ? 'asc' : 'desc';
  return { field, direction: (direction as SortKey['direction'] | undefined) ?? fallback };
}

function sortValue(row: MetricChange, field: SortField): number | string | undefined {
  switch (field) {
    case 'name':
      return row.name;
    case 'change':
      return row.ratio;
    case 'abs-change':
      return row.ratio === undefined ? undefined : Math.abs(row.ratio);
    case 'delta':
      return row.delta;
    case 'abs-delta':
      return row.delta === undefined ? undefined : Math.abs(row.delta);
    case 'value':
      return toNumber(row.value);
    case 'previous':
      return toNumber(row.previous);
  }
}

function compareBy(keys: readonly SortKey[]) {
  return (a: MetricChange, b: MetricChange): number => {
    for (const { field, direction } of keys) {
      const left = sortValue(a, field);
      const right = sortValue(b, field);
      if (left === right) continue;
      // Rows with nothing to compare go last, in either direction.
      if (left === undefined) return 1;
      if (right === undefined) return -1;
      const order =
        typeof left === 'string' && typeof right === 'string'
          ? left.localeCompare(right)
          : (left as number) - (right as number);
      if (order !== 0) return direction === 'asc' ? order : -order;
    }
    return 0;
  };
}

export function compileQuery(input: string): CompiledQuery {
  const errors: QueryError[] = [];
  /** Positive terms grouped by field: any value of a field may match. */
  const included = new Map<Field, Matcher[]>();
  /** Negated terms and bare words, each of which has to hold on its own. */
  const required: Matcher[] = [];
  const sort: SortKey[] = [];

  for (const { text, quotedStart } of tokenize(input)) {
    let term = text;
    let negate = false;
    if (term.length > 1 && term.startsWith('-')) {
      negate = true;
      term = term.slice(1);
    }

    const parts = quotedStart ? null : /^([a-z]+):(.*)$/i.exec(term);
    if (!parts) {
      if (!term) continue;
      const match = nameMatcher(term);
      required.push(negate ? (row) => !match(row) : (row) => match(row));
      continue;
    }

    const key = parts[1].toLowerCase();
    let rest = parts[2];
    if (!Object.hasOwn(FIELDS, key)) {
      errors.push({ term: text, message: `unknown key "${key}"` });
      continue;
    }
    if (rest.startsWith('!')) {
      negate = !negate;
      rest = rest.slice(1);
    }
    const field = FIELDS[key as keyof typeof FIELDS];
    const values = rest.split(',').filter(Boolean);

    if (field === 'sort') {
      if (negate) {
        errors.push({ term: text, message: 'a sort cannot be negated; add -asc or -desc instead' });
        continue;
      }
      for (const value of values) {
        const parsed = parseSort(value);
        if (typeof parsed === 'string') errors.push({ term: text, message: parsed });
        else sort.push(parsed);
      }
      continue;
    }

    if (field === 'change' || field === 'delta') {
      const comparisons: ((value: number) => boolean)[] = [];
      for (const value of values) {
        const parsed = parseComparison(field, value);
        if (typeof parsed === 'string') errors.push({ term: text, message: parsed });
        else if (parsed) comparisons.push(parsed);
      }
      if (!comparisons.length) continue;
      // A row without the number is not judged, whichever way the term points.
      required.push((row) => {
        const value = numericValue(row, field);
        if (value === undefined) return true;
        return comparisons.some((compare) => compare(value)) !== negate;
      });
      continue;
    }

    const matchers: Matcher[] = [];
    for (const value of values) {
      const matcher = fieldMatcher(field, value);
      if (typeof matcher === 'string') errors.push({ term: text, message: matcher });
      else matchers.push(matcher);
    }
    // `is:` while still typing: nothing to filter by yet, and not worth an error.
    if (!matchers.length) continue;

    const anyMatches: Matcher = (row) => matchers.some((matcher) => matcher(row));
    if (negate) required.push((row) => !anyMatches(row));
    else included.set(field, [...(included.get(field) ?? []), anyMatches]);
  }

  const groups = [...included.values()];
  const compare = compareBy(sort);
  return {
    isEmpty: groups.length === 0 && required.length === 0,
    sort,
    errors,
    test(row) {
      return (
        required.every((matcher) => matcher(row)) &&
        groups.every((group) => group.some((matcher) => matcher(row)))
      );
    },
    order(rows) {
      return sort.length ? [...rows].sort(compare) : [...rows];
    },
  };
}

export interface Suggestion {
  /** What the list shows. */
  label: string;
  /** Replaces the input between `from` and the cursor. */
  insert: string;
}

export interface Suggestions {
  from: number;
  items: Suggestion[];
}

const SUGGESTED_KEYS = ['name', 'job', 'is', 'change', 'delta', 'sort'];

function suggestedValues(field: Field, partial: string): readonly string[] {
  if (field === 'is') return IS_VALUES;
  if (field === 'change') return ['>1%', '>5%', '>10%'];
  if (field !== 'sort') return [];
  // The directions only once a field is typed out, or the list would be long.
  const directions = SUGGESTED_SORTS.filter(
    (sort) => partial === sort || partial.startsWith(`${sort}-`),
  ).flatMap((sort) => [`${sort}-asc`, `${sort}-desc`]);
  return [...SUGGESTED_SORTS, ...directions];
}

/**
 * Completions for the term the cursor is in: keys while it has no `:` yet, and
 * values for the keys that have a fixed set of them.
 */
export function suggest(input: string, cursor: number): Suggestions {
  const before = input.slice(0, cursor);
  const termStart = before.search(/\S*$/);
  let term = before.slice(termStart);
  let offset = termStart;

  if (term.startsWith('-')) {
    term = term.slice(1);
    offset += 1;
  }

  const colon = term.indexOf(':');
  if (colon === -1) {
    if (!term || term.startsWith('"')) return { from: cursor, items: [] };
    const partial = term.toLowerCase();
    const items = SUGGESTED_KEYS.filter((key) => key.startsWith(partial) && key !== partial).map(
      (key) => ({ label: `${key}:`, insert: `${key}:` }),
    );
    return { from: offset, items };
  }

  const key = term.slice(0, colon).toLowerCase();
  if (!Object.hasOwn(FIELDS, key)) return { from: cursor, items: [] };

  // Complete only the last comma-separated value, after any `!`.
  const valueStart = term.lastIndexOf(',') + 1 || colon + 1;
  const prefix = term[valueStart] === '!' ? 1 : 0;
  const partial = term.slice(valueStart + prefix).toLowerCase();
  const items = suggestedValues(FIELDS[key as keyof typeof FIELDS], partial)
    .filter((value) => value.startsWith(partial) && value !== partial)
    .map((value) => ({ label: value, insert: `${value} ` }));
  return { from: offset + valueStart + prefix, items };
}
