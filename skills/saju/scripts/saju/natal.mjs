// natal.mjs — natal pillar derivation and all per-pillar saju values.
//
// Pure derivation driven by rules.json (kr-civil-midnight-v1 policy tables):
//   day pillar    integer proleptic-Gregorian day numbers against the
//                 stipulated epoch 2000-01-07 = 甲子, civil-midnight rollover
//   year pillar   Ipchun-adjusted year minus 4 (astronomical 315 deg term)
//   month pillar  the twelve jie boundaries; equality belongs to the new
//                 period; first 寅 month stem (2*(yearStem%5)+2)%10
//   hour pillar   branch floor((civilHour+1)/2)%12 (23:00 starts 子 while the
//                 day stem still follows midnight); stem (2*dayStem+branch)%10
//   hidden stems  rank-ordered per branch with named weights
//                 hidden-602020-7030-v1, stored as integer tenths
//   ten gods      element generation/control + polarity vs the day stem;
//                 the day stem itself is 日主, never an extra 比肩
//   twelve stages 長生..養 from the stipulated starts/directions table
//   counts        visible stems / visible branches / combined surface /
//                 stems+weighted-hidden expansion; totals are 8 units for a
//                 complete chart and 6 without the hour pillar
//   relations     detectRelations over the known pillar occurrences, split
//                 into 합충형파해 `relations` and named `specialRules`
//                 (wonjin/gwimun/gongmang); never mutated, never scored
//
// Boundary semantics: a birth instant strictly inside +/-120 s of a jie
// instant is epistemically uncertain and yields BOTH adjacent pillar
// candidates (SOLAR_TERM_UNCERTAINTY); outside the band exactly one. For an
// unknown birth time the whole local day is enumerated with real zone
// boundaries (23/25-hour days included), split at any jie whose instant or
// uncertainty band intersects the day; a term inside the day is a genuine
// split (AMBIGUOUS_NATAL_BOUNDARY). The hour pillar is never inferred: null
// time yields pillar.hour === null and six-unit counts.
//
// Error contract: failures are NatalError with stable {code,path}; upstream
// InputError/TimeError/CalendarError propagate unchanged.

import { readFileSync } from 'node:fs';
import {
  SOLAR_TERM_UNCERTAINTY_SECONDS,
  createCalendar,
} from './calendar.mjs';
import { daysInMonth, resolveCivilTime, wallFieldsAt } from './time.mjs';
import { detectRelations } from './relations.mjs';

export class NatalError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'NatalError';
    this.code = code;
    this.path = path;
  }
}

export const RULES_URL = new URL('./rules.json', import.meta.url);
export const loadNatalRules = (url = RULES_URL) => JSON.parse(readFileSync(url, 'utf8'));

// Named special rules (공망/원진/귀문) are reported separately from the
// 합충형파해 relation records; both come from the same detectRelations pass.
const SPECIAL_RULE_IDS = new Set(['wonjin', 'gwimun', 'gongmang']);
const ELEMENT_ORDER = ['wood', 'fire', 'earth', 'metal', 'water'];
const PILLAR_ORDER = ['year', 'month', 'day', 'hour'];

const pad2 = (n) => String(n).padStart(2, '0');
const mod = (n, m) => ((n % m) + m) % m;
const isoOf = (ms) => new Date(ms).toISOString();

// Date.UTC treats years 0-99 as 1900+year; setUTCFullYear avoids the trap.
// The base year must be a leap year: building on 1900 rolls Feb 29 to Mar 1
// before setUTCFullYear can correct it, so every Feb-29 instant shifts +1 day.
const utcMs = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => {
  const dt = new Date(Date.UTC(2000, mo - 1, d, h, mi, s, ms));
  dt.setUTCFullYear(y);
  return dt.getTime();
};

// Integer proleptic-Gregorian day number (Julian day number at noon).
export const gregorianDayNumber = (year, month, day) => {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return day + Math.floor((153 * m + 2) / 5) + 365 * y
    + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
};

const addDays = (d, n) => {
  const dt = new Date(utcMs(d.year, d.month, d.day) + n * 86400 * 1000);
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
};

const dateNum = (d) => d.year * 10000 + d.month * 100 + d.day;
const wallDateNum = (timezone, instantMs) => dateNum(wallFieldsAt(timezone, instantMs));

// --- rule-table views ---------------------------------------------------------

const indexTables = (rules) => {
  const stemByHanzi = new Map(rules.labels.stems.map((s) => [s.hanzi, s]));
  const branchByHanzi = new Map(rules.labels.branches.map((b) => [b.hanzi, b]));
  const elementByHanzi = new Map(rules.labels.elements.map((e) => [e.hanzi, e]));
  const tenGodByHanzi = new Map(rules.labels.tenGods.map((g) => [g.hanzi, g]));
  const stageByHanzi = new Map(rules.labels.twelveStages.map((s) => [s.hanzi, s]));
  const hidden = rules.tables.hiddenStems;
  const stageTable = rules.tables.twelveStages;
  const stageStart = new Map(
    Object.entries(stageTable.startsAndDirections).map(([stem, v]) => [stem, v]),
  );
  return {
    rules,
    stems: rules.labels.stems,
    branches: rules.labels.branches,
    stemByHanzi,
    branchByHanzi,
    elementByHanzi,
    tenGodByHanzi,
    stageByHanzi,
    hiddenRank: hidden.rankOrder,
    hiddenWeights: hidden.weights,
    hiddenWeightsId: hidden.weightsId,
    stageOrder: stageTable.order,
    stageStart,
    tenGodTable: rules.tables.tenGods,
  };
};

// --- local-day bounds ---------------------------------------------------------

// First instant whose wall date in `timezone` is on or after `date`.
// wallDate(t) is monotonic non-decreasing, so a coarse scan plus binary
// search lands on the exact millisecond boundary; a nonexistent local
// midnight (DST gap at 00:00) resolves to the first instant that exists.
const SCAN_MS = 48 * 3600 * 1000;
const STEP_MS = 15 * 60 * 1000;

const firstInstantOnOrAfter = (timezone, date) => {
  const target = dateNum(date);
  const guess = utcMs(date.year, date.month, date.day);
  let prev = null;
  for (let t = guess - SCAN_MS; t <= guess + SCAN_MS; t += STEP_MS) {
    if (wallDateNum(timezone, t) >= target) {
      let lo = prev === null ? t - STEP_MS : prev;
      let hi = t;
      while (hi - lo > 1) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (wallDateNum(timezone, mid) >= target) hi = mid;
        else lo = mid;
      }
      return { instantMs: hi, wallDate: wallFieldsAt(timezone, hi) };
    }
    prev = t;
  }
  throw new NatalError(
    'LOCAL_DATE_UNRESOLVABLE', 'birth.date',
    `no instant within +/-48h of ${date.year}-${pad2(date.month)}-${pad2(date.day)} in ${timezone}`,
  );
};

// Civil-day interval [start, end) for a local date in a zone. The end is the
// first instant of the next existing civil date, so skipped dates (Samoa
// 2011-12-30) and 23/25-hour DST days get their real zone boundaries.
const localDayInterval = (timezone, date) => {
  const start = firstInstantOnOrAfter(timezone, date);
  if (dateNum(start.wallDate) !== dateNum(date)) {
    throw new NatalError(
      'NONEXISTENT_LOCAL_DATE', 'birth.date',
      `${date.year}-${pad2(date.month)}-${pad2(date.day)} does not exist in ${timezone}`,
    );
  }
  const end = firstInstantOnOrAfter(timezone, addDays(date, 1));
  return { startMs: start.instantMs, endMs: end.instantMs };
};

// --- pillar math --------------------------------------------------------------

// Sexagenary day index for a civil date: integer day numbers against the
// stipulated 2000-01-07 = 甲子 epoch (index 0).
export const dayCycleIndex = (date) =>
  mod(gregorianDayNumber(date.year, date.month, date.day) - gregorianDayNumber(2000, 1, 7), 60);

export const hourBranchIndex = (civilHour) => Math.floor((civilHour + 1) / 2) % 12;
export const hourStemIndex = (dayStemIndex, hourBranchIdx) =>
  (2 * dayStemIndex + hourBranchIdx) % 10;
export const firstInMonthStemIndex = (yearStemIndex) => (2 * (yearStemIndex % 5) + 2) % 10;

// Ten-god Hanzi of `targetStem` relative to `dayStem`, from the stipulated
// element generation/control + polarity table. The day stem itself is 日主.
export const stemTenGod = (T, dayStem, targetStem) => {
  const d = T.stemByHanzi.get(dayStem);
  const t = T.stemByHanzi.get(targetStem);
  const gen = T.rules.labels.elements.map((e) => e.id);
  const de = gen.indexOf(d.element);
  const te = gen.indexOf(t.element);
  const samePolarity = d.polarity === t.polarity;
  const g = T.tenGodTable;
  if (de === te) return samePolarity ? g.sameElement.samePolarity : g.sameElement.oppositePolarity;
  if (te === (de + 1) % 5) return samePolarity ? g.generated.samePolarity : g.generated.oppositePolarity;
  if (te === (de + 2) % 5) return samePolarity ? g.controlled.samePolarity : g.controlled.oppositePolarity;
  if (te === (de + 3) % 5) return samePolarity ? g.controlling.samePolarity : g.controlling.oppositePolarity;
  return samePolarity ? g.generating.samePolarity : g.generating.oppositePolarity;
};

// Twelve-stage Hanzi of `stem` at `branch` from the stipulated
// starts/directions table (甲亥+,乙午-,丙戊寅+,丁己酉-,庚巳+,辛子-,壬申+,癸卯-).
export const twelveStage = (T, stem, branch) => {
  const { start, direction } = T.stageStart.get(stem);
  const startIdx = T.branches.findIndex((b) => b.hanzi === start);
  const branchIdx = T.branches.findIndex((b) => b.hanzi === branch);
  const offset = direction === '+' ? mod(branchIdx - startIdx, 12) : mod(startIdx - branchIdx, 12);
  return T.stageOrder[offset];
};

const hiddenStemsOf = (T, branchHanzi) => {
  const stems = T.hiddenRank[branchHanzi];
  const w = stems.length === 1
    ? T.hiddenWeights.single
    : stems.length === 3 ? T.hiddenWeights.triple : T.hiddenWeights.double;
  const weights = Array.isArray(w) ? w : [w];
  return stems.map((hanzi, i) => ({
    rank: i + 1,
    stem: T.stemByHanzi.get(hanzi),
    weightTenths: Math.round(weights[i] * 10),
  }));
};

const buildPillar = (T, id, index, stemIdx, branchIdx, dayStem) => {
  const stem = T.stems[stemIdx];
  const branch = T.branches[branchIdx];
  const hiddenStems = hiddenStemsOf(T, branch.hanzi).map((h) => ({
    ...h,
    tenGod: T.tenGodByHanzi.get(stemTenGod(T, dayStem, h.stem.hanzi)),
    stage: T.stageByHanzi.get(twelveStage(T, h.stem.hanzi, branch.hanzi)),
  }));
  return {
    id,
    index,
    stem,
    branch,
    ganZhi: `${stem.hanzi}${branch.hanzi}`,
    korean: `${stem.korean}${branch.korean}`,
    stemTenGod: T.tenGodByHanzi.get(
      id === 'natal.day' ? T.tenGodTable.dayStemLabel : stemTenGod(T, dayStem, stem.hanzi),
    ),
    hiddenStems,
    branchTenGod: T.tenGodByHanzi.get(stemTenGod(T, dayStem, hiddenStems[0].stem.hanzi)),
    dayStemStage: T.stageByHanzi.get(twelveStage(T, dayStem, branch.hanzi)),
    stemStage: T.stageByHanzi.get(twelveStage(T, stem.hanzi, branch.hanzi)),
  };
};

const zeroUnits = () => Object.fromEntries(ELEMENT_ORDER.map((e) => [e, 0]));

const computeCounts = (T, pillars) => {
  const present = PILLAR_ORDER.map((k) => pillars[k]).filter((p) => p !== null);
  const stemUnits = zeroUnits();
  const branchUnits = zeroUnits();
  const tenths = zeroUnits();
  for (const p of present) {
    stemUnits[p.stem.element] += 1;
    branchUnits[p.branch.element] += 1;
    tenths[p.stem.element] += 10;
    for (const h of p.hiddenStems) tenths[h.stem.element] += h.weightTenths;
  }
  const surface = zeroUnits();
  for (const e of ELEMENT_ORDER) surface[e] = stemUnits[e] + branchUnits[e];
  const totalTenths = ELEMENT_ORDER.reduce((s, e) => s + tenths[e], 0);
  return {
    visibleStems: { units: stemUnits, totalUnits: present.length },
    visibleBranches: { units: branchUnits, totalUnits: present.length },
    combinedSurface: { units: surface, totalUnits: 2 * present.length },
    stemsPlusWeightedHidden: {
      tenths,
      units: Object.fromEntries(ELEMENT_ORDER.map((e) => [e, tenths[e] / 10])),
      totalTenths,
      totalUnits: totalTenths / 10,
      weightsId: T.hiddenWeightsId,
    },
  };
};

const buildCandidate = (T, spec) => {
  const { sajuYear, monthBranchIdx, dayIdx, hourBranchIdx, interval, side, boundary, uncertain } = spec;
  const yearStemIdx = mod(sajuYear - 4, 10);
  const yearBranchIdx = mod(sajuYear - 4, 12);
  const monthStemIdx = mod(firstInMonthStemIndex(yearStemIdx) + mod(monthBranchIdx - 2, 12), 10);
  const dayStemIdx = dayIdx % 10;
  const dayBranchIdx = dayIdx % 12;
  const dayStem = T.stems[dayStemIdx].hanzi;

  const pillars = {
    year: buildPillar(T, 'natal.year', 0, yearStemIdx, yearBranchIdx, dayStem),
    month: buildPillar(T, 'natal.month', 1, monthStemIdx, monthBranchIdx, dayStem),
    day: buildPillar(T, 'natal.day', 2, dayStemIdx, dayBranchIdx, dayStem),
    hour: hourBranchIdx === null
      ? null
      : buildPillar(T, 'natal.hour', 3, hourStemIndex(dayStemIdx, hourBranchIdx), hourBranchIdx, dayStem),
  };

  const occurrences = PILLAR_ORDER
    .map((k) => pillars[k])
    .filter((p) => p !== null)
    .map((p) => ({ id: p.id, stem: p.stem.hanzi, branch: p.branch.hanzi }));
  const detected = detectRelations(occurrences);

  return {
    interval: {
      startIso: isoOf(interval.startMs),
      endIso: isoOf(interval.endMs),
      startMs: interval.startMs,
      endMs: interval.endMs,
    },
    side,
    boundary,
    uncertain,
    pillarIds: PILLAR_ORDER,
    pillars,
    counts: computeCounts(T, pillars),
    relations: detected.filter((r) => !SPECIAL_RULE_IDS.has(r.ruleId)),
    specialRules: detected.filter((r) => SPECIAL_RULE_IDS.has(r.ruleId)),
  };
};

// --- boundary classification ----------------------------------------------------

const termInfo = (term) => ({
  eventId: term.eventId ?? null,
  termId: term.termId ?? null,
  iso: term.iso ?? isoOf(term.instantMs),
  instantMs: term.instantMs,
  uncertaintySeconds: term.uncertaintySeconds ?? SOLAR_TERM_UNCERTAINTY_SECONDS,
});

const sajuYearFor = (year, month, side) => (month === 2 ? year - (side === 'before' ? 1 : 0) : year - (month === 1 ? 1 : 0));
const monthBranchFor = (month, side) => mod(month - (side === 'before' ? 1 : 0), 12);

// Derives the natal chart for one birth input.
//
//   deriveNatal({date, time, timezone, utcOffset?, calendar?, resolveTime?, rules?})
//     date:      {year,month,day} solar Gregorian (lunar conversion is the
//                caller's job — calendar.mjs lunarToSolar)
//     time:      {hour,minute,second} or null (hour pillar never inferred)
//     timezone:  IANA name
//     utcOffset: optional '±HH:mm[:ss]' or signed seconds for fold disambiguation
//     calendar:  injectable {findSolarTerm({year,month})}; default
//                createCalendar(). A term object needs instantMs and may carry
//                eventId/termId/iso/uncertaintySeconds (default 120).
//     resolveTime: injectable resolveCivilTime-compatible function
//     rules:     injectable parsed rules.json (default: loaded from disk)
//
// Returns {rulesetId, dayMaster, candidates[], coverageComplete, limitations[]}.
// limitations are stable {code,path,details} records sorted by code then path.
export const deriveNatal = ({
  date,
  time,
  timezone,
  utcOffset,
  calendar,
  resolveTime = resolveCivilTime,
  rules,
}) => {
  const T = indexTables(rules ?? loadNatalRules());
  const cal = calendar ?? createCalendar();
  const limitations = [];
  const addLimitation = (code, path, details) => limitations.push({ code, path, details });

  if (!date || !Number.isInteger(date.year) || !Number.isInteger(date.month) || !Number.isInteger(date.day)
      || date.month < 1 || date.month > 12 || date.day < 1 || date.day > daysInMonth(date.year, date.month)) {
    throw new NatalError('INVALID_DATE', 'birth.date', `not a Gregorian date: ${JSON.stringify(date)}`);
  }
  if (time !== null && time !== undefined) {
    const t = time;
    if (!Number.isInteger(t.hour) || !Number.isInteger(t.minute) || !Number.isInteger(t.second)
        || t.hour < 0 || t.hour > 23 || t.minute < 0 || t.minute > 59 || t.second < 0 || t.second > 59) {
      throw new NatalError('INVALID_TIME', 'birth.time', `not an HH:mm:ss civil time: ${JSON.stringify(time)}`);
    }
  }

  const dayIdx = dayCycleIndex(date);
  const dayStem = T.stems[dayIdx % 10];
  const term = termInfo(cal.findSolarTerm({ year: date.year, month: date.month }));
  const bandMs = term.uncertaintySeconds * 1000;

  const candidates = [];
  const seen = new Set();
  const pushCandidate = (spec) => {
    const signature = [
      spec.sajuYear, spec.monthBranchIdx, spec.dayIdx,
      spec.hourBranchIdx === null ? 'null' : spec.hourBranchIdx,
    ].join('|');
    if (seen.has(signature)) return; // deduplicate equivalent natal candidates
    seen.add(signature);
    candidates.push(buildCandidate(T, spec));
  };

  if (time !== null && time !== undefined) {
    // Known civil time: resolve to one instant, then classify against the
    // month's jie. Inside the +/-120 s band both adjacent pillar candidates
    // are returned; outside it exactly one.
    const resolved = resolveTime({ date, time, timezone, utcOffset });
    const t = resolved.instantMs;
    const hourBranchIdx = hourBranchIndex(time.hour);
    const sides = Math.abs(t - term.instantMs) <= bandMs ? ['before', 'after'] : [t < term.instantMs ? 'before' : 'after'];
    const uncertain = sides.length === 2;
    if (uncertain) {
      addLimitation('SOLAR_TERM_UNCERTAINTY', 'birth.time', {
        eventId: term.eventId, termId: term.termId, termIso: term.iso,
        uncertaintySeconds: term.uncertaintySeconds,
      });
    }
    for (const side of sides) {
      pushCandidate({
        sajuYear: sajuYearFor(date.year, date.month, side),
        monthBranchIdx: monthBranchFor(date.month, side),
        dayIdx,
        hourBranchIdx,
        interval: { startMs: t, endMs: t },
        side,
        boundary: term,
        uncertain,
      });
    }
  } else {
    // Unknown birth time: enumerate the whole local day with real zone
    // boundaries, split at the jie instant and its uncertainty band, and
    // deduplicate equivalent candidates. The day pillar is still known
    // (civil-midnight rollover); the hour pillar stays null.
    addLimitation('UNKNOWN_BIRTH_TIME', 'birth.time', {
      hourPillar: null,
      countsUnits: 6,
    });
    const day = localDayInterval(timezone, date);
    const T0 = term.instantMs;
    // A pillar set is POSSIBLE at every instant inside the +/-120 s band, so
    // the 'before' interval reaches T0+band inclusive (+1 ms keeps the
    // half-open endMs representation exact at band edges) and the 'after'
    // interval starts at T0-band.
    const beforeIv = { startMs: day.startMs, endMs: Math.min(day.endMs, T0 + bandMs + 1) };
    const afterIv = { startMs: Math.max(day.startMs, T0 - bandMs), endMs: day.endMs };
    const beforePossible = beforeIv.endMs > beforeIv.startMs;
    const afterPossible = afterIv.endMs > afterIv.startMs;
    const uncertain = beforePossible && afterPossible;
    if (uncertain) {
      addLimitation('SOLAR_TERM_UNCERTAINTY', 'birth.time', {
        eventId: term.eventId, termId: term.termId, termIso: term.iso,
        uncertaintySeconds: term.uncertaintySeconds,
      });
      if (T0 > day.startMs && T0 < day.endMs) {
        addLimitation('AMBIGUOUS_NATAL_BOUNDARY', 'birth.date', {
          eventId: term.eventId, termId: term.termId, termIso: term.iso,
          dayStartIso: isoOf(day.startMs), dayEndIso: isoOf(day.endMs),
        });
      }
    }
    const sides = [
      beforePossible ? 'before' : null,
      afterPossible ? 'after' : null,
    ].filter((s) => s !== null);
    const ivFor = (side) => (side === 'before' ? beforeIv : afterIv);
    for (const side of sides) {
      pushCandidate({
        sajuYear: sajuYearFor(date.year, date.month, side),
        monthBranchIdx: monthBranchFor(date.month, side),
        dayIdx,
        hourBranchIdx: null,
        interval: ivFor(side),
        side,
        boundary: term,
        uncertain,
      });
    }
  }

  limitations.sort((a, b) => (a.code === b.code
    ? (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    : a.code < b.code ? -1 : 1));

  return {
    rulesetId: T.rules.rulesetId,
    dayMaster: {
      stem: dayStem,
      tenGod: T.tenGodByHanzi.get(T.tenGodTable.dayStemLabel),
      dayCycleIndex: dayIdx,
      anchor: {
        solarDate: T.rules.tables.dayCycleAnchor.solarDate,
        ganZhi: T.rules.tables.dayCycleAnchor.dayGanZhi,
      },
    },
    candidates,
    coverageComplete: candidates.length === 1 && candidates[0].pillars.hour !== null,
    limitations,
  };
};
