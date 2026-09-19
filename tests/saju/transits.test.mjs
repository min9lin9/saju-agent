// transits.test.mjs — dated transit pillars, per-transit age, active
// major-cycle context and natal×transit relation deltas.
//
// Oracles, in order of authority:
//   literal hand-calculated values below   derived by hand from the plan's
//                                          stipulated policies (day pillar
//                                          from the 2000-01-07 = 甲子 epoch
//                                          via proleptic-Gregorian day
//                                          numbers; year/month pillars from
//                                          the stipulated Ipchun/jie rules;
//                                          ages from the civil-date rule) —
//                                          never from the runtime under test
//   injected jie facts                     stub calendars return fixed term
//                                          instants, so boundary sides and
//                                          cycle bounds are computed by hand
//   real ephemeris                         sanity tests assert structure and
//                                          independently derived values only
//
// No expected value is produced by running the code under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BEFORE_BIRTH_DATE,
  MAX_TRANSITS,
  TRANSIT_AGE_ANNIVERSARY_POLICY,
  TRANSIT_AGE_SYSTEM,
  TransitError,
  computeTransits,
} from '../../skills/saju/scripts/saju/transits.mjs';
import { deriveNatal } from '../../skills/saju/scripts/saju/natal.mjs';
import { computeMajorCycles } from '../../skills/saju/scripts/saju/major-cycles.mjs';
import { CalendarError } from '../../skills/saju/scripts/saju/calendar.mjs';

const ms = (iso) => Date.parse(iso);
const DAY = 86400 * 1000;

// A calendar stub keyed by 'YYYY-MM' returning injected term facts.
const stubCalendar = (terms) => ({
  findSolarTerm({ year, month }) {
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
});

const birthA = { date: { year: 1998, month: 10, day: 27 }, timezone: 'Asia/Seoul', gender: 'male' };
const natalA = () => deriveNatal({
  date: birthA.date,
  time: { hour: 20, minute: 40, second: 0 },
  timezone: birthA.timezone,
  utcOffset: '+09:00',
});

const pillarsOf = (item, k = 0) => item.pillarCandidates[k].pillars;
const ganZhi = (p) => p.ganZhi;

// --- transit pillars ---------------------------------------------------------

test('annual/monthly/daily pillars for a known instant in the birth zone', () => {
  // Hand-derived oracles for local date 2026-09-17 in Asia/Seoul:
  //   saju year 2026 (September is after Ipchun) -> (2026-4) mod 60 = 丙午
  //   month branch 酉 (September jie passed) -> stem 丁 -> 丁酉月
  //   day index (gdn(2026-09-17) - gdn(2000-01-07)) mod 60 = 30 -> 甲午
  const r = computeTransits({
    birth: birthA,
    targets: ['2026-09-17T12:00:00+09:00'],
  });
  assert.equal(r.transits.length, 1);
  const t = r.transits[0];
  assert.equal(t.index, 0);
  assert.equal(t.input, '2026-09-17T12:00:00+09:00');
  assert.equal(t.local.date, '2026-09-17');
  assert.equal(t.local.utcOffset, '+09:00');
  assert.equal(t.pillarCandidates.length, 1);
  assert.equal(t.pillarCandidates[0].uncertain, false);
  assert.equal(ganZhi(pillarsOf(t).annual), '丙午');
  assert.equal(ganZhi(pillarsOf(t).monthly), '丁酉');
  assert.equal(ganZhi(pillarsOf(t).daily), '甲午');
  assert.equal(pillarsOf(t).annual.id, 'transit.annual');
  assert.equal(pillarsOf(t).monthly.id, 'transit.monthly');
  assert.equal(pillarsOf(t).daily.id, 'transit.daily');
  assert.equal(r.limitations.length, 0);
});

test('same instant and zone give identical pillars for different natal charts', () => {
  const birthB = { date: { year: 2000, month: 2, day: 29 }, timezone: 'Asia/Seoul', gender: 'female' };
  const target = '2026-09-17T12:00:00+09:00';
  const a = computeTransits({ birth: birthA, targets: [target], natal: natalA() });
  const b = computeTransits({
    birth: birthB,
    targets: [target],
    natal: deriveNatal({
      date: birthB.date,
      time: { hour: 12, minute: 0, second: 0 },
      timezone: birthB.timezone,
    }),
  });
  // Shared pillars: transit pillars depend on instant+zone only.
  assert.deepEqual(
    a.transits[0].pillarCandidates.map((c) => c.pillars),
    b.transits[0].pillarCandidates.map((c) => c.pillars),
  );
  // Day stems differ (丁未 vs 丁巳 -> both 丁 day stem? no: 丁未 and 丁巳 share
  // stem 丁; use a third chart to force a different day stem).
  const birthC = { date: { year: 1990, month: 5, day: 15 }, timezone: 'Asia/Seoul', gender: 'male' };
  const c = computeTransits({
    birth: birthC,
    targets: [target],
    natal: deriveNatal({
      date: birthC.date,
      time: { hour: 12, minute: 0, second: 0 },
      timezone: birthC.timezone,
    }),
  });
  assert.deepEqual(
    a.transits[0].pillarCandidates.map((x) => x.pillars),
    c.transits[0].pillarCandidates.map((x) => x.pillars),
  );
  // 甲 (yang wood) vs day stem 丁 (yin fire): generating, opposite polarity -> 正印.
  // 甲 vs day stem 庚 (yang metal): controlled? wood is controlled BY metal, so
  // metal controls wood -> for day stem 庚, 甲 is 偏財 (controlled, same polarity).
  const godA = a.transits[0].contexts[0].pillars.daily.stemTenGod.hanzi;
  const godC = c.transits[0].contexts[0].pillars.daily.stemTenGod.hanzi;
  assert.equal(godA, '正印');
  assert.equal(godC, '偏財');
  assert.notEqual(godA, godC);
});

test('request order and duplicates are retained', () => {
  const r = computeTransits({
    birth: birthA,
    targets: [
      '2027-01-01T00:00:00Z',
      '2026-09-17T12:00:00+09:00',
      '2027-01-01T00:00:00Z',
    ],
  });
  assert.deepEqual(r.transits.map((t) => t.index), [0, 1, 2]);
  assert.deepEqual(
    r.transits.map((t) => t.input),
    ['2027-01-01T00:00:00Z', '2026-09-17T12:00:00+09:00', '2027-01-01T00:00:00Z'],
  );
  assert.equal(r.transits[0].local.date, '2027-01-01'); // 00:00Z = 09:00 Seoul
  assert.equal(r.transits[1].local.date, '2026-09-17');
});

test('civil-midnight rollover: local date, not UTC date, sets the day pillar', () => {
  // 2026-09-17T15:30:00Z is 2026-09-18 00:30 in Seoul -> day index 31 = 乙未.
  // The same UTC date an hour earlier (14:30Z) is still 23:30 on the 17th -> 甲午.
  const r = computeTransits({
    birth: birthA,
    targets: ['2026-09-17T14:30:00Z', '2026-09-17T15:30:00Z'],
  });
  assert.equal(r.transits[0].local.date, '2026-09-17');
  assert.equal(ganZhi(pillarsOf(r.transits[0]).daily), '甲午');
  assert.equal(r.transits[1].local.date, '2026-09-18');
  assert.equal(ganZhi(pillarsOf(r.transits[1]).daily), '乙未');
});

test('January belongs to the prior saju year; month follows the January jie', () => {
  // 2027-01-01 is before 小寒: saju year 2026 -> 丙午年, month 子 -> 庚子月.
  const r = computeTransits({ birth: birthA, targets: ['2027-01-01T00:00:00Z'] });
  assert.equal(ganZhi(pillarsOf(r.transits[0]).annual), '丙午');
  assert.equal(ganZhi(pillarsOf(r.transits[0]).monthly), '庚子');
  assert.equal(ganZhi(pillarsOf(r.transits[0]).daily), '庚辰');
});

test('jie boundary: before/after sides and the +/-120 s uncertainty band', () => {
  const T0 = ms('2026-02-04T04:00:00Z');
  const cal = stubCalendar({ '2026-02': { termId: 'ipchun', ms: T0 } });
  const target = (offsetMs) => new Date(T0 + offsetMs).toISOString();
  const r = computeTransits({
    birth: birthA,
    targets: [target(-121_000), target(-120_000), target(0), target(120_000), target(121_000)],
    calendar: cal,
  });
  const [before, edgeLo, exact, edgeHi, after] = r.transits;
  // Outside the band: single candidate on the correct side.
  assert.equal(before.pillarCandidates.length, 1);
  assert.equal(before.pillarCandidates[0].side, 'before');
  // Before Ipchun: saju year 2025 -> 乙巳年, month 丑 -> 己丑月.
  assert.equal(ganZhi(pillarsOf(before).annual), '乙巳');
  assert.equal(ganZhi(pillarsOf(before).monthly), '己丑');
  assert.equal(after.pillarCandidates.length, 1);
  assert.equal(after.pillarCandidates[0].side, 'after');
  // After Ipchun: saju year 2026 -> 丙午年, month 寅 -> 庚寅月.
  assert.equal(ganZhi(pillarsOf(after).annual), '丙午');
  assert.equal(ganZhi(pillarsOf(after).monthly), '庚寅');
  // Inside the band (inclusive at exactly +/-120 s and at the term): both.
  for (const t of [edgeLo, exact, edgeHi]) {
    assert.equal(t.pillarCandidates.length, 2);
    assert.deepEqual(t.pillarCandidates.map((c) => c.side), ['before', 'after']);
    assert.equal(t.pillarCandidates[0].uncertain, true);
  }
  assert.equal(
    r.limitations.filter((l) => l.code === 'SOLAR_TERM_UNCERTAINTY').length,
    3,
  );
  assert.deepEqual(
    r.limitations.map((l) => l.path),
    ['queries.transits[1]', 'queries.transits[2]', 'queries.transits[3]'],
  );
});

// --- per-transit age -----------------------------------------------------------

test('age: Feb 29 birth increments on March 1 in non-leap years', () => {
  const birth = { date: { year: 2000, month: 2, day: 29 }, timezone: 'Asia/Seoul' };
  const r = computeTransits({
    birth,
    targets: ['2023-02-28T12:00:00+09:00', '2023-03-01T00:00:00+09:00'],
  });
  const [feb28, mar1] = r.transits;
  assert.equal(feb28.age.system, TRANSIT_AGE_SYSTEM);
  assert.equal(feb28.age.anniversaryPolicy, TRANSIT_AGE_ANNIVERSARY_POLICY);
  assert.equal(feb28.age.asOfDate, '2023-02-28');
  assert.equal(feb28.age.timezone, 'Asia/Seoul');
  assert.equal(feb28.age.years, 22);
  assert.equal(feb28.age.reason, null);
  assert.equal(mar1.age.years, 23); // the March-1 anniversary, from 00:00 local
  assert.equal(mar1.age.reason, null);
});

test('age counts from the civil date, independent of birth clock time', () => {
  // Birth time is not an input to computeTransits; the same birth date with a
  // target on the birthday at 00:00 local already yields the incremented age.
  const birth = { date: { year: 2000, month: 2, day: 29 }, timezone: 'Asia/Seoul' };
  const r = computeTransits({
    birth,
    targets: ['2024-02-29T00:00:00+09:00', '2024-02-28T23:59:59+09:00'],
  });
  assert.equal(r.transits[0].age.years, 24); // leap year: real Feb 29 anniversary
  assert.equal(r.transits[1].age.years, 23);
});

test('age: before the solar birth date yields null with BEFORE_BIRTH_DATE', () => {
  const r = computeTransits({
    birth: birthA,
    targets: ['1998-10-26T23:59:59+09:00', '1998-10-27T00:00:00+09:00'],
  });
  assert.equal(r.transits[0].age.years, null);
  assert.equal(r.transits[0].age.reason, BEFORE_BIRTH_DATE);
  assert.equal(r.transits[1].age.years, 0); // birth date itself: age 0, not before
  assert.equal(r.transits[1].age.reason, null);
});

// --- active major-cycle context --------------------------------------------------

// Injected jie facts for the cycle tests: birth 1998-10-27 20:40 Seoul =
// 11:40Z; the October jie is fixed at 1998-10-08T12:00:00Z and November's at
// 1998-11-07T12:00:00Z. Forward distance to the next jie is 951,600 s =
// 3y 8m 1d 16h nominal, so cycle 0 starts 2002-06-29T03:40:00Z and cycle 1
// starts 2012-06-29T03:40:00Z (Seoul walls, no DST).
const CYCLE_TERMS = {
  '1998-10': { termId: 'hanlu', ms: ms('1998-10-08T12:00:00Z') },
  '1998-11': { termId: 'lidong', ms: ms('1998-11-07T12:00:00Z') },
};
const CYCLE_START_0 = ms('2002-06-29T03:40:00Z');
const CYCLE_START_1 = ms('2012-06-29T03:40:00Z');

const cyclesForBirthA = () => computeMajorCycles({
  birth: birthA,
  natal: natalA(),
  count: 3,
  calendar: stubCalendar(CYCLE_TERMS),
});

test('active major cycle: determinate membership and boundary equality', () => {
  const majorCycles = cyclesForBirthA();
  const r = computeTransits({
    birth: birthA,
    targets: [
      new Date(CYCLE_START_0 - 1).toISOString(), // before cycle 0
      new Date(CYCLE_START_0).toISOString(),     // exactly at start -> cycle 0
      new Date(CYCLE_START_1 - 1).toISOString(), // last ms of cycle 0
      new Date(CYCLE_START_1).toISOString(),     // end-exclusive -> cycle 1
    ],
    natal: natalA(),
    majorCycles,
  });
  const [pre, atStart, lastOf0, atNext] = r.transits.map((t) => t.contexts[0].activeMajorCycle);
  assert.equal(pre.status, 'none');
  assert.equal(pre.id, null);
  assert.equal(atStart.status, 'determinate');
  assert.equal(atStart.id, 'major.0');
  assert.equal(lastOf0.status, 'determinate');
  assert.equal(lastOf0.id, 'major.0');
  assert.equal(atNext.status, 'determinate');
  assert.equal(atNext.id, 'major.1');
});

test('active major cycle: ambiguous membership returns candidate contexts', () => {
  // Unknown birth time widens the cycle bounds to the whole local day, so the
  // {earliest,latest} bands of adjacent cycles overlap for ~4 months; an
  // instant inside the overlap is a possible member of both cycles.
  const birth = { date: { year: 1998, month: 10, day: 27 }, timezone: 'Asia/Seoul', gender: 'male' };
  const natal = deriveNatal({ date: birth.date, time: null, timezone: birth.timezone });
  const majorCycles = computeMajorCycles({
    birth,
    natal,
    count: 3,
    calendar: stubCalendar(CYCLE_TERMS),
  });
  // Unknown-time bounds: start earliest 2002-06-11T15:00Z, latest
  // 2002-10-11T15:00Z; cycle ends shift +10 local years, so the possible
  // bands of major.0 and major.1 overlap in [2012-06-11T15:00Z,
  // 2012-10-11T15:00Z). 2012-08-01 is inside the overlap.
  const r = computeTransits({
    birth,
    targets: ['2012-08-01T00:00:00+09:00'],
    natal,
    majorCycles,
  });
  const ctx = r.transits[0].contexts[0].activeMajorCycle;
  assert.equal(ctx.status, 'ambiguous');
  assert.equal(ctx.id, null);
  assert.deepEqual(ctx.candidateCycleIds, ['major.0', 'major.1']);
  // Both possible cycles contribute occurrences to the relation pass; no
  // record may span two distinct major.* ids (they never co-occur).
  const rels = r.transits[0].contexts[0].relations;
  for (const rec of rels) {
    const majors = new Set(rec.occurrenceIds.filter((id) => id.startsWith('major.')));
    assert.ok(majors.size <= 1, `record spans cycles: ${JSON.stringify(rec)}`);
  }
  // Guaranteed by the rule tables for this chart: natal year 寅 x major.0 亥
  // is a 寅亥 liuhe; natal day 未 x major.1 子 is a 子未 harm/wonjin.
  assert.ok(rels.some((rec) => rec.occurrenceIds.some((id) => id === 'major.0')));
  assert.ok(rels.some((rec) => rec.occurrenceIds.some((id) => id === 'major.1')));
});

test('active major cycle: not requested and unavailable are distinguished', () => {
  const natal = natalA();
  const none = computeTransits({
    birth: birthA,
    targets: ['2026-09-17T12:00:00+09:00'],
    natal,
  });
  assert.equal(none.transits[0].contexts[0].activeMajorCycle.status, 'not_requested');
  const zero = computeTransits({
    birth: birthA,
    targets: ['2026-09-17T12:00:00+09:00'],
    natal,
    majorCycles: computeMajorCycles({ birth: birthA, natal, count: 0 }),
  });
  assert.equal(zero.transits[0].contexts[0].activeMajorCycle.status, 'not_requested');
  const missingGender = computeTransits({
    birth: { date: birthA.date, timezone: birthA.timezone },
    targets: ['2026-09-17T12:00:00+09:00'],
    natal,
    majorCycles: computeMajorCycles({
      birth: { date: birthA.date, timezone: birthA.timezone, gender: null },
      natal,
      count: 3,
      calendar: stubCalendar(CYCLE_TERMS),
    }),
  });
  assert.equal(missingGender.transits[0].contexts[0].activeMajorCycle.status, 'unavailable');
});

// --- relation delta --------------------------------------------------------------

test('relation delta: natal-only records excluded, transit activations kept', () => {
  // Birth 1998-01-05 (before Ipchun -> 丁丑 year): day 壬子. The natal chart
  // contains the 子丑 liuhe between year branch 丑 and day branch 子 — a
  // natal-only record that must NOT appear in the transit delta.
  // Transit 2026-09-17 daily 甲午: 午 clashes natal day 子 and harms natal
  // year 丑 — both must appear with natal+transit sources.
  const birth = { date: { year: 1998, month: 1, day: 5 }, timezone: 'Asia/Seoul' };
  const natal = deriveNatal({
    date: birth.date,
    time: { hour: 12, minute: 0, second: 0 },
    timezone: birth.timezone,
  });
  const natalOnlyIds = new Set(
    natal.candidates[0].relations.map((r) => `${r.ruleId}|${r.occurrenceIds.join(',')}`),
  );
  assert.ok(natal.candidates[0].relations.some(
    (r) => r.ruleId === 'branch_liuhe'
      && r.occurrenceIds.includes('natal.year')
      && r.occurrenceIds.includes('natal.day'),
  ));
  const r = computeTransits({
    birth,
    targets: ['2026-09-17T12:00:00+09:00'],
    natal,
  });
  const rels = r.transits[0].contexts[0].relations;
  // No record is natal-only.
  for (const rec of rels) {
    assert.ok(
      !(rec.sources.length === 1 && rec.sources[0] === 'natal'),
      `natal-only record leaked: ${JSON.stringify(rec)}`,
    );
    assert.ok(rec.sources.includes('transit') || rec.sources.includes('major'));
  }
  // The natal 子丑 liuhe is absent from the delta.
  assert.ok(!rels.some(
    (rec) => rec.ruleId === 'branch_liuhe'
      && rec.occurrenceIds.includes('natal.year')
      && rec.occurrenceIds.includes('natal.day')
      && rec.occurrenceIds.length === 2,
  ));
  // 子午 clash between natal day and transit daily is present and source-tagged.
  const clash = rels.find(
    (rec) => rec.ruleId === 'branch_clash'
      && rec.occurrenceIds.includes('natal.day')
      && rec.occurrenceIds.includes('transit.daily'),
  );
  assert.ok(clash, 'expected natal.day x transit.daily 子午 clash');
  assert.deepEqual(clash.sources, ['natal', 'transit']);
  // 丑午 harm between natal year and transit daily likewise.
  const harm = rels.find(
    (rec) => rec.ruleId === 'branch_harm'
      && rec.occurrenceIds.includes('natal.year')
      && rec.occurrenceIds.includes('transit.daily'),
  );
  assert.ok(harm, 'expected natal.year x transit.daily 丑午 harm');
  assert.deepEqual(harm.sources, ['natal', 'transit']);
});

test('relation delta: transit-internal relations are kept with transit source', () => {
  // 2026-09-17: annual 丙午 and daily 甲午 share branch 午 -> self-punishment
  // pair among transit occurrences only.
  const r = computeTransits({
    birth: birthA,
    targets: ['2026-09-17T12:00:00+09:00'],
    natal: natalA(),
  });
  const rels = r.transits[0].contexts[0].relations;
  const selfPun = rels.find(
    (rec) => rec.ruleId === 'punishment'
      && rec.subtype === 'self'
      && rec.occurrenceIds.includes('transit.annual')
      && rec.occurrenceIds.includes('transit.daily'),
  );
  assert.ok(selfPun, 'expected transit.annual x transit.daily self-punishment');
  assert.deepEqual(selfPun.sources, ['transit']);
});

// --- input contract --------------------------------------------------------------

test('malformed and offset-less targets are rejected', () => {
  for (const bad of ['2026-09-17T12:00:00', 'not-a-date', '2026-02-30T12:00:00Z', 42, null]) {
    assert.throws(
      () => computeTransits({ birth: birthA, targets: [bad] }),
      (e) => e instanceof TransitError && e.code === 'INVALID_TRANSIT',
      `expected INVALID_TRANSIT for ${JSON.stringify(bad)}`,
    );
  }
  // -00:00 carries no usable offset per RFC3339.
  assert.throws(
    () => computeTransits({ birth: birthA, targets: ['2026-09-17T12:00:00-00:00'] }),
    (e) => e.code === 'INVALID_TRANSIT',
  );
});

test('more than 366 targets are rejected', () => {
  const targets = Array.from(
    { length: MAX_TRANSITS + 1 },
    (_, i) => `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00Z`,
  );
  assert.throws(
    () => computeTransits({ birth: birthA, targets }),
    (e) => e instanceof TransitError && e.code === 'TOO_MANY_TRANSITS',
  );
});

test('target outside the declared solar range in the birth zone is rejected', () => {
  assert.throws(
    () => computeTransits({ birth: birthA, targets: ['2101-01-01T00:00:00+09:00'] }),
    (e) => e.code === 'TRANSIT_OUT_OF_RANGE',
  );
  assert.throws(
    () => computeTransits({ birth: birthA, targets: ['1899-12-31T23:00:00+09:00'] }),
    (e) => e.code === 'TRANSIT_OUT_OF_RANGE',
  );
});

test('invalid birth input is rejected', () => {
  assert.throws(
    () => computeTransits({ birth: { date: { year: 1998, month: 10, day: 27 } }, targets: [] }),
    (e) => e instanceof TransitError && e.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => computeTransits({
      birth: { date: { year: 1998, month: 2, day: 30 }, timezone: 'Asia/Seoul' },
      targets: [],
    }),
    (e) => e.code === 'INVALID_INPUT',
  );
});

test('Feb-29 target instants are not shifted a day (utcMs leap-base regression)', () => {
  // Regression: utcMs built on Date.UTC(0,...) mapped year 0 to 1900 (non-leap),
  // rolling Feb 29 to Mar 1 before setUTCFullYear ran — every RFC3339 Feb-29
  // target arrived +1 day (wrong local date, day pillar, asOfDate and age).
  const birth = { date: { year: 2000, month: 2, day: 29 }, timezone: 'Asia/Seoul' };
  const r = computeTransits({
    birth,
    targets: ['2024-02-29T12:00:00+09:00', '2024-02-29T00:00:00+09:00'],
  });
  const [noon, midnight] = r.transits;
  assert.equal(noon.instantMs, ms('2024-02-29T03:00:00Z'));
  assert.equal(noon.local.date, '2024-02-29');
  // Day index (gdn(2024-02-29) - gdn(2000-01-07)) mod 60 = 59 -> 癸亥.
  assert.equal(ganZhi(pillarsOf(noon).daily), '癸亥');
  assert.equal(noon.age.asOfDate, '2024-02-29');
  assert.equal(noon.age.years, 24);
  assert.equal(midnight.local.date, '2024-02-29');
  assert.equal(midnight.age.years, 24); // birthday civil date starts at 00:00
});

test('normalized Feb-29 target objects keep a real zone offset', () => {
  // Regression companion: the shifted instant produced a bogus '+33:00'
  // utcOffset for normalized-object targets.
  const r = computeTransits({
    birth: { date: { year: 2000, month: 2, day: 29 }, timezone: 'Asia/Seoul' },
    targets: [{ text: '2024-02-29T12:00:00+09:00', instantMs: ms('2024-02-29T03:00:00Z'), offsetSeconds: 32400 }],
  });
  assert.equal(r.transits[0].local.utcOffset, '+09:00');
  assert.equal(r.transits[0].local.date, '2024-02-29');
});

test('normalized target objects from input.mjs are accepted', () => {
  const r = computeTransits({
    birth: birthA,
    targets: [
      { text: '2026-09-17T12:00:00+09:00', instantMs: ms('2026-09-17T03:00:00Z'), offsetSeconds: 32400 },
    ],
  });
  assert.equal(r.transits[0].input, '2026-09-17T12:00:00+09:00');
  assert.equal(ganZhi(pillarsOf(r.transits[0]).daily), '甲午');
});

test('empty target list yields empty transits', () => {
  const r = computeTransits({ birth: birthA, targets: [] });
  assert.deepEqual(r.transits, []);
  assert.deepEqual(r.limitations, []);
});
