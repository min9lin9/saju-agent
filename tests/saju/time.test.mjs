// Civil-time resolution for the deterministic saju kernel.
//
// Exercises resolveCivilTime() and helpers from skills/saju/scripts/saju/time.mjs:
// Intl-driven enumeration of distinct UTC offsets around the wall-time guess,
// exact round-trip of every candidate instant, NONEXISTENT_LOCAL_TIME for gaps,
// AMBIGUOUS_LOCAL_TIME for folds unless a matching utcOffset disambiguates,
// OFFSET_MISMATCH when a supplied offset does not describe the instant, and
// second-precision historic offsets. All assertions pin machine values
// (codes, paths, instants, offset seconds), never prose. No host-TZ or
// wall-clock dependence: every expectation is a fixed UTC instant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCivilTime,
  offsetSecondsAt,
  wallFieldsAt,
  parseUtcOffset,
  formatUtcOffset,
  parseRfc3339Instant,
  isValidTimezone,
  TimeError,
} from '../../skills/saju/scripts/saju/time.mjs';

const SEOUL = 'Asia/Seoul';
const NY = 'America/New_York';
const UTC = 'UTC';

const resolve = (date, time, timezone, utcOffset) =>
  resolveCivilTime({ date, time, timezone, utcOffset });

// Asserts resolveCivilTime throws TimeError with the exact code and path.
const rejects = (args, code, path) => {
  assert.throws(
    () => resolveCivilTime(args),
    (err) => {
      assert.ok(err instanceof TimeError, `expected TimeError, got ${err}`);
      assert.equal(err.code, code, `code: ${err.code}`);
      assert.equal(err.path, path, `path: ${err.path}`);
      return true;
    },
  );
};

test('modern Seoul wall time resolves to the unique +09:00 instant', () => {
  const r = resolve('1998-10-27', '20:40:00', SEOUL);
  assert.equal(r.instantMs, Date.parse('1998-10-27T11:40:00Z'));
  assert.equal(r.iso, '1998-10-27T11:40:00.000Z');
  assert.equal(r.offsetSeconds, 32400);
  assert.equal(r.utcOffset, '+09:00');
  assert.equal(r.ambiguous, false);
  assert.deepEqual(r.candidateOffsets, [32400]);
});

test('UTC zone resolves trivially with zero offset', () => {
  const r = resolve('2000-01-07', '00:00:00', UTC);
  assert.equal(r.instantMs, Date.parse('2000-01-07T00:00:00Z'));
  assert.equal(r.offsetSeconds, 0);
  assert.equal(r.utcOffset, '+00:00');
});

test('historic Seoul offsets are retained to the second', () => {
  // tzdb Asia/Seoul: LMT +8:27:52 before 1908-04-01, +8:30 until 1912,
  // +9:00 1912-1954, +8:30 1954-1961 with +9:30 DST summers 1955-1960,
  // +9:00 since 1961-08-10.
  const lmt = resolve('1900-06-15', '12:00:00', SEOUL);
  assert.equal(lmt.offsetSeconds, 30472);
  assert.equal(lmt.utcOffset, '+08:27:52');
  assert.equal(lmt.instantMs, Date.parse('1900-06-15T12:00:00Z') - 30472000);

  const half = resolve('1908-06-15', '12:00:00', SEOUL);
  assert.equal(half.offsetSeconds, 30600);
  assert.equal(half.utcOffset, '+08:30');

  const nine = resolve('1912-06-15', '12:00:00', SEOUL);
  assert.equal(nine.offsetSeconds, 32400);

  const backHalf = resolve('1960-01-15', '12:00:00', SEOUL);
  assert.equal(backHalf.offsetSeconds, 30600);
  const dstSummer = resolve('1960-06-15', '12:00:00', SEOUL);
  assert.equal(dstSummer.offsetSeconds, 34200);
  assert.equal(dstSummer.utcOffset, '+09:30');
});

test('supplied utcOffset matching the zone resolves; mismatching rejects', () => {
  const ok = resolve('1998-10-27', '20:40:00', SEOUL, '+09:00');
  assert.equal(ok.instantMs, Date.parse('1998-10-27T11:40:00Z'));
  const okSec = resolve('1900-06-15', '12:00:00', SEOUL, '+08:27:52');
  assert.equal(okSec.offsetSeconds, 30472);
  rejects(
    { date: '1998-10-27', time: '20:40:00', timezone: SEOUL, utcOffset: '+08:00' },
    'OFFSET_MISMATCH', 'birth.utcOffset',
  );
  rejects(
    { date: '1900-06-15', time: '12:00:00', timezone: SEOUL, utcOffset: '+08:30:00' },
    'OFFSET_MISMATCH', 'birth.utcOffset',
  );
});

test('New York 2024 spring gap: 02:30 does not exist, offset cannot rescue', () => {
  rejects(
    { date: '2024-03-10', time: '02:30:00', timezone: NY },
    'NONEXISTENT_LOCAL_TIME', 'birth.time',
  );
  // A supplied offset does not manufacture an instant inside a gap.
  rejects(
    { date: '2024-03-10', time: '02:30:00', timezone: NY, utcOffset: '-05:00' },
    'NONEXISTENT_LOCAL_TIME', 'birth.time',
  );
  // Gap edges: 01:59:59 exists (-05:00), 03:00:00 exists (-04:00).
  const before = resolve('2024-03-10', '01:59:59', NY);
  assert.equal(before.offsetSeconds, -18000);
  assert.equal(before.instantMs, Date.parse('2024-03-10T06:59:59Z'));
  const after = resolve('2024-03-10', '03:00:00', NY);
  assert.equal(after.offsetSeconds, -14400);
  assert.equal(after.instantMs, Date.parse('2024-03-10T07:00:00Z'));
});

test('New York 2024 fall fold: 01:30 is ambiguous without utcOffset', () => {
  rejects(
    { date: '2024-11-03', time: '01:30:00', timezone: NY },
    'AMBIGUOUS_LOCAL_TIME', 'birth.time',
  );
  // Fold edges: 01:00:00 and 01:59:59 are both ambiguous.
  rejects(
    { date: '2024-11-03', time: '01:00:00', timezone: NY },
    'AMBIGUOUS_LOCAL_TIME', 'birth.time',
  );
  rejects(
    { date: '2024-11-03', time: '01:59:59', timezone: NY },
    'AMBIGUOUS_LOCAL_TIME', 'birth.time',
  );
  // 00:59:59 and 02:00:00 are unambiguous.
  assert.equal(resolve('2024-11-03', '00:59:59', NY).offsetSeconds, -14400);
  assert.equal(resolve('2024-11-03', '02:00:00', NY).offsetSeconds, -18000);
});

test('fold resolves to the matching supplied utcOffset', () => {
  const dst = resolve('2024-11-03', '01:30:00', NY, '-04:00');
  assert.equal(dst.instantMs, Date.parse('2024-11-03T05:30:00Z'));
  assert.equal(dst.offsetSeconds, -14400);
  assert.equal(dst.ambiguous, true);
  const std = resolve('2024-11-03', '01:30:00', NY, '-05:00');
  assert.equal(std.instantMs, Date.parse('2024-11-03T06:30:00Z'));
  assert.equal(std.offsetSeconds, -18000);
  // An offset that matches neither candidate is a mismatch, not ambiguity.
  rejects(
    { date: '2024-11-03', time: '01:30:00', timezone: NY, utcOffset: '+00:00' },
    'OFFSET_MISMATCH', 'birth.utcOffset',
  );
});

test('historic Seoul fold 1954-03-20 23:30 is ambiguous, disambiguates by offset', () => {
  // tzdb: 1954-03-20T15:00:00Z clocks fell back +9:00 -> +8:30;
  // local 23:30-24:00 occurred twice.
  rejects(
    { date: '1954-03-20', time: '23:30:00', timezone: SEOUL },
    'AMBIGUOUS_LOCAL_TIME', 'birth.time',
  );
  const first = resolve('1954-03-20', '23:30:00', SEOUL, '+09:00');
  assert.equal(first.instantMs, Date.parse('1954-03-20T14:30:00Z'));
  const second = resolve('1954-03-20', '23:30:00', SEOUL, '+08:30:00');
  assert.equal(second.instantMs, Date.parse('1954-03-20T15:00:00Z'));
  // 23:29:59 is unambiguous (+9:00); 23:45 also ambiguous.
  assert.equal(resolve('1954-03-20', '23:29:59', SEOUL).offsetSeconds, 32400);
  rejects(
    { date: '1954-03-20', time: '23:45:00', timezone: SEOUL },
    'AMBIGUOUS_LOCAL_TIME', 'birth.time',
  );
});

test('historic Seoul gap 1961-08-10 00:15 does not exist', () => {
  // tzdb: 1961-08-09T15:30:00Z clocks jumped +8:30 -> +9:00;
  // local 00:00-00:30 never occurred.
  rejects(
    { date: '1961-08-10', time: '00:15:00', timezone: SEOUL },
    'NONEXISTENT_LOCAL_TIME', 'birth.time',
  );
  rejects(
    { date: '1961-08-10', time: '00:15:00', timezone: SEOUL, utcOffset: '+08:30:00' },
    'NONEXISTENT_LOCAL_TIME', 'birth.time',
  );
  assert.equal(resolve('1961-08-09', '23:59:59', SEOUL).offsetSeconds, 30600);
  assert.equal(resolve('1961-08-10', '00:30:00', SEOUL).offsetSeconds, 32400);
});

test('Seoul 1988 DST: 02:30 gap on 1988-05-08, 02:30 fold on 1988-10-09', () => {
  rejects(
    { date: '1988-05-08', time: '02:30:00', timezone: SEOUL },
    'NONEXISTENT_LOCAL_TIME', 'birth.time',
  );
  rejects(
    { date: '1988-10-09', time: '02:30:00', timezone: SEOUL },
    'AMBIGUOUS_LOCAL_TIME', 'birth.time',
  );
  // Wall 02:30 - 10h = 1988-10-08T16:30Z; wall 02:30 - 9h = 1988-10-08T17:30Z.
  const dst = resolve('1988-10-09', '02:30:00', SEOUL, '+10:00');
  assert.equal(dst.instantMs, Date.parse('1988-10-08T16:30:00Z'));
  const std = resolve('1988-10-09', '02:30:00', SEOUL, '+09:00');
  assert.equal(std.instantMs, Date.parse('1988-10-08T17:30:00Z'));
});

test('midnight resolves as 00:00 of that civil date, not 24:00', () => {
  const r = resolve('1998-10-27', '00:00:00', SEOUL);
  assert.equal(r.instantMs, Date.parse('1998-10-26T15:00:00Z'));
  const w = wallFieldsAt(SEOUL, r.instantMs);
  assert.equal(w.hour, 0);
  assert.equal(w.day, 27);
});

test('invalid timezone and malformed inputs reject with stable paths', () => {
  rejects(
    { date: '1998-10-27', time: '20:40:00', timezone: 'Mars/Olympus' },
    'INVALID_TIMEZONE', 'birth.timezone',
  );
  rejects(
    { date: '1998-02-30', time: '20:40:00', timezone: SEOUL },
    'INVALID_DATE', 'birth.date',
  );
  rejects(
    { date: '1998-10-27', time: '25:00:00', timezone: SEOUL },
    'INVALID_TIME', 'birth.time',
  );
  rejects(
    { date: '1998-10-27', time: '20:40:00', timezone: SEOUL, utcOffset: 'KST' },
    'INVALID_UTC_OFFSET', 'birth.utcOffset',
  );
});

test('offsetSecondsAt and wallFieldsAt expose raw Intl facts', () => {
  assert.equal(offsetSecondsAt(SEOUL, Date.parse('1998-10-27T11:40:00Z')), 32400);
  assert.equal(offsetSecondsAt(SEOUL, Date.parse('1900-06-15T03:32:08Z')), 30472);
  assert.equal(offsetSecondsAt(NY, Date.parse('2024-11-03T05:30:00Z')), -14400);
  assert.equal(offsetSecondsAt(NY, Date.parse('2024-11-03T06:30:00Z')), -18000);
  assert.deepEqual(
    wallFieldsAt(SEOUL, Date.parse('1998-10-27T11:40:00Z')),
    { year: 1998, month: 10, day: 27, hour: 20, minute: 40, second: 0 },
  );
});

test('parseUtcOffset / formatUtcOffset round-trip including seconds', () => {
  assert.equal(parseUtcOffset('+09:00'), 32400);
  assert.equal(parseUtcOffset('-05:00'), -18000);
  assert.equal(parseUtcOffset('+08:27:52'), 30472);
  assert.equal(parseUtcOffset('-00:30:15'), -1815);
  assert.equal(parseUtcOffset('+00:00'), 0);
  for (const bad of ['9:00', '+9:00', '+09', '+09:00:00:00', '+24:00', '+09:60', '+09:00:60', 'x', 9, null]) {
    assert.equal(parseUtcOffset(bad), null, String(bad));
  }
  assert.equal(formatUtcOffset(32400), '+09:00');
  assert.equal(formatUtcOffset(-18000), '-05:00');
  assert.equal(formatUtcOffset(30472), '+08:27:52');
  assert.equal(formatUtcOffset(0), '+00:00');
});

test('parseRfc3339Instant requires explicit offset and real calendar fields', () => {
  const t = parseRfc3339Instant('2026-09-17T12:00:00+09:00');
  assert.equal(t.instantMs, Date.parse('2026-09-17T03:00:00Z'));
  assert.equal(t.offsetSeconds, 32400);
  assert.equal(t.text, '2026-09-17T12:00:00+09:00');
  const z = parseRfc3339Instant('2027-01-01T00:00:00Z');
  assert.equal(z.instantMs, Date.parse('2027-01-01T00:00:00Z'));
  assert.equal(z.offsetSeconds, 0);
  const frac = parseRfc3339Instant('2026-09-17T12:00:00.789+09:00');
  assert.equal(frac.instantMs, Date.parse('2026-09-17T03:00:00.789Z'));
  assert.equal(parseRfc3339Instant('2026-09-17T12:00:00'), null);
  assert.equal(parseRfc3339Instant('2026-09-17T12:00:00-00:00'), null);
  assert.equal(parseRfc3339Instant('2026-02-30T00:00:00Z'), null);
  assert.equal(parseRfc3339Instant('2026-09-17T24:00:00Z'), null);
  assert.equal(parseRfc3339Instant('2026-06-30T23:59:60Z'), null);
  assert.equal(parseRfc3339Instant('not-a-date'), null);
  assert.equal(parseRfc3339Instant(42), null);
});

test('isValidTimezone delegates to Intl', () => {
  assert.equal(isValidTimezone('Asia/Seoul'), true);
  assert.equal(isValidTimezone('UTC'), true);
  assert.equal(isValidTimezone('Mars/Olympus'), false);
  assert.equal(isValidTimezone(''), false);
  assert.equal(isValidTimezone(9), false);
});

test('resolution is host-TZ independent and deterministic', () => {
  const args = { date: '1988-10-09', time: '02:30:00', timezone: SEOUL, utcOffset: '+10:00' };
  const a = resolveCivilTime(args);
  const saved = process.env.TZ;
  process.env.TZ = 'Pacific/Kiritimati';
  try {
    assert.deepEqual(resolveCivilTime(args), a);
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test('error objects carry stable machine fields', () => {
  try {
    resolve('2024-03-10', '02:30:00', NY);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof TimeError);
    assert.equal(err.name, 'TimeError');
    assert.equal(err.code, 'NONEXISTENT_LOCAL_TIME');
    assert.equal(err.path, 'birth.time');
    assert.equal(typeof err.message, 'string');
  }
});
