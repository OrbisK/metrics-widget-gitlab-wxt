import { describe, expect, it } from 'vitest';
import { compileQuery, suggest } from './query';
import type { MetricChange } from './types';

function row(name: string, extra: Partial<MetricChange> = {}): MetricChange {
  return { name, status: 'changed', jobName: 'metrics', jobWebUrl: '', ...extra };
}

const bundle = row('bundle_size_bytes', { value: '1200', previous: '1000', delta: 200, ratio: 0.2 });
const tests = row('test_count', { value: '90', previous: '100', delta: -10, ratio: -0.1, jobName: 'test' });
const get = row('requests{method="get"}', { value: '5', previous: '0', delta: 5 });
const lint = row('lint_warnings', { status: 'new', value: '3', jobName: 'lint' });
const gone = row('coverage', { status: 'removed', previous: '80' });
const all = [bundle, tests, get, lint, gone];

function names(query: string): string[] {
  const compiled = compileQuery(query);
  return compiled.order(all.filter((r) => compiled.test(r))).map((r) => r.name);
}

describe('compileQuery', () => {
  it('matches everything in the given order when empty', () => {
    const compiled = compileQuery('  ');
    expect(compiled.isEmpty).toBe(true);
    expect(compiled.sort).toEqual([]);
    expect(names('')).toEqual(all.map((r) => r.name));
  });

  it('searches bare words and globs over the full name, labels included', () => {
    expect(names('size')).toEqual(['bundle_size_bytes']);
    expect(names('method=get')).toEqual(['requests{method="get"}']);
    expect(names('*_count')).toEqual(['test_count']);
    expect(names('-bundle -test')).toEqual(['requests{method="get"}', 'lint_warnings', 'coverage']);
  });

  it('filters by status, job and name', () => {
    expect(names('is:new,removed')).toEqual(['lint_warnings', 'coverage']);
    expect(names('-is:changed')).toEqual(['lint_warnings', 'coverage']);
    expect(names('status:!changed')).toEqual(['lint_warnings', 'coverage']);
    expect(names('job:test')).toEqual(['test_count']);
    expect(names('name:*bytes is:changed')).toEqual(['bundle_size_bytes']);
  });

  it('sorts by relative change, biggest increase first, without a ratio last', () => {
    expect(names('is:changed sort:change')).toEqual([
      'bundle_size_bytes',
      'test_count',
      'requests{method="get"}',
    ]);
    expect(names('is:changed sort:change-asc')).toEqual([
      'test_count',
      'bundle_size_bytes',
      'requests{method="get"}',
    ]);
  });

  it('sorts by the size of a change, either way', () => {
    expect(names('is:changed sort:abs-delta')).toEqual([
      'bundle_size_bytes',
      'test_count',
      'requests{method="get"}',
    ]);
    expect(names('is:changed sort:delta')).toEqual([
      'bundle_size_bytes',
      'requests{method="get"}',
      'test_count',
    ]);
    expect(names('is:changed sort:abs-change-asc').at(0)).toBe('test_count');
  });

  it('sorts by the new and the old value, numerically', () => {
    expect(names('sort:value')).toEqual([
      'bundle_size_bytes',
      'test_count',
      'requests{method="get"}',
      'lint_warnings',
      'coverage',
    ]);
    expect(names('sort:old-asc')).toEqual([
      'requests{method="get"}',
      'coverage',
      'test_count',
      'bundle_size_bytes',
      'lint_warnings',
    ]);
  });

  it('sorts names A to Z by default and breaks ties with later keys', () => {
    expect(names('sort:name')).toEqual([...all.map((r) => r.name)].sort((a, b) => a.localeCompare(b)));
    expect(names('is:new,removed sort:change,name-desc')).toEqual(['lint_warnings', 'coverage']);
  });

  it('hides changes below a threshold, either way, and keeps rows without the number', () => {
    // get has a delta but no ratio (from zero); lint and coverage have neither.
    expect(names('change:>15%')).toEqual([
      'bundle_size_bytes',
      'requests{method="get"}',
      'lint_warnings',
      'coverage',
    ]);
    expect(names('change:>=10')).toEqual(names('change:>9%'));
    expect(names('is:changed change:>5%')).toEqual([
      'bundle_size_bytes',
      'test_count',
      'requests{method="get"}',
    ]);
    expect(names('is:changed delta:>=10')).toEqual(['bundle_size_bytes', 'test_count']);
    expect(names('is:changed delta:<10')).toEqual(['requests{method="get"}']);
  });

  it('compares the signed change when the number has a sign', () => {
    expect(names('is:changed change:>+0%')).toEqual(['bundle_size_bytes', 'requests{method="get"}']);
    expect(names('is:changed change:<-5%')).toEqual(['test_count', 'requests{method="get"}']);
    expect(names('is:changed delta:>-1')).toEqual(['bundle_size_bytes', 'requests{method="get"}']);
  });

  it('requires every comparison term, any of a comma list, and negates them', () => {
    expect(names('is:changed change:>5% change:<15%')).toEqual(['test_count', 'requests{method="get"}']);
    expect(names('is:changed change:<5%,>15%')).toEqual(['bundle_size_bytes', 'requests{method="get"}']);
    expect(names('is:changed -change:>15%')).toEqual(['test_count', 'requests{method="get"}']);
    expect(names('is:changed change:!>15%')).toEqual(names('is:changed -change:>15%'));
  });

  it('reports comparisons it cannot read, but not a bare operator', () => {
    expect(compileQuery('change:big delta:>5% change:2').errors.map((e) => e.term)).toEqual([
      'change:big',
      'delta:>5%',
      'change:2',
    ]);
    const typing = compileQuery('change:> delta:>=');
    expect(typing.errors).toEqual([]);
    expect(typing.isEmpty).toBe(true);
  });

  it('reports terms it cannot use and ignores them', () => {
    const compiled = compileQuery('colour:red is:old sort:size -sort:name bundle');
    expect(compiled.errors.map((e) => e.term)).toEqual([
      'colour:red',
      'is:old',
      'sort:size',
      '-sort:name',
    ]);
    expect(compiled.sort).toEqual([]);
    expect(names('colour:red is:old sort:size bundle')).toEqual(['bundle_size_bytes']);
  });

  it('ignores a key that has no value yet', () => {
    const compiled = compileQuery('is: sort:');
    expect(compiled.errors).toEqual([]);
    expect(compiled.isEmpty).toBe(true);
    expect(compiled.sort).toEqual([]);
  });
});

describe('suggest', () => {
  const labels = (input: string, cursor = input.length) =>
    suggest(input, cursor).items.map((item) => item.label);

  it('completes keys', () => {
    expect(labels('so')).toEqual(['sort:']);
    expect(labels('-j')).toEqual(['job:']);
    expect(suggest('bundle so', 9).from).toBe(7);
  });

  it('completes statuses and sort fields', () => {
    expect(labels('is:c')).toEqual(['changed']);
    expect(labels('is:changed,n')).toEqual(['new']);
    expect(labels('sort:abs')).toEqual(['abs-change', 'abs-delta']);
  });

  it('offers the directions once a sort field is typed out', () => {
    expect(labels('sort:delta')).toEqual(['delta-asc', 'delta-desc']);
    expect(labels('sort:change-a')).toEqual(['change-asc']);
    expect(labels('sort:abs-change')).toEqual(['abs-change-asc', 'abs-change-desc']);
  });

  it('offers a few thresholds for the relative change', () => {
    expect(labels('ch')).toEqual(['change:']);
    expect(labels('change:')).toEqual(['>1%', '>5%', '>10%']);
    expect(labels('change:>1')).toEqual(['>1%', '>10%']);
  });

  it('offers nothing for free-text keys or plain words', () => {
    expect(labels('job:')).toEqual([]);
    expect(labels('bundle')).toEqual([]);
  });
});
