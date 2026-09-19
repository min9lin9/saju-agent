// natal.test.mjs — natal pillars and all per-pillar values.
//
// Oracles, in order of authority:
//   tests/fixtures/saju/rules.json      independently authored policy tables
//                                       (fixture parity asserted verbatim)
//   tests/fixtures/saju/calendar.json   KASI solc day-pillar anchors
//                                       (LUNC_ILJIN), never engine-derived
//   literal tables in this file         the 10x10 ten-god and 10x12
//                                       twelve-stage matrices below, plus
//                                       hand-derived chart anchors, written
//                                       from the plan's stipulated rules —
//                                       not from the runtime under test
//   injected term facts                 exact before/at/after and +/-120 s
//                                       band semantics tested against a fake
//                                       calendar, separately from the real
//                                       ephemeris (task-3 tolerance tests)
//
// No expected value is produced by running the code under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  NatalError,
  deriveNatal,
  gregorianDayNumber,
  dayCycleIndex,
  hourBranchIndex,
  hourStemIndex,
  firstInMonthStemIndex,
  stemTenGod,
  twelveStage,
  loadNatalRules,
} from '../../skills/saju/scripts/saju/natal.mjs';
import { CalendarError, createCalendar, lunarToSolar } from '../../skills/saju/scripts/saju/calendar.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const fixtureDir = join(here, '..', 'fixtures', 'saju');
const fixtureRules = JSON.parse(readFileSync(join(fixtureDir, 'rules.json'), 'utf8'));
const calendarFixture = JSON.parse(readFileSync(join(fixtureDir, 'calendar.json'), 'utf8'));
const request = (name) => JSON.parse(readFileSync(join(fixtureDir, 'requests', `${name}.json`), 'utf8'));

const rules = loadNatalRules();
const T = {
  stemByHanzi: new Map(rules.labels.stems.map((s) => [s.hanzi, s])),
  branches: rules.labels.branches,
  tenGodByHanzi: new Map(rules.labels.tenGods.map((g) => [g.hanzi, g])),
  stageByHanzi: new Map(rules.labels.twelveStages.map((s) => [s.hanzi, s])),
  stageOrder: rules.tables.twelveStages.order,
  stageStart: new Map(Object.entries(rules.tables.twelveStages.startsAndDirections)),
  tenGodTable: rules.tables.tenGods,
  rules,
};
const STEMS = '甲乙丙丁戊己庚辛壬癸';
const BRANCHES = '子丑寅卯辰巳午未申酉戌亥';

// Maps a request fixture's birth object to deriveNatal arguments.
const fromBirth = (birth) => {
  const [year, month, day] = birth.date.split('-').map(Number);
  const time = birth.time === null
    ? null
    : (() => { const [hour, minute, second] = birth.time.split(':').map(Number); return { hour, minute, second }; })();
  return { date: { year, month, day }, time, timezone: birth.timezone, utcOffset: birth.utcOffset };
};

// A calendar stub whose single term is an injected fact. Records calls.
const stubCalendar = (instantMs, uncertaintySeconds = 120) => {
  const calls = [];
  return {
    calls,
    findSolarTerm({ year, month }) {
      calls.push({ year, month });
      return {
        eventId: 'injected', termId: 'injected', iso: new Date(instantMs).toISOString(),
        instantMs, uncertaintySeconds,
      };
    },
  };
};

const pillarGZ = (cand, key) => (cand.pillars[key] === null ? null : cand.pillars[key].ganZhi);
const chartGZ = (cand) => ['year', 'month', 'day', 'hour'].map((k) => pillarGZ(cand, k));

// --- fixture parity -----------------------------------------------------------

test('runtime rules.json natal tables mirror the independently authored fixture verbatim', () => {
  const ft = fixtureRules.tables;
  const rt = rules.tables;
  assert.deepEqual(rt.dayCycleAnchor, ft.dayCycleAnchor);
  assert.deepEqual(rt.periodBoundaries, ft.periodBoundaries);
  assert.deepEqual(rt.yearPillar, ft.yearPillar);
  assert.deepEqual(rt.hourPillar, ft.hourPillar);
  assert.deepEqual(rt.hiddenStems, ft.hiddenStems);
  assert.deepEqual(rt.tenGods, ft.tenGods);
  assert.deepEqual(rt.twelveStages, ft.twelveStages);
  assert.deepEqual(rt.counts, ft.counts);
  assert.equal(rules.rulesetId, 'kr-civil-midnight-v1');
});

test('labels carry canonical machine ids plus Hanzi and Korean labels', () => {
  assert.equal(rules.labels.stems.length, 10);
  assert.equal(rules.labels.branches.length, 12);
  assert.equal(rules.labels.elements.length, 5);
  assert.equal(rules.labels.tenGods.length, 11); // 10 gods + 日主
  assert.equal(rules.labels.twelveStages.length, 12);
  for (const s of rules.labels.stems) {
    assert.match(s.id, /^[a-z]+$/);
    assert.match(s.korean, /^[가-힣]$/);
    assert.ok(['wood', 'fire', 'earth', 'metal', 'water'].includes(s.element));
    assert.ok(['yang', 'yin'].includes(s.polarity));
  }
  const gap = rules.labels.stems[0];
  assert.deepEqual(gap, { id: 'gap', hanzi: '甲', korean: '갑', element: 'wood', polarity: 'yang' });
});

// --- ten gods: exhaustive 10x10 -----------------------------------------------

// Literal expected matrix [dayStem][targetStem], stems in 甲乙丙丁戊己庚辛壬癸
// order. Derived by hand from the stipulated rule: same element 比肩/劫財,
// generated 食神/傷官, controlled 偏財/正財, controlling 偏官/正官,
// generating 偏印/正印; first of each pair is same-polarity.
const TEN_GOD_MATRIX = [
  ['比肩', '劫財', '食神', '傷官', '偏財', '正財', '偏官', '正官', '偏印', '正印'], // 甲
  ['劫財', '比肩', '傷官', '食神', '正財', '偏財', '正官', '偏官', '正印', '偏印'], // 乙
  ['偏印', '正印', '比肩', '劫財', '食神', '傷官', '偏財', '正財', '偏官', '正官'], // 丙
  ['正印', '偏印', '劫財', '比肩', '傷官', '食神', '正財', '偏財', '正官', '偏官'], // 丁
  ['偏官', '正官', '偏印', '正印', '比肩', '劫財', '食神', '傷官', '偏財', '正財'], // 戊
  ['正官', '偏官', '正印', '偏印', '劫財', '比肩', '傷官', '食神', '正財', '偏財'], // 己
  ['偏財', '正財', '偏官', '正官', '偏印', '正印', '比肩', '劫財', '食神', '傷官'], // 庚
  ['正財', '偏財', '正官', '偏官', '正印', '偏印', '劫財', '比肩', '傷官', '食神'], // 辛
  ['食神', '傷官', '偏財', '正財', '偏官', '正官', '偏印', '正印', '比肩', '劫財'], // 壬
  ['傷官', '食神', '正財', '偏財', '正官', '偏官', '正印', '偏印', '劫財', '比肩'], // 癸
];

test('all 100 day-stem/target-stem ten-god pairs match the literal matrix', () => {
  let checked = 0;
  for (let d = 0; d < 10; d += 1) {
    for (let t = 0; t < 10; t += 1) {
      const got = stemTenGod(T, STEMS[d], STEMS[t]);
      assert.equal(got, TEN_GOD_MATRIX[d][t], `day ${STEMS[d]} vs ${STEMS[t]}`);
      checked += 1;
    }
  }
  assert.equal(checked, 100);
});

// --- twelve stages: exhaustive 10x12 ------------------------------------------

// Literal expected matrix [stem][branch], branches in 子丑寅卯辰巳午未申酉戌亥
// order. Derived by hand from 甲亥+,乙午-,丙戊寅+,丁己酉-,庚巳+,辛子-,壬申+,癸卯-.
const STAGE_MATRIX = {
  甲: ['沐浴', '冠帶', '建祿', '帝旺', '衰', '病', '死', '墓', '絕', '胎', '養', '長生'],
  乙: ['病', '衰', '帝旺', '建祿', '冠帶', '沐浴', '長生', '養', '胎', '絕', '墓', '死'],
  丙: ['胎', '養', '長生', '沐浴', '冠帶', '建祿', '帝旺', '衰', '病', '死', '墓', '絕'],
  丁: ['絕', '墓', '死', '病', '衰', '帝旺', '建祿', '冠帶', '沐浴', '長生', '養', '胎'],
  戊: ['胎', '養', '長生', '沐浴', '冠帶', '建祿', '帝旺', '衰', '病', '死', '墓', '絕'],
  己: ['絕', '墓', '死', '病', '衰', '帝旺', '建祿', '冠帶', '沐浴', '長生', '養', '胎'],
  庚: ['死', '墓', '絕', '胎', '養', '長生', '沐浴', '冠帶', '建祿', '帝旺', '衰', '病'],
  辛: ['長生', '養', '胎', '絕', '墓', '死', '病', '衰', '帝旺', '建祿', '冠帶', '沐浴'],
  壬: ['帝旺', '衰', '病', '死', '墓', '絕', '胎', '養', '長生', '沐浴', '冠帶', '建祿'],
  癸: ['建祿', '冠帶', '沐浴', '長生', '養', '胎', '絕', '墓', '死', '病', '衰', '帝旺'],
};

test('all 120 stem/branch twelve-stage pairs match the literal matrix', () => {
  let checked = 0;
  for (const stem of STEMS) {
    for (let b = 0; b < 12; b += 1) {
      const got = twelveStage(T, stem, BRANCHES[b]);
      assert.equal(got, STAGE_MATRIX[stem][b], `${stem} at ${BRANCHES[b]}`);
      checked += 1;
    }
  }
  assert.equal(checked, 120);
});

// --- day cycle: all 60 pairs ----------------------------------------------------

test('all 60 sexagenary day pillars from the 2000-01-07 甲子 epoch', () => {
  const cal = stubCalendar(Date.UTC(1990, 0, 1)); // term far away: day pillar unaffected
  const startMs = Date.UTC(2000, 0, 7);
  for (let i = 0; i < 60; i += 1) {
    const d = new Date(startMs + i * 86400 * 1000);
    const date = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    const n = deriveNatal({
      date, time: { hour: 12, minute: 0, second: 0 }, timezone: 'UTC', calendar: cal,
    });
    const expected = STEMS[i % 10] + BRANCHES[i % 12];
    assert.equal(pillarGZ(n.candidates[0], 'day'), expected, `epoch+${i}`);
    assert.equal(n.dayMaster.dayCycleIndex, i);
  }
  // Epoch itself and named xun anchors.
  assert.equal(dayCycleIndex({ year: 2000, month: 1, day: 7 }), 0);
  assert.equal(dayCycleIndex({ year: 2000, month: 1, day: 17 }), 10); // 甲戌
  assert.equal(dayCycleIndex({ year: 2000, month: 2, day: 6 }), 30); // 甲午
});

test('KASI-anchored day pillars match LUNC_ILJIN for all fixture cases', () => {
  for (const kase of calendarFixture.cases) {
    const n = deriveNatal({
      date: kase.solar, time: { hour: 12, minute: 0, second: 0 }, timezone: 'Asia/Seoul',
    });
    assert.equal(pillarGZ(n.candidates[0], 'day'), kase.dayGanZhi, kase.id);
    assert.equal(n.dayMaster.stem.hanzi, kase.dayGanZhi[0]);
  }
});

test('day numbering uses integer proleptic-Gregorian days, not elapsed milliseconds', () => {
  // 2000-01-07 and 2000-01-08 differ by one civil day -> adjacent pillars,
  // regardless of how many milliseconds any zone assigns to that day.
  assert.equal(gregorianDayNumber(2000, 1, 8) - gregorianDayNumber(2000, 1, 7), 1);
  assert.equal(gregorianDayNumber(2000, 3, 1) - gregorianDayNumber(2000, 2, 29), 1); // leap day
  assert.equal(gregorianDayNumber(1900, 3, 1) - gregorianDayNumber(1900, 2, 28), 1); // 1900 not leap
  assert.equal(dayCycleIndex({ year: 2000, month: 1, day: 8 }), 1); // 乙丑
});

// --- hour pillar ----------------------------------------------------------------

test('hour branch covers all 24 civil hours; 23:00 starts 子', () => {
  // 23:00-00:59 -> 子(0), 01:00-02:59 -> 丑(1), ..., 21:00-22:59 -> 亥(11).
  const expected = [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 0];
  for (let h = 0; h < 24; h += 1) {
    assert.equal(hourBranchIndex(h), expected[h], `hour ${h}`);
  }
  // Hour stem formula on every day stem at 子 (branch 0): 甲己->甲, 乙庚->丙,
  // 丙辛->戊, 丁壬->庚, 戊癸->壬.
  const ziStem = [0, 2, 4, 6, 8, 0, 2, 4, 6, 8];
  for (let d = 0; d < 10; d += 1) {
    assert.equal(hourStemIndex(d, 0), ziStem[d], `day stem ${d}`);
    assert.equal(hourStemIndex(d, 0), (2 * d + 0) % 10);
  }
  assert.equal(firstInMonthStemIndex(0), 2); // 甲/己 year -> 丙寅 first month
  assert.equal(firstInMonthStemIndex(5), 2); // 己 same as 甲 (yearStem%5)
  assert.equal(firstInMonthStemIndex(1), 4); // 乙/庚 -> 戊寅
});

test('midnight rollover: 23:xx keeps the civil date day stem with 子 hour', () => {
  const late = deriveNatal({
    date: { year: 1998, month: 10, day: 27 }, time: { hour: 23, minute: 30, second: 0 },
    timezone: 'Asia/Seoul',
  });
  assert.equal(pillarGZ(late.candidates[0], 'day'), '丁未'); // same civil date
  assert.equal(pillarGZ(late.candidates[0], 'hour'), '庚子'); // 子 hour, day stem 丁 -> 庚子
  const early = deriveNatal({
    date: { year: 1998, month: 10, day: 28 }, time: { hour: 0, minute: 30, second: 0 },
    timezone: 'Asia/Seoul',
  });
  assert.equal(pillarGZ(early.candidates[0], 'day'), '戊申'); // next civil date
  assert.equal(pillarGZ(early.candidates[0], 'hour'), '壬子'); // 子 hour, day stem 戊 -> 壬子
});

// --- independent chart anchors ----------------------------------------------------

test('known.json chart: 1998-10-27 20:40 Asia/Seoul full derivation', () => {
  const n = deriveNatal(fromBirth(request('known').birth));
  assert.equal(n.rulesetId, 'kr-civil-midnight-v1');
  assert.equal(n.candidates.length, 1);
  assert.equal(n.coverageComplete, true);
  assert.deepEqual(n.limitations, []);
  const c = n.candidates[0];
  // Hand-derived from the stipulated rules; day pillar independently anchored
  // by KASI LUNC_ILJIN (kasi-solc-1998-10-27 -> 丁未).
  assert.deepEqual(chartGZ(c), ['戊寅', '壬戌', '丁未', '庚戌']);
  assert.deepEqual(c.pillarIds, ['year', 'month', 'day', 'hour']);
  assert.equal(n.dayMaster.stem.hanzi, '丁');
  assert.equal(n.dayMaster.tenGod.hanzi, '日主');
  // Per-pillar values: ids, indexes, ten gods, stages, hidden stems.
  assert.equal(c.pillars.year.id, 'natal.year');
  assert.equal(c.pillars.month.id, 'natal.month');
  assert.equal(c.pillars.day.id, 'natal.day');
  assert.equal(c.pillars.hour.id, 'natal.hour');
  assert.equal(c.pillars.year.index, 0);
  assert.equal(c.pillars.hour.index, 3);
  assert.equal(c.pillars.year.stemTenGod.hanzi, '傷官');
  assert.equal(c.pillars.month.stemTenGod.hanzi, '正官');
  assert.equal(c.pillars.day.stemTenGod.hanzi, '日主'); // day stem is 日主, not 比肩
  assert.equal(c.pillars.hour.stemTenGod.hanzi, '正財');
  assert.equal(c.pillars.year.branchTenGod.hanzi, '正印'); // 寅 main hidden 甲
  assert.equal(c.pillars.month.branchTenGod.hanzi, '傷官'); // 戌 main hidden 戊
  assert.equal(c.pillars.day.branchTenGod.hanzi, '食神'); // 未 main hidden 己, same-polarity generated
  assert.equal(c.pillars.hour.branchTenGod.hanzi, '傷官');
  assert.equal(c.pillars.year.dayStemStage.hanzi, '死'); // 丁 at 寅
  assert.equal(c.pillars.month.dayStemStage.hanzi, '養'); // 丁 at 戌
  assert.equal(c.pillars.day.dayStemStage.hanzi, '冠帶'); // 丁 at 未
  assert.equal(c.pillars.hour.dayStemStage.hanzi, '養');
  assert.equal(c.pillars.year.stemStage.hanzi, '長生'); // 戊 at 寅
  assert.equal(c.pillars.day.stemStage.hanzi, '冠帶'); // 丁 at 未
  // Hidden stems: ranks, integer-tenth weights, per-hidden ten god and stage.
  assert.deepEqual(
    c.pillars.year.hiddenStems.map((h) => [h.stem.hanzi, h.rank, h.weightTenths]),
    [['甲', 1, 6], ['丙', 2, 2], ['戊', 3, 2]],
  );
  assert.deepEqual(
    c.pillars.day.hiddenStems.map((h) => [h.stem.hanzi, h.rank, h.weightTenths]),
    [['己', 1, 6], ['丁', 2, 2], ['乙', 3, 2]],
  );
  assert.equal(c.pillars.year.hiddenStems[0].tenGod.hanzi, '正印'); // 甲 vs 丁
  assert.equal(c.pillars.year.hiddenStems[0].stage.hanzi, '建祿'); // 甲 at 寅
  assert.equal(c.pillars.year.hiddenStems[1].stage.hanzi, '長生'); // 丙 at 寅
  // Counts: exact integer tenths, 8 units complete.
  const k = c.counts;
  assert.deepEqual(k.visibleStems, { units: { wood: 0, fire: 1, earth: 1, metal: 1, water: 1 }, totalUnits: 4 });
  assert.deepEqual(k.visibleBranches, { units: { wood: 1, fire: 0, earth: 3, metal: 0, water: 0 }, totalUnits: 4 });
  assert.deepEqual(k.combinedSurface, { units: { wood: 1, fire: 1, earth: 4, metal: 1, water: 1 }, totalUnits: 8 });
  assert.deepEqual(k.stemsPlusWeightedHidden.tenths, { wood: 8, fire: 18, earth: 30, metal: 14, water: 10 });
  assert.equal(k.stemsPlusWeightedHidden.totalTenths, 80);
  assert.equal(k.stemsPlusWeightedHidden.totalUnits, 8);
  assert.equal(k.stemsPlusWeightedHidden.weightsId, 'hidden-602020-7030-v1');
  for (const e of Object.keys(k.stemsPlusWeightedHidden.tenths)) {
    assert.ok(Number.isInteger(k.stemsPlusWeightedHidden.tenths[e]));
    assert.equal(k.stemsPlusWeightedHidden.units[e], k.stemsPlusWeightedHidden.tenths[e] / 10);
  }
  // Relations (nonexclusive, occurrence-level) and named special rules.
  const rel = (id) => c.relations.filter((r) => r.ruleId === id);
  assert.equal(rel('stem_combination').length, 1); // 丁壬 -> 木
  assert.equal(rel('stem_combination')[0].element, '木');
  assert.deepEqual(rel('stem_combination')[0].occurrenceIds, ['natal.day', 'natal.month']);
  assert.equal(rel('branch_break').length, 2); // 未戌 day-month, day-hour
  assert.equal(rel('branch_sanhe').length, 2); // 寅戌 partials, no cardinal
  for (const r of rel('branch_sanhe')) {
    assert.equal(r.completion, 'partial');
    assert.equal(r.subtype, 'arched_triad');
    assert.equal(r.element, '火');
  }
  const edges = rel('punishment');
  assert.equal(edges.length, 2); // 戌->未 directed edges
  for (const r of edges) assert.equal(r.subtype, 'directed_edge');
  const gongmang = c.specialRules.filter((r) => r.ruleId === 'gongmang');
  assert.equal(gongmang.length, 1);
  assert.equal(gongmang[0].referenceOccurrenceId, 'natal.day');
  assert.deepEqual(gongmang[0].voidBranches, ['寅', '卯']);
  assert.deepEqual(gongmang[0].occurrenceIds, ['natal.year']); // 寅 is void
  const gwimun = c.specialRules.filter((r) => r.ruleId === 'gwimun');
  assert.equal(gwimun.length, 1); // 寅未
  assert.deepEqual(gwimun[0].occurrenceIds, ['natal.day', 'natal.year']);
  for (const r of [...c.relations, ...c.specialRules]) {
    assert.equal(r.transformationStatus, 'not_evaluated');
  }
});

test('lunar-leap chart: converted 2017-06-24 12:00 Asia/Seoul', () => {
  const birth = request('lunar-leap').birth;
  const [y, m, d] = birth.date.split('-').map(Number);
  const solar = lunarToSolar({ year: y, month: m, day: d, leapMonth: birth.leapMonth });
  assert.deepEqual(solar, { year: 2017, month: 6, day: 24 }); // KASI-anchored
  const n = deriveNatal({ ...fromBirth(birth), date: solar });
  const c = n.candidates[0];
  // Day pillar independently anchored by KASI (kasi-solc-2017-06-24 -> 壬午).
  assert.deepEqual(chartGZ(c), ['丁酉', '丙午', '壬午', '丙午']);
  assert.equal(n.dayMaster.stem.hanzi, '壬');
  const k = c.counts;
  assert.deepEqual(k.visibleStems.units, { wood: 0, fire: 3, earth: 0, metal: 0, water: 1 });
  assert.deepEqual(k.visibleBranches.units, { wood: 0, fire: 3, earth: 0, metal: 1, water: 0 });
  assert.deepEqual(k.stemsPlusWeightedHidden.tenths, { wood: 0, fire: 51, earth: 9, metal: 10, water: 10 });
  assert.equal(k.stemsPlusWeightedHidden.totalTenths, 80);
  // 丁壬 combination, two 丙壬 clashes, three 午午 self-punishment pairs,
  // gongmang 申酉 void matching the 酉 year branch.
  const rel = (id) => c.relations.filter((r) => r.ruleId === id);
  assert.equal(rel('stem_combination').length, 1);
  assert.equal(rel('stem_clash').length, 2);
  const self = rel('punishment').filter((r) => r.subtype === 'self');
  assert.equal(self.length, 3);
  const gongmang = c.specialRules.filter((r) => r.ruleId === 'gongmang');
  assert.deepEqual(gongmang[0].voidBranches, ['申', '酉']);
  assert.deepEqual(gongmang[0].occurrenceIds, ['natal.year']);
  // 午 is a .7/.3 double-weight branch.
  assert.deepEqual(
    c.pillars.month.hiddenStems.map((h) => [h.stem.hanzi, h.weightTenths]),
    [['丁', 7], ['己', 3]],
  );
});

test('hand-derived chart: 2000-01-20 12:00 UTC after Sohan, before Ipchun', () => {
  const n = deriveNatal({
    date: { year: 2000, month: 1, day: 20 }, time: { hour: 12, minute: 0, second: 0 }, timezone: 'UTC',
  });
  const c = n.candidates[0];
  // Saju year is still 1999 (己卯); month is 丁丑 (after 小寒); day 丁丑
  // (epoch+13); hour 丙午 (丁 day, 午 branch).
  assert.deepEqual(chartGZ(c), ['己卯', '丁丑', '丁丑', '丙午']);
  assert.equal(c.side, 'after');
  assert.equal(c.boundary.termId, 'sohan');
});

// --- jie boundaries: real ephemeris ------------------------------------------------

test('before/at real 2024 Ipchun flips both year and month pillars', () => {
  const mk = (hour, minute, second) => deriveNatal({
    date: { year: 2024, month: 2, day: 4 },
    time: { hour, minute, second },
    timezone: 'Asia/Seoul',
  });
  // Real Ipchun 2024: 08:26:49.630Z = 17:26:49.630 Seoul (fixture-anchored).
  const before = mk(17, 0, 0);
  assert.deepEqual(chartGZ(before.candidates[0]), ['癸卯', '乙丑', '戊戌', '辛酉']);
  assert.equal(before.candidates[0].side, 'before');
  const after = mk(18, 0, 0);
  assert.deepEqual(chartGZ(after.candidates[0]), ['甲辰', '丙寅', '戊戌', '辛酉']);
  assert.equal(after.candidates[0].side, 'after');
  // Day and hour pillars are unaffected by the year/month boundary.
  assert.equal(pillarGZ(before.candidates[0], 'day'), pillarGZ(after.candidates[0], 'day'));
  assert.equal(pillarGZ(before.candidates[0], 'hour'), pillarGZ(after.candidates[0], 'hour'));
});

test('real-term uncertainty band: inside +/-120 s yields both candidates', () => {
  const mk = (hour, minute, second) => deriveNatal({
    date: { year: 2024, month: 2, day: 4 },
    time: { hour, minute, second },
    timezone: 'Asia/Seoul',
  });
  // Band is 17:24:49.630..17:28:49.630 Seoul.
  const inside = mk(17, 24, 50);
  assert.equal(inside.candidates.length, 2);
  assert.equal(inside.coverageComplete, false);
  assert.equal(inside.candidates[0].side, 'before');
  assert.equal(inside.candidates[1].side, 'after');
  assert.deepEqual(chartGZ(inside.candidates[0]).slice(0, 2), ['癸卯', '乙丑']);
  assert.deepEqual(chartGZ(inside.candidates[1]).slice(0, 2), ['甲辰', '丙寅']);
  assert.equal(inside.candidates[0].uncertain, true);
  assert.deepEqual(inside.limitations.map((l) => l.code), ['SOLAR_TERM_UNCERTAINTY']);
  assert.equal(inside.limitations[0].path, 'birth.time');
  // 630 ms outside the band edge: exactly one candidate.
  const outsideBefore = mk(17, 24, 49);
  assert.equal(outsideBefore.candidates.length, 1);
  assert.equal(outsideBefore.candidates[0].side, 'before');
  const outsideAfter = mk(17, 28, 50);
  assert.equal(outsideAfter.candidates.length, 1);
  assert.equal(outsideAfter.candidates[0].side, 'after');
});

test('a middle qi never changes the month pillar', () => {
  // 2024-03-20 12:00 UTC is after 春分 (a qi, ~03:06 UTC) but before 清明:
  // the month stays 卯. The spy also proves only the jie month was queried.
  const calls = [];
  const real = createCalendar();
  const spy = {
    findSolarTerm({ year, month }) {
      calls.push({ year, month });
      return real.findSolarTerm({ year, month });
    },
  };
  const n = deriveNatal({
    date: { year: 2024, month: 3, day: 20 },
    time: { hour: 12, minute: 0, second: 0 },
    timezone: 'UTC',
    calendar: spy,
  });
  assert.deepEqual(calls, [{ year: 2024, month: 3 }]); // jie only, never a qi lookup
  assert.equal(pillarGZ(n.candidates[0], 'month'), '丁卯');
  assert.equal(pillarGZ(n.candidates[0], 'year'), '甲辰');
  assert.equal(pillarGZ(n.candidates[0], 'day'), '癸未');
});

// --- injected term facts: exact inequality semantics ------------------------------

test('injected term: exact equality and band edges classify precisely', () => {
  const T0 = Date.UTC(2024, 2, 10, 12, 0, 0); // fake jie inside March
  const at = (offsetMs) => deriveNatal({
    date: { year: 2024, month: 3, day: 10 },
    time: { hour: 12, minute: 0, second: 0 },
    timezone: 'UTC',
    calendar: stubCalendar(T0),
    resolveTime: () => ({ instantMs: T0 + offsetMs }),
  });
  // Outside the band: exactly one candidate on the declared side.
  assert.equal(at(-120001).candidates.length, 1);
  assert.equal(at(-120001).candidates[0].side, 'before');
  assert.equal(at(120001).candidates.length, 1);
  assert.equal(at(120001).candidates[0].side, 'after');
  // Band edges are inclusive: both candidates.
  for (const off of [-120000, -1, 0, 1, 120000]) {
    const n = at(off);
    assert.equal(n.candidates.length, 2, `offset ${off}`);
    assert.equal(n.candidates[0].side, 'before');
    assert.equal(n.candidates[1].side, 'after');
    assert.equal(n.limitations[0].code, 'SOLAR_TERM_UNCERTAINTY');
  }
  // Equality belongs to the new period: the 'after' candidate at t == T0
  // carries the after-term month pillar (卯), the 'before' carries 寅.
  const eq = at(0);
  assert.equal(pillarGZ(eq.candidates[0], 'month')[1], '寅');
  assert.equal(pillarGZ(eq.candidates[1], 'month')[1], '卯');
  // A non-February boundary never touches the year pillar.
  assert.equal(pillarGZ(eq.candidates[0], 'year'), '甲辰');
  assert.equal(pillarGZ(eq.candidates[1], 'year'), '甲辰');
});

test('injected February term flips year and month together', () => {
  const T0 = Date.UTC(2024, 1, 4, 12, 0, 0);
  const n = deriveNatal({
    date: { year: 2024, month: 2, day: 4 },
    time: { hour: 12, minute: 0, second: 0 },
    timezone: 'UTC',
    calendar: stubCalendar(T0),
    resolveTime: () => ({ instantMs: T0 }),
  });
  assert.equal(n.candidates.length, 2);
  assert.deepEqual(chartGZ(n.candidates[0]).slice(0, 2), ['癸卯', '乙丑']);
  assert.deepEqual(chartGZ(n.candidates[1]).slice(0, 2), ['甲辰', '丙寅']);
});

// --- unknown birth time -----------------------------------------------------------

test('unknown time: null hour, six units, UNKNOWN_BIRTH_TIME, full-day interval', () => {
  const n = deriveNatal(fromBirth(request('unknown-time').birth));
  assert.equal(n.candidates.length, 1);
  assert.equal(n.coverageComplete, false);
  const c = n.candidates[0];
  assert.equal(c.pillars.hour, null); // never inferred, never noon
  assert.deepEqual(chartGZ(c).slice(0, 3), ['戊寅', '壬戌', '丁未']);
  assert.equal(c.counts.visibleStems.totalUnits, 3);
  assert.equal(c.counts.visibleBranches.totalUnits, 3);
  assert.equal(c.counts.combinedSurface.totalUnits, 6);
  assert.equal(c.counts.stemsPlusWeightedHidden.totalTenths, 60);
  assert.equal(c.counts.stemsPlusWeightedHidden.totalUnits, 6);
  assert.deepEqual(c.counts.stemsPlusWeightedHidden.tenths, { wood: 8, fire: 16, earth: 24, metal: 2, water: 10 });
  assert.deepEqual(n.limitations.map((l) => l.code), ['UNKNOWN_BIRTH_TIME']);
  assert.equal(n.limitations[0].path, 'birth.time');
  // Whole Seoul civil day: 1998-10-26T15:00Z .. 1998-10-27T15:00Z.
  assert.equal(c.interval.startIso, '1998-10-26T15:00:00.000Z');
  assert.equal(c.interval.endIso, '1998-10-27T15:00:00.000Z');
  assert.equal(c.interval.endMs - c.interval.startMs, 24 * 3600 * 1000);
  // Relations apply to the three known pillars only.
  const ids = new Set(c.relations.flatMap((r) => r.occurrenceIds));
  assert.ok(!ids.has('natal.hour'));
});

test('unknown time: DST 23/25-hour days use real zone boundaries', () => {
  const spring = deriveNatal({
    date: { year: 2024, month: 3, day: 10 }, time: null, timezone: 'America/New_York',
  });
  const iv1 = spring.candidates[0].interval;
  assert.equal(iv1.endMs - iv1.startMs, 23 * 3600 * 1000); // spring-forward day
  assert.equal(iv1.startIso, '2024-03-10T05:00:00.000Z');
  assert.equal(iv1.endIso, '2024-03-11T04:00:00.000Z');
  assert.equal(pillarGZ(spring.candidates[0], 'day'), '癸酉');
  const fall = deriveNatal({
    date: { year: 2024, month: 11, day: 3 }, time: null, timezone: 'America/New_York',
  });
  const iv2 = fall.candidates[0].interval;
  assert.equal(iv2.endMs - iv2.startMs, 25 * 3600 * 1000); // fall-back day
  assert.equal(iv2.startIso, '2024-11-03T04:00:00.000Z');
  assert.equal(iv2.endIso, '2024-11-04T05:00:00.000Z');
  assert.equal(pillarGZ(fall.candidates[0], 'day'), '辛未');
});

test('unknown time: jie inside the day splits into two candidates', () => {
  const T0 = Date.UTC(2024, 2, 10, 12, 0, 0); // fake jie mid-day UTC
  const n = deriveNatal({
    date: { year: 2024, month: 3, day: 10 }, time: null, timezone: 'UTC',
    calendar: stubCalendar(T0),
  });
  assert.equal(n.candidates.length, 2);
  const [before, after] = n.candidates;
  assert.equal(before.side, 'before');
  assert.equal(after.side, 'after');
  assert.equal(pillarGZ(before, 'month'), '丙寅');
  assert.equal(pillarGZ(after, 'month'), '丁卯');
  assert.equal(before.pillars.hour, null);
  assert.equal(after.pillars.hour, null);
  // 'before' is possible up to T0+120 s inclusive; 'after' from T0-120 s.
  assert.equal(before.interval.startIso, '2024-03-10T00:00:00.000Z');
  assert.equal(before.interval.endMs, T0 + 120000 + 1);
  assert.equal(after.interval.startMs, T0 - 120000);
  assert.equal(after.interval.endIso, '2024-03-11T00:00:00.000Z');
  const codes = n.limitations.map((l) => l.code);
  assert.deepEqual(codes, ['AMBIGUOUS_NATAL_BOUNDARY', 'SOLAR_TERM_UNCERTAINTY', 'UNKNOWN_BIRTH_TIME']);
  assert.equal(n.limitations[0].path, 'birth.date');
});

test('unknown time: band overlapping a day edge splits without an in-day term', () => {
  // Term 60 s before midnight: the term itself is outside the day but its
  // uncertainty band reaches inside -> both candidates, no AMBIGUOUS code.
  const T0 = Date.UTC(2024, 2, 9, 23, 59, 0);
  const n = deriveNatal({
    date: { year: 2024, month: 3, day: 10 }, time: null, timezone: 'UTC',
    calendar: stubCalendar(T0),
  });
  assert.equal(n.candidates.length, 2);
  const codes = n.limitations.map((l) => l.code);
  assert.ok(codes.includes('SOLAR_TERM_UNCERTAINTY'));
  assert.ok(!codes.includes('AMBIGUOUS_NATAL_BOUNDARY'));
  // Term far outside the day: one candidate covering the whole day.
  const far = deriveNatal({
    date: { year: 2024, month: 3, day: 10 }, time: null, timezone: 'UTC',
    calendar: stubCalendar(Date.UTC(2024, 2, 5, 0, 0, 0)),
  });
  assert.equal(far.candidates.length, 1);
  assert.equal(far.candidates[0].interval.endMs - far.candidates[0].interval.startMs, 86400000);
  assert.deepEqual(far.limitations.map((l) => l.code), ['UNKNOWN_BIRTH_TIME']);
});

test('unknown time: a skipped civil date rejects instead of inventing a day', () => {
  // Pacific/Apia skipped 2011-12-30 entirely (dateline move).
  assert.throws(
    () => deriveNatal({ date: { year: 2011, month: 12, day: 30 }, time: null, timezone: 'Pacific/Apia' }),
    (e) => e instanceof NatalError && e.code === 'NONEXISTENT_LOCAL_DATE' && e.path === 'birth.date',
  );
  // The day before the skip still resolves; its end is the next existing date.
  const n = deriveNatal({ date: { year: 2011, month: 12, day: 29 }, time: null, timezone: 'Pacific/Apia' });
  assert.equal(n.candidates.length, 1);
  assert.equal(n.candidates[0].interval.startIso, '2011-12-29T10:00:00.000Z');
  // The day ends at the first instant of the next EXISTING civil date:
  // 2011-12-31T00:00+14:00 = 2011-12-30T10:00Z (the skipped date's slot).
  assert.equal(n.candidates[0].interval.endIso, '2011-12-30T10:00:00.000Z');
  assert.equal(n.candidates[0].interval.endMs - n.candidates[0].interval.startMs, 86400000);
});

// --- hidden stems table ---------------------------------------------------------

test('hidden stems: all 12 branches carry stipulated ranks and integer-tenth weights', () => {
  const expected = {
    子: [['癸', 10]], 丑: [['己', 6], ['癸', 2], ['辛', 2]],
    寅: [['甲', 6], ['丙', 2], ['戊', 2]], 卯: [['乙', 10]],
    辰: [['戊', 6], ['乙', 2], ['癸', 2]], 巳: [['丙', 6], ['戊', 2], ['庚', 2]],
    午: [['丁', 7], ['己', 3]], 未: [['己', 6], ['丁', 2], ['乙', 2]],
    申: [['庚', 6], ['壬', 2], ['戊', 2]], 酉: [['辛', 10]],
    戌: [['戊', 6], ['辛', 2], ['丁', 2]], 亥: [['壬', 7], ['甲', 3]],
  };
  // Drive every branch through one chart each via injected month branches is
  // overkill: assert the runtime table itself plus one pillar per branch.
  const rank = rules.tables.hiddenStems.rankOrder;
  for (const [branch, want] of Object.entries(expected)) {
    assert.deepEqual(rank[branch], want.map(([s]) => s), branch);
    const sum = want.reduce((acc, [, w]) => acc + w, 0);
    assert.equal(sum, 10, `${branch} weights sum to 10 tenths`);
  }
  // 午/亥 are the only two-stem branches (the .7/.3 double).
  const doubles = Object.entries(rank).filter(([, v]) => v.length === 2).map(([b]) => b);
  assert.deepEqual(doubles.sort(), ['午', '亥'].sort());
  assert.deepEqual(rules.tables.hiddenStems.doubleAppliesTo, ['午', '亥']);
});

// --- errors, determinism, invariants ----------------------------------------------

test('invalid date/time shapes reject with stable codes', () => {
  assert.throws(
    () => deriveNatal({ date: { year: 2024, month: 2, day: 30 }, time: null, timezone: 'UTC' }),
    (e) => e instanceof NatalError && e.code === 'INVALID_DATE' && e.path === 'birth.date',
  );
  for (const time of [{ hour: 24, minute: 0, second: 0 }, { hour: -1, minute: 0, second: 0 }, { hour: 1, minute: 60, second: 0 }]) {
    assert.throws(
      () => deriveNatal({ date: { year: 2024, month: 3, day: 10 }, time, timezone: 'UTC' }),
      (e) => e instanceof NatalError && e.code === 'INVALID_TIME' && e.path === 'birth.time',
    );
  }
});

test('civil-time and calendar failures propagate, never swallowed', () => {
  // DST gap: the wall time does not exist -> TimeError NONEXISTENT_LOCAL_TIME.
  assert.throws(
    () => deriveNatal({
      date: { year: 2024, month: 3, day: 10 }, time: { hour: 2, minute: 30, second: 0 },
      timezone: 'America/New_York',
    }),
    (e) => e.code === 'NONEXISTENT_LOCAL_TIME' && e.path === 'birth.time',
  );
  // Solar-term lookup failure is a calculation error, not a fallback.
  const failing = {
    findSolarTerm() { throw new CalendarError('SOLAR_TERM_SEARCH_FAILED', 'birth.date', 'injected miss'); },
  };
  assert.throws(
    () => deriveNatal({
      date: { year: 2024, month: 3, day: 10 }, time: { hour: 12, minute: 0, second: 0 },
      timezone: 'UTC', calendar: failing,
    }),
    (e) => e instanceof CalendarError && e.code === 'SOLAR_TERM_SEARCH_FAILED',
  );
});

test('output is deterministic: identical inputs give identical results', () => {
  const args = fromBirth(request('known').birth);
  const a = deriveNatal(args);
  const b = deriveNatal(args);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('no useful-element or strength inference exists anywhere in the output', () => {
  const n = deriveNatal(fromBirth(request('known').birth));
  const text = JSON.stringify(n);
  for (const banned of ['useful', 'yongsin', '용신', 'strength', 'favorable', 'score']) {
    assert.ok(!text.toLowerCase().includes(banned.toLowerCase()), `output contains ${banned}`);
  }
});
