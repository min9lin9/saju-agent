// major-cycles.test.mjs — major-cycle direction, start instants and intervals.
//
// Oracles, in order of authority:
//   literal hand-calculated values below   derived by hand from the plan's
//                                          stipulated major-cycle policy
//                                          (direction, inclusive adjacent
//                                          jie, three-days-calendar-v1) —
//                                          never from the runtime under test
//   injected jie facts                     stub calendars return fixed term
//                                          instants, so every expected
//                                          distance/start is computed by
//                                          hand, not by the ephemeris
//   real ephemeris                         one sanity test asserts structure
//                                          and loose bounds only, never a
//                                          hardcoded engine instant
//
// No expected value is produced by running the code under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  MajorCycleError,
  MAJOR_CYCLE_CONVENTION,
  MISSING_MAJOR_DIRECTION,
  SECONDS_PER_NOMINAL_YEAR,
  computeMajorCycles,
  decomposeNominalAge,
} from '../../skills/saju/scripts/saju/major-cycles.mjs';
import { deriveNatal } from '../../skills/saju/scripts/saju/natal.mjs';
import { CalendarError } from '../../skills/saju/scripts/saju/calendar.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, '..', 'fixtures', 'saju');
const request = (name) => JSON.parse(readFileSync(join(fixtureDir, 'requests', `${name}.json`), 'utf8'));

const ms = (iso) => Date.parse(iso);
const DAY = 86400 * 1000;

// A calendar stub keyed by 'YYYY-MM' returning injected term facts.
const stubCalendar = (terms) => {
  const calls = [];
  return {
    calls,
    findSolarTerm({ year, month }) {
      calls.push({ year, month });
      const t = terms[`${year}-${String(month).padStart(2, '0')}`];
      if (!t) {
        throw new CalendarError(
          'SOLAR_TERM_SEARCH_FAILED', 'birth.date', `stub has no term for ${year}-${month}`,
        );
      }
      return {
        eventId: `${year}-${t.termId}`,
        termId: t.termId,
        iso: new Date(t.ms).toISOString(),
        instantMs: t.ms,
        uncertaintySeconds: 120,
      };
    },
  };
};

const natalFor = ({ date, time, timezone, terms, ...extra }) => deriveNatal({
  date, time, timezone, calendar: stubCalendar(terms), ...extra,
});

const birthOf = (req) => {
  const [year, month, day] = req.birth.date.split('-').map(Number);
  return {
    date: { year, month, day },
    timezone: req.birth.timezone,
    gender: req.birth.gender ?? null,
  };
};

// --- nominal-age decomposition (exact integer math) ------------------------------

test('decomposeNominalAge: 259200 s distance is exactly one nominal year', () => {
  assert.equal(SECONDS_PER_NOMINAL_YEAR, 259200);
  assert.deepEqual(decomposeNominalAge(0), { years: 0, months: 0, days: 0, seconds: 0 });
  assert.deepEqual(
    decomposeNominalAge(259200 * 1000), { years: 1, months: 0, days: 0, seconds: 0 },
  );
  // 6 h = 1/12 year = exactly one month; no floating-point drift to 0 months.
  assert.deepEqual(
    decomposeNominalAge(21600 * 1000), { years: 0, months: 1, days: 0, seconds: 0 },
  );
  // 30 min = 2.5 nominal days.
  assert.deepEqual(
    decomposeNominalAge(1800 * 1000), { years: 0, months: 0, days: 2, seconds: 43200 },
  );
  // 7.5 days = 2.5 nominal years = 2 years 6 months.
  assert.deepEqual(
    decomposeNominalAge(648000 * 1000), { years: 2, months: 6, days: 0, seconds: 0 },
  );
  // 1 day = 4 months; 1 hour = 5 days (traditional equivalences fall out).
  assert.deepEqual(
    decomposeNominalAge(86400 * 1000), { years: 0, months: 4, days: 0, seconds: 0 },
  );
  assert.deepEqual(
    decomposeNominalAge(3600 * 1000), { years: 0, months: 0, days: 5, seconds: 0 },
  );
});

// --- direction: all polarity/gender combinations ----------------------------------

// 1998 is a yang year (戊寅); 1999 is yin (己卯). Births sit after the
// injected October jie, so forward reads the November jie and reverse reads
// the October jie.
const OCT_TERMS = (y) => ({
  [`${y}-09`]: { termId: 'baengno', ms: ms(`${y}-09-08T12:00:00Z`) },
  [`${y}-10`]: { termId: 'hallo', ms: ms(`${y}-10-08T12:00:00Z`) },
  [`${y}-11`]: { termId: 'ipdong', ms: ms(`${y}-11-07T12:00:00Z`) },
});

const directionCase = (year, gender) => {
  const natal = natalFor({
    date: { year, month: 10, day: 27 },
    time: { hour: 12, minute: 0, second: 0 },
    timezone: 'UTC',
    terms: OCT_TERMS(year),
  });
  return computeMajorCycles({
    birth: { date: { year, month: 10, day: 27 }, timezone: 'UTC', gender },
    natal,
    count: 1,
    calendar: stubCalendar(OCT_TERMS(year)),
  });
};

test('direction: yang-year male and yin-year female go forward, else reverse', () => {
  const yangMale = directionCase(1998, 'male');
  assert.equal(yangMale.candidates[0].direction, 'forward');
  assert.equal(yangMale.candidates[0].directionBasis.yearPolarity, 'yang');
  assert.equal(yangMale.candidates[0].directionBasis.yearStem.hanzi, '戊');
  assert.equal(yangMale.candidates[0].ranges[0].adjacentJie.termId, 'ipdong');
  assert.equal(yangMale.candidates[0].ranges[0].adjacentJie.role, 'next');
  // Forward distance: birth -> Nov 7 jie = 11 days.
  assert.equal(yangMale.candidates[0].ranges[0].distance.minSeconds, 11 * 86400);

  const yangFemale = directionCase(1998, 'female');
  assert.equal(yangFemale.candidates[0].direction, 'reverse');
  assert.equal(yangFemale.candidates[0].ranges[0].adjacentJie.termId, 'hallo');
  assert.equal(yangFemale.candidates[0].ranges[0].adjacentJie.role, 'current');
  // Reverse distance: Oct 8 jie -> birth = 19 days.
  assert.equal(yangFemale.candidates[0].ranges[0].distance.minSeconds, 19 * 86400);

  const yinMale = directionCase(1999, 'male');
  assert.equal(yinMale.candidates[0].direction, 'reverse');
  assert.equal(yinMale.candidates[0].directionBasis.yearStem.hanzi, '己');
  assert.equal(yinMale.candidates[0].ranges[0].adjacentJie.termId, 'hallo');

  const yinFemale = directionCase(1999, 'female');
  assert.equal(yinFemale.candidates[0].direction, 'forward');
  assert.equal(yinFemale.candidates[0].ranges[0].adjacentJie.termId, 'ipdong');
});

// --- boundary distance zero ---------------------------------------------------------

test('birth exactly at a jie gives distance zero and start at the birth instant', () => {
  const T0 = ms('2024-03-10T12:00:00.000Z');
  const terms = { '2024-03': { termId: 'gyeongchip', ms: T0 } };
  const natal = natalFor({
    date: { year: 2024, month: 3, day: 10 },
    time: { hour: 12, minute: 0, second: 0 },
    timezone: 'UTC',
    terms,
    resolveTime: () => ({ instantMs: T0 }), // birth IS the jie instant
  });
  assert.equal(natal.candidates.length, 2); // inside the +/-120 s band
  for (const gender of ['male', 'female']) {
    const r = computeMajorCycles({
      birth: { date: { year: 2024, month: 3, day: 10 }, timezone: 'UTC', gender },
      natal,
      count: 2,
      calendar: stubCalendar(terms),
    });
    for (const cand of r.candidates) {
      assert.equal(cand.ranges.length, 1);
      const range = cand.ranges[0];
      assert.equal(range.distance.minMs, 0);
      assert.equal(range.distance.maxMs, 0);
      assert.equal(range.start.earliest.instantMs, T0);
      assert.equal(range.start.latest.instantMs, T0);
      assert.equal(range.cycles[0].interval.start.earliest.instantMs, T0);
    }
  }
});

// --- start date conventions ---------------------------------------------------------

test('259200-second jie distance yields a start exactly one calendar year later', () => {
  const birth = { year: 1998, month: 10, day: 27 };
  const terms = { '1998-10': { termId: 'hallo', ms: ms('1998-10-30T12:00:00Z') } };
  const natal = natalFor({
    date: birth, time: { hour: 12, minute: 0, second: 0 }, timezone: 'UTC', terms,
  });
  const r = computeMajorCycles({
    birth: { date: birth, timezone: 'UTC', gender: 'male' },
    natal, count: 1, calendar: stubCalendar(terms),
  });
  const range = r.candidates[0].ranges[0];
  assert.equal(range.distance.minSeconds, 259200);
  assert.equal(range.start.earliest.nominalYears, 1);
  assert.deepEqual(range.start.earliest.age, { years: 1, months: 0, days: 0, seconds: 0 });
  assert.equal(range.start.earliest.iso, '1999-10-27T12:00:00.000Z');
  assert.equal(range.start.earliest.offsetPolicy, 'exact');
});

test('month-end clamp: Jan 31 + 1 month lands on Feb 28', () => {
  const birth = { year: 2023, month: 1, day: 31 };
  // Injected January jie 6 h after the birth instant: distance 21600 s = 1 month.
  const terms = { '2023-01': { termId: 'sohan', ms: ms('2023-01-31T18:00:00Z') } };
  const natal = natalFor({
    date: birth, time: { hour: 12, minute: 0, second: 0 }, timezone: 'UTC', terms,
  });
  const r = computeMajorCycles({
    birth: { date: birth, timezone: 'UTC', gender: 'male' }, // 壬寅 yang -> forward
    natal, count: 1, calendar: stubCalendar(terms),
  });
  const range = r.candidates[0].ranges[0];
  assert.equal(range.distance.minSeconds, 21600);
  assert.deepEqual(range.start.earliest.age, { years: 0, months: 1, days: 0, seconds: 0 });
  assert.equal(range.start.earliest.iso, '2023-02-28T12:00:00.000Z');
});

test('year-end clamp: Feb 29 + 1 year lands on Feb 28, and cycle steps clamp too', () => {
  const birth = { year: 2024, month: 2, day: 29 };
  const terms = {
    '2024-02': { termId: 'ipchun', ms: ms('2024-02-04T12:00:00Z') },
    '2024-03': { termId: 'gyeongchip', ms: ms('2024-03-03T12:00:00Z') }, // birth + 3 d
  };
  const natal = natalFor({
    date: birth, time: { hour: 12, minute: 0, second: 0 }, timezone: 'UTC', terms,
  });
  const r = computeMajorCycles({
    birth: { date: birth, timezone: 'UTC', gender: 'male' }, // 甲辰 yang -> forward
    natal, count: 2, calendar: stubCalendar(terms),
  });
  const range = r.candidates[0].ranges[0];
  assert.equal(range.distance.minSeconds, 259200);
  assert.equal(range.start.earliest.iso, '2025-02-28T12:00:00.000Z');
  // The +10-year cycle bound clamps the same way.
  assert.equal(range.cycles[0].interval.end.earliest.iso, '2035-02-28T12:00:00.000Z');
  assert.equal(range.cycles[1].interval.start.earliest.iso, '2035-02-28T12:00:00.000Z');
});

test('years-then-months order: Jan 31 + 1y1m lands on Feb 29 of the leap year', () => {
  const birth = { year: 2023, month: 1, day: 31 };
  const terms = {
    '2023-01': { termId: 'sohan', ms: ms('2023-01-05T12:00:00Z') },
    '2023-02': { termId: 'ipchun', ms: ms('2023-02-03T18:00:00Z') }, // birth + 280800 s
  };
  const natal = natalFor({
    date: birth, time: { hour: 12, minute: 0, second: 0 }, timezone: 'UTC', terms,
  });
  const r = computeMajorCycles({
    birth: { date: birth, timezone: 'UTC', gender: 'male' },
    natal, count: 1, calendar: stubCalendar(terms),
  });
  const range = r.candidates[0].ranges[0];
  assert.equal(range.distance.minSeconds, 280800);
  assert.deepEqual(range.start.earliest.age, { years: 1, months: 1, days: 0, seconds: 0 });
  assert.equal(range.start.earliest.iso, '2024-02-29T12:00:00.000Z');
});

// --- start-wall offset policy ---------------------------------------------------------

test('a start wall inside a DST gap advances by the gap; a repeated wall takes the earlier occurrence', () => {
  // Birth 2023-03-10 02:30 New York + 1 nominal year -> 2024-03-10 02:30,
  // inside the spring-forward gap (02:00-03:00): advances to 03:30 EDT.
  const gapBirth = { year: 2023, month: 3, day: 10 };
  const gapTerms = { '2023-03': { termId: 'gyeongchip', ms: ms('2023-03-13T07:30:00Z') } };
  const gapNatal = natalFor({
    date: gapBirth, time: { hour: 2, minute: 30, second: 0 },
    timezone: 'America/New_York', terms: gapTerms,
  });
  const gap = computeMajorCycles({
    birth: { date: gapBirth, timezone: 'America/New_York', gender: 'female' }, // 癸卯 yin -> forward
    natal: gapNatal, count: 1, calendar: stubCalendar(gapTerms),
  });
  const gapStart = gap.candidates[0].ranges[0].start.earliest;
  assert.equal(gapStart.offsetPolicy, 'nonexistent_wall_time_advanced_by_gap');
  assert.equal(gapStart.iso, '2024-03-10T07:30:00.000Z'); // 03:30 EDT
  assert.equal(gapStart.utcOffset, '-04:00');
  assert.deepEqual(
    [gapStart.wall.hour, gapStart.wall.minute], [3, 30],
  );

  // Birth 2023-11-03 01:30 New York + 1 nominal year -> 2024-11-03 01:30,
  // repeated at the fall-back fold: the earlier (EDT) occurrence is taken.
  const foldBirth = { year: 2023, month: 11, day: 3 };
  const foldTerms = { '2023-11': { termId: 'ipdong', ms: ms('2023-11-06T05:30:00Z') } };
  const foldNatal = natalFor({
    date: foldBirth, time: { hour: 1, minute: 30, second: 0 },
    timezone: 'America/New_York', terms: foldTerms,
  });
  const fold = computeMajorCycles({
    birth: { date: foldBirth, timezone: 'America/New_York', gender: 'female' },
    natal: foldNatal, count: 1, calendar: stubCalendar(foldTerms),
  });
  const foldStart = fold.candidates[0].ranges[0].start.earliest;
  assert.equal(foldStart.offsetPolicy, 'repeated_wall_time_earlier_occurrence');
  assert.equal(foldStart.iso, '2024-11-03T05:30:00.000Z'); // 01:30 EDT, earlier occurrence
  assert.equal(foldStart.utcOffset, '-04:00');
});

// --- happy path: injected jie facts, hand-calculated start and 10 cycles --------------

test('known chart: injected jie facts produce the hand-calculated start and 10 cycles', () => {
  const req = request('known'); // 1998-10-27 20:40 Asia/Seoul, male
  const birth = birthOf(req);
  // Birth instant 1998-10-27T11:40Z; injected November jie 7.5 days later.
  const terms = {
    '1998-10': { termId: 'hallo', ms: ms('1998-10-08T17:00:00Z') },
    '1998-11': { termId: 'ipdong', ms: ms('1998-11-03T23:40:00Z') },
  };
  const natal = natalFor({
    date: birth.date,
    time: { hour: 20, minute: 40, second: 0 },
    timezone: birth.timezone,
    terms,
  });
  assert.equal(natal.candidates[0].pillars.month.ganZhi, '壬戌');
  const r = computeMajorCycles({ birth, natal, count: 10, calendar: stubCalendar(terms) });

  assert.equal(r.available, true);
  assert.equal(r.convention, MAJOR_CYCLE_CONVENTION);
  assert.equal(r.convention, 'three-days-calendar-v1');
  assert.equal(r.secondsPerNominalYear, 259200);
  assert.equal(r.cycleYears, 10);
  assert.equal(r.count, 10);
  assert.deepEqual(r.limitations, []);
  assert.equal(r.candidates.length, 1);

  const cand = r.candidates[0];
  assert.equal(cand.candidateIndex, 0);
  assert.equal(cand.direction, 'forward');
  assert.equal(cand.ranges.length, 1);
  const range = cand.ranges[0];
  assert.equal(range.adjacentJie.termId, 'ipdong');
  assert.equal(range.adjacentJie.iso, '1998-11-03T23:40:00.000Z');
  // Raw distance preserved exactly: 7.5 days.
  assert.equal(range.distance.minMs, 648000000);
  assert.equal(range.distance.maxMs, 648000000);
  assert.equal(range.distance.minSeconds, 648000);
  // Nominal age 2.5 years -> {2,6,0,0}; start 2001-04-27 20:40 KST.
  assert.equal(range.start.earliest.nominalYears, 2.5);
  assert.deepEqual(range.start.earliest.age, { years: 2, months: 6, days: 0, seconds: 0 });
  assert.equal(range.start.earliest.iso, '2001-04-27T11:40:00.000Z');
  assert.equal(range.start.latest.iso, '2001-04-27T11:40:00.000Z');
  assert.equal(range.start.earliest.utcOffset, '+09:00');
  assert.equal(range.start.earliest.offsetPolicy, 'exact');
  assert.deepEqual(
    [range.start.earliest.wall.year, range.start.earliest.wall.month, range.start.earliest.wall.day],
    [2001, 4, 27],
  );

  // Ten cycles: month pillar 壬戌 advanced one step each, ten local years apart.
  const expectedGanZhi = ['癸亥', '甲子', '乙丑', '丙寅', '丁卯', '戊辰', '己巳', '庚午', '辛未', '壬申'];
  assert.equal(range.cycles.length, 10);
  for (let i = 0; i < 10; i += 1) {
    const c = range.cycles[i];
    assert.equal(c.id, `major.${i}`);
    assert.equal(c.index, i);
    assert.equal(c.pillar.ganZhi, expectedGanZhi[i]);
    assert.equal(c.interval.endExclusive, true);
    assert.equal(c.interval.start.earliest.iso, `${2001 + 10 * i}-04-27T11:40:00.000Z`);
    assert.equal(c.interval.end.earliest.iso, `${2011 + 10 * i}-04-27T11:40:00.000Z`);
    if (i > 0) {
      assert.equal(
        c.interval.start.earliest.instantMs,
        range.cycles[i - 1].interval.end.earliest.instantMs,
      );
    }
  }
});

// --- unknown birth time: candidate-associated ranges ------------------------------------

test('unknown time: one candidate yields a start range, never a midpoint', () => {
  const req = request('unknown-time'); // 1998-10-27, time null, Asia/Seoul
  const birth = { ...birthOf(req), gender: 'male' };
  const terms = {
    '1998-10': { termId: 'hallo', ms: ms('1998-10-08T17:00:00Z') },
    '1998-11': { termId: 'ipdong', ms: ms('1998-11-07T12:00:00Z') },
  };
  const natal = natalFor({ date: birth.date, time: null, timezone: birth.timezone, terms });
  assert.equal(natal.candidates.length, 1);
  const r = computeMajorCycles({ birth, natal, count: 3, calendar: stubCalendar(terms) });
  const cand = r.candidates[0];
  assert.equal(cand.candidateIndex, 0);
  assert.equal(cand.direction, 'forward');
  assert.equal(cand.ranges.length, 1);
  const range = cand.ranges[0];
  // The whole Seoul civil day is the possible-instant interval.
  assert.equal(range.birthInstants.startIso, '1998-10-26T15:00:00.000Z');
  assert.equal(range.birthInstants.endIso, '1998-10-27T15:00:00.000Z');
  assert.equal(range.adjacentJie.termId, 'ipdong');
  // Hand-calculated endpoints: distance 1026000 s at day start -> {3,11,15,0}
  // -> latest start 2002-10-12 00:00 KST; distance 939600 s at day end ->
  // {3,7,15,0} -> earliest start 2002-06-12 00:00 KST.
  assert.equal(range.distance.minMs, 939600000);
  assert.equal(range.distance.maxMs, 1026000000);
  assert.equal(range.start.earliest.iso, '2002-06-11T15:00:00.000Z');
  assert.equal(range.start.latest.iso, '2002-10-11T15:00:00.000Z');
  assert.ok(range.start.earliest.instantMs < range.start.latest.instantMs);
  assert.equal(range.cycles.length, 3);
  // Cycle bounds inherit the range: earliest/latest stay ordered.
  for (const c of range.cycles) {
    assert.ok(c.interval.start.earliest.instantMs < c.interval.start.latest.instantMs);
    assert.ok(c.interval.end.earliest.instantMs < c.interval.end.latest.instantMs);
  }
});

test('unknown time: a jie inside the day enumerates both discontinuity pieces per candidate', () => {
  const T0 = ms('2024-03-10T12:00:00.000Z');
  const terms = {
    '2024-02': { termId: 'ipchun', ms: ms('2024-02-04T12:00:00Z') },
    '2024-03': { termId: 'gyeongchip', ms: T0 },
    '2024-04': { termId: 'cheongmyeong', ms: ms('2024-04-04T12:00:00Z') },
  };
  const natal = natalFor({
    date: { year: 2024, month: 3, day: 10 }, time: null, timezone: 'UTC', terms,
  });
  assert.equal(natal.candidates.length, 2);
  const r = computeMajorCycles({
    birth: { date: { year: 2024, month: 3, day: 10 }, timezone: 'UTC', gender: 'male' },
    natal, count: 3, calendar: stubCalendar(terms),
  });
  assert.equal(r.candidates.length, 2);
  const [before, after] = r.candidates;
  assert.equal(before.candidateIndex, 0);
  assert.equal(after.candidateIndex, 1);
  assert.equal(before.side, 'before');
  assert.equal(after.side, 'after');
  // Per-candidate month pillars step into different first cycles.
  assert.equal(before.ranges[0].cycles[0].pillar.ganZhi, '丁卯'); // month 丙寅 +1
  assert.equal(after.ranges[0].cycles[0].pillar.ganZhi, '戊辰'); // month 丁卯 +1

  // 'before' interval [day start, T0+120 s+1 ms] splits at T0.
  assert.equal(before.ranges.length, 2);
  const [bA, bB] = before.ranges;
  assert.equal(bA.adjacentJie.role, 'current');
  assert.equal(bA.birthInstants.startIso, '2024-03-10T00:00:00.000Z');
  assert.equal(bA.birthInstants.endMs, T0);
  assert.equal(bA.birthInstants.endInclusive, true);
  assert.equal(bA.distance.minMs, 0);
  assert.equal(bA.distance.maxMs, 43200000); // 12 h at day start
  assert.equal(bA.start.earliest.iso, '2024-03-10T12:00:00.000Z'); // distance 0 at T0
  assert.equal(bA.start.latest.iso, '2024-05-10T00:00:00.000Z'); // {0,2,0,0} -> +2 months
  assert.equal(bB.adjacentJie.role, 'next');
  assert.equal(bB.birthInstants.startMs, T0);
  assert.equal(bB.birthInstants.startInclusive, false); // open bound at the discontinuity
  assert.equal(bB.birthInstants.endMs, T0 + 120001);
  assert.equal(bB.distance.minMs, 2159879999);
  assert.equal(bB.distance.maxMs, 2160000000); // 25 days T0 -> Apr 4 jie
  assert.equal(bB.start.earliest.iso, '2032-07-10T08:01:59.881Z');
  assert.equal(bB.start.latest.iso, '2032-07-10T12:00:00.000Z');

  // 'after' interval [T0-120 s, day end) splits at T0 too.
  assert.equal(after.ranges.length, 2);
  const [aA, aB] = after.ranges;
  assert.equal(aA.adjacentJie.role, 'current');
  assert.equal(aA.distance.minMs, 0);
  assert.equal(aA.distance.maxMs, 120000);
  assert.equal(aA.start.earliest.iso, '2024-03-10T12:00:00.000Z');
  assert.equal(aA.start.latest.iso, '2024-03-10T15:58:00.000Z'); // +14400 s
  assert.equal(aB.adjacentJie.role, 'next');
  assert.equal(aB.distance.minMs, 2116800000); // 24.5 days day-end -> Apr 4 jie
  assert.equal(aB.distance.maxMs, 2160000000);
  assert.equal(aB.start.earliest.iso, '2032-05-11T00:00:00.000Z');
  assert.equal(aB.start.latest.iso, '2032-07-10T12:00:00.000Z');
});

// --- missing gender ---------------------------------------------------------------------

test('missing gender: natal stays intact, cycles unavailable, MISSING_MAJOR_DIRECTION', () => {
  const req = request('missing-gender'); // known.json shape without gender
  const birth = birthOf(req);
  assert.equal(birth.gender, null);
  const terms = {
    '1998-10': { termId: 'hallo', ms: ms('1998-10-08T17:00:00Z') },
    '1998-11': { termId: 'ipdong', ms: ms('1998-11-07T12:00:00Z') },
  };
  const natal = natalFor({
    date: birth.date,
    time: { hour: 20, minute: 40, second: 0 },
    timezone: birth.timezone,
    terms,
  });
  const natalBefore = JSON.stringify(natal);
  const r = computeMajorCycles({ birth, natal, count: 10, calendar: stubCalendar(terms) });
  assert.equal(r.available, false);
  assert.deepEqual(r.candidates, []);
  assert.equal(r.limitations.length, 1);
  assert.equal(r.limitations[0].code, MISSING_MAJOR_DIRECTION);
  assert.equal(r.limitations[0].code, 'MISSING_MAJOR_DIRECTION');
  assert.equal(r.limitations[0].path, 'birth.gender');
  // The natal input is untouched.
  assert.equal(JSON.stringify(natal), natalBefore);
  assert.equal(natal.candidates.length, 1);
  assert.equal(natal.candidates[0].pillars.day.ganZhi, '丁未');
});

test('count 0 emits no cycles and no missing-gender limitation', () => {
  const req = request('missing-gender');
  const birth = birthOf(req);
  const natal = natalFor({
    date: birth.date,
    time: { hour: 20, minute: 40, second: 0 },
    timezone: birth.timezone,
    terms: { '1998-10': { termId: 'hallo', ms: ms('1998-10-08T17:00:00Z') } },
  });
  const r = computeMajorCycles({ birth, natal, count: 0 });
  assert.equal(r.available, true);
  assert.deepEqual(r.candidates, []);
  assert.deepEqual(r.limitations, []);
});

// --- real ephemeris sanity -----------------------------------------------------------------

test('real ephemeris: known.json produces a forward cycle set within jie-distance bounds', () => {
  const req = request('known');
  const birth = birthOf(req);
  const natal = deriveNatal({
    date: birth.date,
    time: { hour: 20, minute: 40, second: 0 },
    timezone: birth.timezone,
  });
  const r = computeMajorCycles({ birth, natal, count: 10 });
  assert.equal(r.available, true);
  const cand = r.candidates[0];
  assert.equal(cand.direction, 'forward'); // 戊寅 yang + male
  assert.equal(cand.ranges.length, 1);
  const range = cand.ranges[0];
  assert.equal(range.adjacentJie.role, 'next');
  assert.equal(range.adjacentJie.termId, 'ipdong');
  // The next jie is always within ~31 days; never a fixed-age default.
  assert.ok(range.distance.minMs > 0);
  assert.ok(range.distance.minMs <= 32 * DAY);
  assert.equal(range.start.earliest.instantMs, range.start.latest.instantMs);
  assert.equal(range.start.earliest.utcOffset, '+09:00');
  assert.equal(range.start.earliest.offsetPolicy, 'exact');
  assert.equal(range.cycles.length, 10);
  assert.equal(range.cycles[0].pillar.ganZhi, '癸亥'); // 壬戌 + 1
  assert.equal(range.cycles[9].pillar.ganZhi, '壬申');
});

// --- errors and determinism -----------------------------------------------------------------

test('invalid inputs reject with stable codes', () => {
  const natal = natalFor({
    date: { year: 1998, month: 10, day: 27 },
    time: { hour: 12, minute: 0, second: 0 },
    timezone: 'UTC',
    terms: { '1998-10': { termId: 'hallo', ms: ms('1998-10-08T12:00:00Z') } },
  });
  const birth = { date: { year: 1998, month: 10, day: 27 }, timezone: 'UTC', gender: 'male' };
  for (const count of [-1, 13, 1.5, '10']) {
    assert.throws(
      () => computeMajorCycles({ birth, natal, count }),
      (e) => e instanceof MajorCycleError && e.code === 'INVALID_VALUE' && e.path === 'queries.majorCycles',
    );
  }
  assert.throws(
    () => computeMajorCycles({ birth: { timezone: 'UTC' }, natal, count: 1 }),
    (e) => e instanceof MajorCycleError && e.code === 'INVALID_INPUT' && e.path === 'birth',
  );
  // A calendar lookup failure propagates, never swallowed.
  assert.throws(
    () => computeMajorCycles({
      birth, natal, count: 1,
      calendar: {
        findSolarTerm() {
          throw new CalendarError('SOLAR_TERM_SEARCH_FAILED', 'birth.date', 'injected miss');
        },
      },
    }),
    (e) => e instanceof CalendarError && e.code === 'SOLAR_TERM_SEARCH_FAILED',
  );
});

test('reverse direction: unknown-time jie-day splits use the previous jie before T0', () => {
  // Yin-year female is forward; use a yin-year MALE (reverse) on the same
  // jie-day shape as the forward test above. Reverse pieces: t < T0 ->
  // 'previous' jie, t >= T0 -> 'current'.
  const T0 = ms('2023-03-10T12:00:00.000Z'); // 2023 癸卯 is a yin year
  const terms = {
    '2023-02': { termId: 'ipchun', ms: ms('2023-02-04T12:00:00Z') },
    '2023-03': { termId: 'gyeongchip', ms: T0 },
    '2023-04': { termId: 'cheongmyeong', ms: ms('2023-04-05T12:00:00Z') },
  };
  const natal = natalFor({
    date: { year: 2023, month: 3, day: 10 }, time: null, timezone: 'UTC', terms,
  });
  const r = computeMajorCycles({
    birth: { date: { year: 2023, month: 3, day: 10 }, timezone: 'UTC', gender: 'male' },
    natal, count: 1, calendar: stubCalendar(terms),
  });
  assert.equal(r.candidates.length, 2);
  const [before, after] = r.candidates;
  assert.equal(before.direction, 'reverse');
  assert.equal(after.direction, 'reverse');

  // 'before' candidate: interval [day start, T0+120s+1ms] splits at T0 into
  // a 'previous' piece (t < T0, distance back to the February ipchun jie)
  // and a 'current' piece (t >= T0, distance back to T0 itself).
  assert.equal(before.ranges.length, 2);
  const [bPrev, bCur] = before.ranges;
  assert.equal(bPrev.adjacentJie.role, 'previous');
  assert.equal(bPrev.adjacentJie.termId, 'ipchun');
  assert.equal(bPrev.birthInstants.startIso, '2023-03-10T00:00:00.000Z');
  assert.equal(bPrev.birthInstants.endMs, T0);
  assert.equal(bPrev.birthInstants.endInclusive, false);
  // Reverse distance: ipchun (Feb 4 12:00) -> birth. min at day start
  // (33d12h = 2894400 s), max supremum at T0 (34d = 2937600 s).
  assert.equal(bPrev.distance.minMs, 2894400000);
  assert.equal(bPrev.distance.maxMs, 2937600000);
  assert.equal(bCur.adjacentJie.role, 'current');
  assert.equal(bCur.adjacentJie.termId, 'gyeongchip');
  assert.equal(bCur.birthInstants.startMs, T0);
  assert.equal(bCur.birthInstants.startInclusive, true);
  assert.equal(bCur.distance.minMs, 0);
  assert.equal(bCur.distance.maxMs, 120001);

  // 'after' candidate: interval [T0-120s, day end) splits the same way.
  assert.equal(after.ranges.length, 2);
  const [aPrev, aCur] = after.ranges;
  assert.equal(aPrev.adjacentJie.role, 'previous');
  assert.equal(aPrev.adjacentJie.termId, 'ipchun');
  assert.equal(aPrev.birthInstants.startMs, T0 - 120000);
  assert.equal(aPrev.birthInstants.endMs, T0);
  assert.equal(aPrev.birthInstants.endInclusive, false);
  // ipchun -> birth: 34d-120s .. 34d supremum.
  assert.equal(aPrev.distance.minMs, 2937480000);
  assert.equal(aPrev.distance.maxMs, 2937600000);
  assert.equal(aCur.adjacentJie.role, 'current');
  assert.equal(aCur.distance.minMs, 0);
  assert.equal(aCur.distance.maxMs, 43200000); // T0 -> day end
});

test('output is deterministic: identical inputs give identical results', () => {
  const req = request('known');
  const birth = birthOf(req);
  const terms = {
    '1998-10': { termId: 'hallo', ms: ms('1998-10-08T17:00:00Z') },
    '1998-11': { termId: 'ipdong', ms: ms('1998-11-03T23:40:00Z') },
  };
  const natal = natalFor({
    date: birth.date,
    time: { hour: 20, minute: 40, second: 0 },
    timezone: birth.timezone,
    terms,
  });
  const a = computeMajorCycles({ birth, natal, count: 10, calendar: stubCalendar(terms) });
  const b = computeMajorCycles({ birth, natal, count: 10, calendar: stubCalendar(terms) });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
