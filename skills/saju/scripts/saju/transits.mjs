// transits.mjs — dated transit pillars, per-transit age, active major-cycle
// context and natal×transit relation deltas.
//
// Pure derivation over the same kr-civil-midnight-v1 policies as natal.mjs:
//   annual pillar   Ipchun-adjusted saju year minus 4 (equality belongs to
//                   the new period; January always counts as the prior year)
//   monthly pillar  the twelve jie boundaries; first 寅 month stem
//                   (2*(yearStem%5)+2)%10, advanced monthly
//   daily pillar    integer proleptic-Gregorian day numbers against the
//                   stipulated 2000-01-07 = 甲子 epoch, civil-midnight
//                   rollover in the BIRTH zone (per-person-zone periods)
//
// Transit pillars depend only on the requested instant and the birth
// timezone — never on the natal chart — so two persons sharing instant and
// zone get identical pillarCandidates. Ten gods, twelve stages and relation
// deltas are derived per natal candidate afterward in `contexts`.
//
// Uncertainty: a target instant inside +/-120 s of the month's jie instant
// returns BOTH adjacent pillar sets (pillarCandidates before/after) and a
// SOLAR_TERM_UNCERTAINTY limitation; outside the band exactly one set.
//
// Age: completed solar years, counted from the start of the birthday's
// civil date in the birth zone — never the birth clock time. Feb 29 births
// increment on March 1 in non-leap years (anniversaryPolicy
// 'month-day-march1-for-feb29'). Before the solar birth date: years null
// with reason BEFORE_BIRTH_DATE, never negative.
//
// Active major cycle: membership is evaluated against the caller-supplied
// computeMajorCycles result. A cycle's interval carries {earliest,latest}
// bounds; an instant is a definite member when inside [latest start,
// earliest end) and a possible member when inside [earliest start, latest
// end). Exactly one definite+possible id => 'determinate'; any wider set =>
// 'ambiguous' with candidateCycleIds, never a forced pick; none => 'none'.
// No majorCycles input (or count 0) => 'not_requested'; available:false =>
// 'unavailable'. Cycles are never manufactured here.
//
// Relations: detectRelations over natal occurrences + every POSSIBLE major
// cycle + the transit pillars, then filtered: records whose occurrences are
// all natal-sourced are dropped (natal-only structure is not a transit
// activation), and records spanning two or more distinct major.* occurrence
// ids are dropped (alternative cycles never co-occur). Every record carries
// `sources`, the sorted unique occurrence namespaces (natal|major|transit),
// including a gongmang record's referenceOccurrenceId namespace.
//
// Error contract: failures are TransitError with stable {code,path};
// upstream InputError/TimeError/CalendarError propagate unchanged.

import {
  SOLAR_TERM_UNCERTAINTY_SECONDS,
  createCalendar,
} from './calendar.mjs';
import {
  dayCycleIndex,
  firstInMonthStemIndex,
  loadNatalRules,
  stemTenGod,
  twelveStage,
} from './natal.mjs';
import { detectRelations, loadRelationRules } from './relations.mjs';
import {
  daysInMonth,
  formatUtcOffset,
  offsetSecondsAt,
  parseRfc3339Instant,
  wallFieldsAt,
} from './time.mjs';

export class TransitError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'TransitError';
    this.code = code;
    this.path = path;
  }
}

export const MAX_TRANSITS = 366;
export const TRANSIT_AGE_SYSTEM = 'completed-solar-years';
export const TRANSIT_AGE_ANNIVERSARY_POLICY = 'month-day-march1-for-feb29';
export const BEFORE_BIRTH_DATE = 'BEFORE_BIRTH_DATE';

const SOLAR_RANGE = { min: '1900-01-01', max: '2100-12-31' };
const TRANSIT_PILLAR_ORDER = ['annual', 'monthly', 'daily'];

const pad2 = (n) => String(n).padStart(2, '0');
const mod = (n, m) => ((n % m) + m) % m;
const isoOf = (ms) => new Date(ms).toISOString();
const dateText = (d) => `${String(d.year).padStart(4, '0')}-${pad2(d.month)}-${pad2(d.day)}`;
const dateNum = (d) => d.year * 10000 + d.month * 100 + d.day;

// Date.UTC treats years 0-99 as 1900+year; setUTCFullYear avoids the trap.
// The base year must be a leap year: building on 1900 rolls Feb 29 to Mar 1
// before setUTCFullYear can correct it, so every Feb-29 instant shifts +1 day.
const utcMs = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => {
  const dt = new Date(Date.UTC(2000, mo - 1, d, h, mi, s, ms));
  dt.setUTCFullYear(y);
  return dt.getTime();
};

const fail = (code, path, message) => {
  throw new TransitError(code, path, message);
};

// --- rule-table views ---------------------------------------------------------

// Same tables natal.mjs indexes; transit pillars reuse the identical
// ten-god/stage/hidden-stem math so candidate-relative values match natal's.
const indexTables = (rules) => {
  const hidden = rules.tables.hiddenStems;
  const stageTable = rules.tables.twelveStages;
  return {
    rules,
    stems: rules.labels.stems,
    branches: rules.labels.branches,
    stemByHanzi: new Map(rules.labels.stems.map((s) => [s.hanzi, s])),
    branchByHanzi: new Map(rules.labels.branches.map((b) => [b.hanzi, b])),
    tenGodByHanzi: new Map(rules.labels.tenGods.map((g) => [g.hanzi, g])),
    stageByHanzi: new Map(rules.labels.twelveStages.map((s) => [s.hanzi, s])),
    hiddenRank: hidden.rankOrder,
    hiddenWeights: hidden.weights,
    stageOrder: stageTable.order,
    stageStart: new Map(Object.entries(stageTable.startsAndDirections)),
    tenGodTable: rules.tables.tenGods,
  };
};

const hiddenStemsOf = (T, branchHanzi) => {
  const stems = T.hiddenRank[branchHanzi];
  const w = stems.length === 1
    ? T.hiddenWeights.single
    : stems.length === 3 ? T.hiddenWeights.triple : T.hiddenWeights.double;
  const weights = Array.isArray(w) ? w : [w];
  return stems.map((hanzi, i) => {
    if (!Number.isFinite(weights[i])) {
      throw new TransitError(
        'INVALID_RULE_TABLE', 'rules.hiddenStems',
        `hidden-stem weights desync for branch ${branchHanzi}: rank ${i + 1} has no finite weight`,
      );
    }
    return {
      rank: i + 1,
      stem: T.stemByHanzi.get(hanzi),
      weightTenths: Math.round(weights[i] * 10),
    };
  });
};

// Plain pillar (no day-master-relative fields): the shared, natal-independent
// shape reported in pillarCandidates.
const plainPillar = (T, id, index, stemIdx, branchIdx) => {
  const stem = T.stems[stemIdx];
  const branch = T.branches[branchIdx];
  return {
    id,
    index,
    stem,
    branch,
    ganZhi: `${stem.hanzi}${branch.hanzi}`,
    korean: `${stem.korean}${branch.korean}`,
  };
};

// Candidate-relative pillar: the plain pillar plus ten gods, hidden stems
// with per-hidden gods/stages, and twelve stages evaluated against the
// candidate's day stem. Transit stems are never labeled 日主.
const enrichPillar = (T, pillar, dayStem) => {
  const branchHanzi = pillar.branch.hanzi;
  const hiddenStems = hiddenStemsOf(T, branchHanzi).map((h) => ({
    ...h,
    tenGod: T.tenGodByHanzi.get(stemTenGod(T, dayStem, h.stem.hanzi)),
    stage: T.stageByHanzi.get(twelveStage(T, h.stem.hanzi, branchHanzi)),
  }));
  return {
    ...pillar,
    stemTenGod: T.tenGodByHanzi.get(stemTenGod(T, dayStem, pillar.stem.hanzi)),
    hiddenStems,
    branchTenGod: T.tenGodByHanzi.get(stemTenGod(T, dayStem, hiddenStems[0].stem.hanzi)),
    dayStemStage: T.stageByHanzi.get(twelveStage(T, dayStem, branchHanzi)),
    stemStage: T.stageByHanzi.get(twelveStage(T, pillar.stem.hanzi, branchHanzi)),
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

// Same boundary rules as natal.mjs: the saju year changes at the February
// jie (Ipchun) — January always belongs to the prior year — and the month
// branch advances at each month's own jie; 'before' keeps the previous
// month. Equality belongs to the new period.
const sajuYearFor = (year, month, side) =>
  (month === 2 ? year - (side === 'before' ? 1 : 0) : year - (month === 1 ? 1 : 0));
const monthBranchFor = (month, side) => mod(month - (side === 'before' ? 1 : 0), 12);

// Signed seconds the zone is ahead of UTC at the instant, computed from
// --- input normalization --------------------------------------------------------

// Accepts either raw RFC3339 strings (validated here) or the normalized
// target objects produced by input.mjs validateRequest ({text, instantMs,
// offsetSeconds, localDate}). Returns one record per target, input order
// and duplicates retained.
const normalizeTargets = (targets) => {
  if (!Array.isArray(targets)) {
    fail('INVALID_FIELD', 'queries.transits', 'transits must be an array of RFC3339 instants');
  }
  if (targets.length > MAX_TRANSITS) {
    fail(
      'TOO_MANY_TRANSITS', 'queries.transits',
      `transits allows at most ${MAX_TRANSITS} entries, got ${targets.length}`,
    );
  }
  return targets.map((value, index) => {
    const path = `queries.transits[${index}]`;
    if (typeof value === 'string') {
      const parsed = parseRfc3339Instant(value);
      if (!parsed) {
        fail('INVALID_TRANSIT', path, `not an RFC3339 instant with explicit offset: ${JSON.stringify(value)}`);
      }
      return { index, text: parsed.text, instantMs: parsed.instantMs, offsetSeconds: parsed.offsetSeconds };
    }
    if (value !== null && typeof value === 'object' && Number.isInteger(value.instantMs)) {
      return {
        index,
        text: typeof value.text === 'string' ? value.text : isoOf(value.instantMs),
        instantMs: value.instantMs,
        offsetSeconds: Number.isInteger(value.offsetSeconds) ? value.offsetSeconds : null,
      };
    }
    fail('INVALID_TRANSIT', path, `not an RFC3339 instant with explicit offset: ${JSON.stringify(value)}`);
    return null; // unreachable
  });
};

const validateBirth = (birth) => {
  if (!birth || typeof birth !== 'object' || typeof birth.timezone !== 'string'
      || !birth.date || !Number.isInteger(birth.date.year)
      || !Number.isInteger(birth.date.month) || !Number.isInteger(birth.date.day)
      || birth.date.month < 1 || birth.date.month > 12
      || birth.date.day < 1 || birth.date.day > daysInMonth(birth.date.year, birth.date.month)) {
    fail(
      'INVALID_INPUT', 'birth',
      `birth needs {date:{year,month,day}, timezone}, got ${JSON.stringify(birth)}`,
    );
  }
  return { date: birth.date, timezone: birth.timezone };
};

// --- per-transit derivation -----------------------------------------------------

// Completed solar years at the target's local date in the birth zone. The
// increment happens at the start of the anniversary civil date; for a Feb 29
// birth the anniversary in a non-leap year is March 1. Before the solar
// birth date the result is null/BEFORE_BIRTH_DATE, never negative.
const transitAge = (birthDate, localDate, timezone) => {
  const base = {
    system: TRANSIT_AGE_SYSTEM,
    asOfDate: dateText(localDate),
    timezone,
    anniversaryPolicy: TRANSIT_AGE_ANNIVERSARY_POLICY,
  };
  if (dateNum(localDate) < dateNum(birthDate)) {
    return { ...base, years: null, reason: BEFORE_BIRTH_DATE };
  }
  let years = localDate.year - birthDate.year;
  // The anniversary is the birth month/day; for a Feb 29 birth in a non-leap
  // year the declared policy moves it to March 1 (never Feb 28).
  const feb29 = birthDate.month === 2 && birthDate.day === 29
    && daysInMonth(localDate.year, 2) === 28;
  const anniversaryNum = localDate.year * 10000
    + (feb29 ? 3 : birthDate.month) * 100 + (feb29 ? 1 : birthDate.day);
  if (dateNum(localDate) < anniversaryNum) years -= 1;
  return { ...base, years, reason: null };
};

// The annual/monthly/daily pillar set for one side of the month's jie.
const pillarSetFor = (T, wall, side, dayIdx) => {
  const sajuYear = sajuYearFor(wall.year, wall.month, side);
  const monthBranchIdx = monthBranchFor(wall.month, side);
  const yearStemIdx = mod(sajuYear - 4, 10);
  const yearBranchIdx = mod(sajuYear - 4, 12);
  const monthStemIdx = mod(
    firstInMonthStemIndex(yearStemIdx) + mod(monthBranchIdx - 2, 12), 10,
  );
  return {
    annual: plainPillar(T, 'transit.annual', 0, yearStemIdx, yearBranchIdx),
    monthly: plainPillar(T, 'transit.monthly', 1, monthStemIdx, monthBranchIdx),
    daily: plainPillar(T, 'transit.daily', 2, dayIdx % 10, dayIdx % 12),
  };
};

// --- active major-cycle membership ----------------------------------------------

const cycleIdCmp = (a, b) => Number(a.slice(a.indexOf('.') + 1)) - Number(b.slice(b.indexOf('.') + 1));

// Membership of one instant in one candidate's cycles. definite: inside
// [start.latest, end.earliest); possible: inside [start.earliest,
// end.latest). End bounds are exclusive, so an instant exactly on a cycle
// end belongs to the next cycle.
const activeMajorCycle = (majorCycles, candidateIndex, instantMs) => {
  const empty = { id: null, definiteCycleIds: [], candidateCycleIds: [] };
  if (!majorCycles || !Number.isInteger(majorCycles.count) || majorCycles.count === 0) {
    return { status: 'not_requested', ...empty };
  }
  const cand = (majorCycles.candidates ?? []).find((c) => c.candidateIndex === candidateIndex);
  if (majorCycles.available === false || !cand || !Array.isArray(cand.ranges)) {
    return { status: 'unavailable', ...empty };
  }
  const definite = new Set();
  const possible = new Set();
  for (const range of cand.ranges) {
    for (const cycle of range.cycles ?? []) {
      const s = cycle.interval.start;
      const e = cycle.interval.end;
      if (instantMs >= s.earliest.instantMs && instantMs < e.latest.instantMs) {
        possible.add(cycle.id);
      }
      if (instantMs >= s.latest.instantMs && instantMs < e.earliest.instantMs) {
        definite.add(cycle.id);
      }
    }
  }
  const candidateCycleIds = [...possible].sort(cycleIdCmp);
  const definiteCycleIds = [...definite].sort(cycleIdCmp);
  if (candidateCycleIds.length === 0) {
    return { status: 'none', ...empty, candidateCycleIds, definiteCycleIds };
  }
  if (candidateCycleIds.length === 1 && definiteCycleIds.length === 1) {
    return { status: 'determinate', id: candidateCycleIds[0], candidateCycleIds, definiteCycleIds };
  }
  return { status: 'ambiguous', ...empty, candidateCycleIds, definiteCycleIds };
};

// --- relation delta ---------------------------------------------------------------

const MAJOR_ID = /^major\./;
const sourceOf = (id) => id.split('.')[0];

// Sorted unique occurrence namespaces of a relation record, including a
// gongmang record's reference occurrence.
const sourcesOf = (record) => {
  const set = new Set(record.occurrenceIds.map(sourceOf));
  if (typeof record.referenceOccurrenceId === 'string') {
    set.add(sourceOf(record.referenceOccurrenceId));
  }
  return [...set].sort();
};

// Relations among natal + possible major cycles + transit pillars for one
// natal candidate and one pillar set. Natal-only records are excluded (they
// are natal structure, not transit activation) and records spanning two or
// more distinct major.* occurrences are excluded (alternative cycles never
// co-occur). Occurrence order is stable: natal year/month/day/hour, then
// major cycles in id order, then annual/monthly/daily.
const contextRelations = (candidate, possibleCycles, pillars, relationRules) => {
  const occurrences = [];
  for (const key of ['year', 'month', 'day', 'hour']) {
    const p = candidate.pillars[key];
    if (p !== null && p !== undefined) {
      occurrences.push({ id: p.id, stem: p.stem.hanzi, branch: p.branch.hanzi });
    }
  }
  for (const cycle of possibleCycles) {
    occurrences.push({
      id: cycle.id,
      stem: cycle.pillar.stem.hanzi,
      branch: cycle.pillar.branch.hanzi,
    });
  }
  for (const key of TRANSIT_PILLAR_ORDER) {
    const p = pillars[key];
    occurrences.push({ id: p.id, stem: p.stem.hanzi, branch: p.branch.hanzi });
  }

  return detectRelations(occurrences, relationRules)
    .map((r) => ({ ...r, sources: sourcesOf(r) }))
    .filter((r) => !(r.sources.length === 1 && r.sources[0] === 'natal'))
    .filter((r) => new Set(r.occurrenceIds.filter((id) => MAJOR_ID.test(id))).size <= 1);
};

// All cycles of one candidate that could contain the instant, deduplicated
// by cycle id (ranges of one candidate share the same pillar sequence).
const possibleCycleObjects = (majorCandidate, instantMs) => {
  const byId = new Map();
  for (const range of majorCandidate?.ranges ?? []) {
    for (const cycle of range.cycles ?? []) {
      const s = cycle.interval.start;
      const e = cycle.interval.end;
      if (instantMs >= s.earliest.instantMs && instantMs < e.latest.instantMs) {
        if (!byId.has(cycle.id)) byId.set(cycle.id, cycle);
      }
    }
  }
  return [...byId.values()].sort((a, b) => cycleIdCmp(a.id, b.id));
};

// Computes dated transits for one birth input.
//
//   computeTransits({birth, targets, natal?, majorCycles?, calendar?, rules?,
//                    relationRules?})
//     birth:       {date:{year,month,day}, timezone} — the SOLAR birth date
//                  (lunar conversion is the caller's job) and the zone that
//                  defines every transit's local periods and age.
//     targets:     array of RFC3339 instants (strings, or normalized target
//                  objects from input.mjs). At most 366; request order and
//                  duplicates are retained.
//     natal:       optional deriveNatal result; when present each transit
//                  gets `contexts` — per-candidate enriched pillars, active
//                  major-cycle membership and relation deltas.
//     majorCycles: optional computeMajorCycles result for active-cycle
//                  context; never recomputed or manufactured here.
//     calendar:    injectable {findSolarTerm({year,month})}; default
//                  createCalendar().
//     rules:       injectable parsed rules.json (default: loaded from disk).
//     relationRules: injectable parsed relation-rules.json.
//
// Returns {transits[], limitations[]}. Each item carries index, input text,
// instantMs/iso, the birth-zone local fields, age, pillarCandidates (one or
// two on SOLAR_TERM_UNCERTAINTY) and contexts. Limitations are stable
// {code,path,details} records sorted by code then path.
export const computeTransits = ({
  birth,
  targets,
  natal,
  majorCycles,
  calendar,
  rules,
  relationRules,
}) => {
  const { date: birthDate, timezone } = validateBirth(birth);
  const normalized = normalizeTargets(targets);
  const ruleSet = rules ?? loadNatalRules();
  const T = indexTables(ruleSet);
  const relRules = relationRules ?? loadRelationRules();
  const cal = calendar ?? createCalendar();
  const limitations = [];

  const natalCandidates = natal && Array.isArray(natal.candidates) ? natal.candidates : [];

  const items = normalized.map((target) => {
    const path = `queries.transits[${target.index}]`;
    const wall = wallFieldsAt(timezone, target.instantMs, path);
    const localDate = { year: wall.year, month: wall.month, day: wall.day };
    const localText = dateText(localDate);
    if (localText < SOLAR_RANGE.min || localText > SOLAR_RANGE.max) {
      fail(
        'TRANSIT_OUT_OF_RANGE', path,
        `instant ${target.text} falls on ${localText} in ${timezone}, outside ${SOLAR_RANGE.min}..${SOLAR_RANGE.max}`,
      );
    }

    const term = termInfo(cal.findSolarTerm({ year: wall.year, month: wall.month }));
    const bandMs = term.uncertaintySeconds * 1000;
    const sides = Math.abs(target.instantMs - term.instantMs) <= bandMs
      ? ['before', 'after']
      : [target.instantMs < term.instantMs ? 'before' : 'after'];
    const uncertain = sides.length === 2;
    if (uncertain) {
      limitations.push({
        code: 'SOLAR_TERM_UNCERTAINTY',
        path,
        details: {
          eventId: term.eventId,
          termId: term.termId,
          termIso: term.iso,
          uncertaintySeconds: term.uncertaintySeconds,
        },
      });
    }

    const dayIdx = dayCycleIndex(localDate);
    const pillarCandidates = sides.map((side, k) => ({
      index: k,
      side,
      uncertain,
      boundary: term,
      pillars: pillarSetFor(T, wall, side, dayIdx),
    }));

    const contexts = [];
    for (const [candidateIndex, candidate] of natalCandidates.entries()) {
      const dayStem = candidate.pillars.day.stem.hanzi;
      const active = activeMajorCycle(majorCycles, candidateIndex, target.instantMs);
      const majorCandidate = (majorCycles?.candidates ?? [])
        .find((c) => c.candidateIndex === candidateIndex);
      const possibleCycles = possibleCycleObjects(majorCandidate, target.instantMs);
      for (const pc of pillarCandidates) {
        contexts.push({
          candidateIndex,
          pillarCandidateIndex: pc.index,
          pillars: Object.fromEntries(TRANSIT_PILLAR_ORDER.map((key) => [
            key,
            enrichPillar(T, pc.pillars[key], dayStem),
          ])),
          activeMajorCycle: active,
          relations: contextRelations(candidate, possibleCycles, pc.pillars, relRules),
        });
      }
    }

    return {
      index: target.index,
      input: target.text,
      instantMs: target.instantMs,
      iso: isoOf(target.instantMs),
      timezone,
      local: {
        ...localDate,
        date: localText,
        hour: wall.hour,
        minute: wall.minute,
        second: wall.second,
        utcOffset: formatUtcOffset(offsetSecondsAt(timezone, target.instantMs, 'birth.timezone')),
      },
      age: transitAge(birthDate, localDate, timezone),
      pillarCandidates,
      contexts,
    };
  });

  limitations.sort((a, b) => (a.code === b.code
    ? (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    : a.code < b.code ? -1 : 1));

  return { transits: items, limitations };
};
