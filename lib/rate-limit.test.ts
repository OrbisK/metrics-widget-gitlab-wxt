import { afterEach, describe, expect, it } from 'vitest';
import {
  noteAnswered,
  noteRateLimited,
  parseRetryAfter,
  rateLimitedUntil,
  resetRateLimit,
} from './rate-limit';

const NOW = Date.parse('2026-11-16T12:03:00Z');

afterEach(resetRateLimit);

describe('parseRetryAfter', () => {
  it('reads delay-seconds, as gitlab.com sends it', () => {
    expect(parseRetryAfter('3447', NOW)).toBe(3_447_000);
  });

  it('reads an HTTP date', () => {
    expect(parseRetryAfter('Mon, 16 Nov 2026 13:00:00 GMT', NOW)).toBe(57 * 60_000);
  });

  it.each([null, '', 'soon'])('gives up on %j', (value) => {
    expect(parseRetryAfter(value, NOW)).toBeUndefined();
  });
});

describe('noteRateLimited', () => {
  it('holds requests until GitLab’s deadline', () => {
    const until = noteRateLimited('120', NOW);

    expect(until).toBe(NOW + 120_000);
    expect(rateLimitedUntil(NOW + 119_000)).toBe(until);
    expect(rateLimitedUntil(NOW + 120_000)).toBeUndefined();
  });

  it('caps an absurd deadline at an hour', () => {
    expect(noteRateLimited('999999', NOW)).toBe(NOW + 60 * 60_000);
  });

  it('doubles its own wait while 429s without a deadline keep coming', () => {
    expect(noteRateLimited(null, NOW)).toBe(NOW + 60_000);
    expect(noteRateLimited(null, NOW)).toBe(NOW + 120_000);

    // Any other answer in between starts the doubling over.
    const later = NOW + 300_000;
    noteAnswered();
    expect(noteRateLimited(null, later)).toBe(later + 60_000);
  });

  it('never shortens a deadline already in force', () => {
    noteRateLimited('600', NOW);

    expect(noteRateLimited('10', NOW)).toBe(NOW + 600_000);
  });
});
