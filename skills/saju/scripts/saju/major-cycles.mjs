// major-cycles.mjs — major-cycle (대운) direction, start instants and intervals.
//
// Policy (kr-civil-midnight-v1, convention id three-days-calendar-v1):
//   direction   yang year-stem + male OR yin year-stem + female => forward,
//               otherwise reverse. Evaluated per natal candidate: candidates
//               split at Ipchun can carry different year stems and therefore
//               different directions. Gender is never defaulted; a missing
//               gender with count > 0 yields available:false plus a
//               MISSING_MAJOR_DIRECTION limitation and no cycles.
//   distance    UTC milliseconds from the birth instant to the adjacent jie
//               in the cycle direction, inclusive: forward uses the birth
//               month's own jie when t <= T0 else the next month's jie;
//               reverse uses the own jie when t >= T0 else the previous
//               month's jie. Exact equality is distance zero. Middle qi are
//               never used. Distances are compared as exact milliseconds.
//   start age   distanceSeconds / 259200 nominal years (3 days = 1 year).
//               Decomposed by exact integer math on distanceMs: nominalMs =
//               distanceMs * 120; years = /360d, residual months = /30d,
//               residual days = /1d, remainder to seconds. The displayed age
//               is never rounded back into the calculation.
//   start date  birth wall time + years, then months (day clamped to the
//               target month at each step), then local days, then remaining
//               seconds in the time of day. The resulting wall time resolves
//               in the birth zone: a nonexistent wall time (DST gap) advances
//               by the gap; a repeated wall time takes the earlier
//               occurrence. The applied policy is recorded per instant.
//   cycles      first cycle pillar is the month pillar advanced one
//               sexagenary step in the cycle direction; cycle i starts at the
//               derived start instant plus 10i local calendar years (day
//               clamped). End intervals are exclusive.
//   unknown     birth time: each natal candidate carries a possible-instant
//               interval, so the start is a RANGE, never a midpoint. The
//               interval is split at the month's own jie instant — the only
//               point where the inclusive adjacent jie (and the distance
//               function) changes — and each piece is evaluated at its
//               endpoints, producing per-piece start ranges associated with
//               the candidate index.
//
// Error contract: failures are MajorCycleError with stable {code,path};
// upstream CalendarError/TimeError propagate unchanged.

import {
  daysInMonth,
  formatUtcOffset,
  wallFieldsAt,
} from './time.mjs';
import { createCalendar } from './calendar.mjs';
import { loadNatalRules } from './natal.mjs';

export class MajorCycleError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'MajorCycleError';
    this.code = code;
    this.path = path;
  }
}

export const MAJOR_CYCLE_CONVENTION = 'three-days-calendar-v1';
export const SECONDS_PER_NOMINAL_YEAR = 259200; // 3 days distance = 1 nominal year
export const MISSING_MAJOR_DIRECTION = 'MISSING_MAJOR_DIRECTION';
export const MAX_MAJOR_CYCLES = 12;

const DIRECTION_RULE = 'yang_year_male_or_yin_year_female_forward';
const CYCLE_YEARS = 10;

// Nominal calendar runs 12x faster than the distance clock: 360 nominal days
// of 86400 s per 259200 s of jie distance (1 distance second = 120 nominal
// seconds). All decomposition is exact integer math on distanceMs.
const NOMINAL_PER_DISTANCE = 120;
const NOMINAL_YEAR_MS = 360 * 86400 * 1000; // 31_104_000_000
const NOMINAL_MONTH_MS = 30 * 86400 * 1000; //  2_592_000_000
const DAY_MS = 86400 * 1000;

// Same enumeration window/sampling as time.mjs: covers every real zone
// offset plus margin for historic LMT.
const WINDOW_MS = 48 * 3600 * 1000;
const SAMPLE_MS = 15 * 60 * 1000;

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

const addDays = (d, n) => {
  const dt = new Date(utcMs(d.year, d.month, d.day) + n * DAY_MS);
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
};

// Civil wall fields of an instant including the millisecond remainder.
const wallWithMs = (timezone, instantMs, path) => ({
  ...wallFieldsAt(timezone, instantMs, path),
  ms: mod(instantMs, 1000),
});

// The wall fields interpreted on the UTC timeline, for comparisons.
const wallMsOf = (w) => utcMs(w.year, w.month, w.day, w.hour, w.minute, w.second, w.ms ?? 0);
const wallMsAt = (timezone, instantMs, path) => wallMsOf(wallWithMs(timezone, instantMs, path));

// Signed seconds the zone is ahead of UTC at the instant. time.mjs
// offsetSecondsAt compares a second-truncated wall against the exact
// instant, which yields fractional pseudo-offsets for millisecond
// instants; this module compares ms-exact walls, so real zone offsets
// (always whole seconds) come out exact.
const offsetSecondsExact = (timezone, instantMs, path) =>
  (wallMsAt(timezone, instantMs, path) - instantMs) / 1000;

const distinctOffsets = (timezone, guessMs, path) => {
  const offsets = new Set();
  for (let t = guessMs - WINDOW_MS; t <= guessMs + WINDOW_MS; t += SAMPLE_MS) {
    offsets.add(offsetSecondsExact(timezone, t, path));
  }
  return offsets;
};

// --- declared conversions -------------------------------------------------------

// Decomposes a jie distance into the nominal {years,months,days,seconds}
// calendar age. Exact integer math: distanceMs * 120 nominal milliseconds.
export const decomposeNominalAge = (distanceMs) => {
  const nominalMs = distanceMs * NOMINAL_PER_DISTANCE;
  const years = Math.floor(nominalMs / NOMINAL_YEAR_MS);
  const rem1 = nominalMs - years * NOMINAL_YEAR_MS;
  const months = Math.floor(rem1 / NOMINAL_MONTH_MS);
  const rem2 = rem1 - months * NOMINAL_MONTH_MS;
  const days = Math.floor(rem2 / DAY_MS);
  const seconds = (rem2 - days * DAY_MS) / 1000;
  return { years, months, days, seconds };
};

// Adds a nominal age to a wall time in the stipulated order: years, then
// months — the day is clamped to the target month's length at each step —
// then local days, then the remaining seconds into the time of day.
const addNominalAge = (wall, age) => {
  const y1 = wall.year + age.years;
  const d1 = Math.min(wall.day, daysInMonth(y1, wall.month));
  const totalMonths = y1 * 12 + (wall.month - 1) + age.months;
  const y2 = Math.floor(totalMonths / 12);
  const mo2 = mod(totalMonths, 12) + 1;
  const d2 = Math.min(d1, daysInMonth(y2, mo2));
  let date = addDays({ year: y2, month: mo2, day: d2 }, age.days);
  const todMs = (wall.hour * 3600 + wall.minute * 60 + wall.second) * 1000
    + (wall.ms ?? 0) + Math.round(age.seconds * 1000);
  const extraDays = Math.floor(todMs / DAY_MS);
  if (extraDays > 0) date = addDays(date, extraDays);
  const tod = mod(todMs, DAY_MS);
  return {
    ...date,
    hour: Math.floor(tod / 3600000),
    minute: Math.floor(tod / 60000) % 60,
    second: Math.floor(tod / 1000) % 60,
    ms: tod % 1000,
  };
};

// Adds whole local calendar years to a wall time, clamping the day to the
// target month (Feb 29 + n years lands on Feb 28 in non-leap years).
const addLocalYears = (wall, years) => ({
  year: wall.year + years,
  month: wall.month,
  day: Math.min(wall.day, daysInMonth(wall.year + years, wall.month)),
  hour: wall.hour,
  minute: wall.minute,
  second: wall.second,
  ms: wall.ms ?? 0,
});

// Resolves a target local wall time to an instant under the declared offset
// policy: an existing wall resolves to the earliest matching instant (a
// repeated wall time takes the earlier occurrence); a wall time skipped by a
// zone transition advances by the gap — the earliest offset-derived instant
// whose wall exceeds the target, which lands exactly gap-duration later.
const resolveStartWall = (timezone, wall, path) => {
  const target = wallMsOf(wall);
  const derived = [...distinctOffsets(timezone, target, path)]
    .map((off) => target - off * 1000)
    .sort((a, b) => a - b);
  const matches = derived.filter((c) => wallMsAt(timezone, c, path) === target);
  let instantMs;
  let offsetPolicy;
  if (matches.length > 0) {
    instantMs = matches[0];
    offsetPolicy = matches.length > 1 ? 'repeated_wall_time_earlier_occurrence' : 'exact';
  } else {
    const advanced = derived.filter((c) => wallMsAt(timezone, c, path) > target);
    if (advanced.length === 0) {
      throw new MajorCycleError(
        'START_WALL_UNRESOLVABLE', path,
        `no instant produces or follows wall ${JSON.stringify(wall)} in ${timezone}`,
      );
    }
    instantMs = advanced[0];
    offsetPolicy = 'nonexistent_wall_time_advanced_by_gap';
  }
  return {
    instantMs,
    iso: isoOf(instantMs),
    wall: wallWithMs(timezone, instantMs, path),
    utcOffset: formatUtcOffset(offsetSecondsExact(timezone, instantMs, path)),
    offsetPolicy,
  };
};

// --- adjacent jie and distance ----------------------------------------------------

// The jie term for one role relative to the birth month's own jie. 'current'
// reuses the candidate's recorded boundary (the exact term natal used);
// 'next'/'previous' query the adjacent months, rolling the year at
// December/January.
const jieForRole = (role, candidate, birth, cal) => {
  if (role === 'current') {
    const b = candidate.boundary;
    return {
      eventId: b.eventId ?? null,
      termId: b.termId ?? null,
      iso: b.iso ?? isoOf(b.instantMs),
      instantMs: b.instantMs,
      role,
    };
  }
  const { year, month } = birth.date;
  const ym = role === 'next'
    ? { year: month === 12 ? year + 1 : year, month: month === 12 ? 1 : month + 1 }
    : { year: month === 1 ? year - 1 : year, month: month === 1 ? 12 : month - 1 };
  const term = cal.findSolarTerm(ym);
  return {
    eventId: term.eventId ?? null,
    termId: term.termId ?? null,
    iso: term.iso ?? isoOf(term.instantMs),
    instantMs: term.instantMs,
    role,
  };
};

// Splits a candidate birth-instant interval [s,e) at the month's own jie
// instant T0 — the only point where the inclusive adjacent jie changes.
// Forward: t <= T0 uses the current jie, t > T0 the next. Reverse: t < T0
// uses the previous jie, t >= T0 the current. Each piece records which of
// its bounds are real possible instants versus open-interval limits.
const piecesFor = (direction, s, e, T0) => {
  const pieces = [];
  if (direction === 'forward') {
    if (s <= T0) {
      pieces.push({
        lo: s, hi: T0 < e ? T0 : e, jieRole: 'current',
        loInclusive: true, hiInclusive: T0 < e,
      });
    }
    if (T0 < e) {
      pieces.push({
        lo: Math.max(T0, s), hi: e, jieRole: 'next',
        loInclusive: s > T0, hiInclusive: false,
      });
    }
  } else {
    if (s < T0) {
      pieces.push({
        lo: s, hi: Math.min(T0, e), jieRole: 'previous',
        loInclusive: true, hiInclusive: false,
      });
    }
    if (T0 < e || T0 <= s) {
      pieces.push({
        lo: Math.max(T0, s), hi: e, jieRole: 'current',
        loInclusive: true, hiInclusive: false,
      });
    }
  }
  for (const p of pieces) {
    if (p.lo === p.hi) { p.loInclusive = true; p.hiInclusive = true; } // point interval
  }
  return pieces;
};

// Evaluates the start instant for one birth instant against one adjacent
// jie. The distance is exact milliseconds; a negative distance means the
// piece/jie pairing was constructed wrong and is an error, never clamped.
const evalStart = (timezone, instantMs, jie, direction, path) => {
  const distanceMs = direction === 'forward'
    ? jie.instantMs - instantMs
    : instantMs - jie.instantMs;
  if (distanceMs < 0) {
    throw new MajorCycleError(
      'NEGATIVE_JIE_DISTANCE', 'birth.date',
      `${direction} distance ${distanceMs} ms from ${isoOf(instantMs)} to jie ${jie.iso}`,
    );
  }
  const age = decomposeNominalAge(distanceMs);
  const birthWall = wallWithMs(timezone, instantMs, path);
  const resolved = resolveStartWall(timezone, addNominalAge(birthWall, age), path);
  return {
    ...resolved,
    distanceMs,
    distanceSeconds: distanceMs / 1000,
    nominalYears: distanceMs / (SECONDS_PER_NOMINAL_YEAR * 1000),
    age,
  };
};

// The boundary fields of a start endpoint, reused for cycle bounds.
const boundaryOf = (endpoint) => ({
  instantMs: endpoint.instantMs,
  iso: endpoint.iso,
  wall: endpoint.wall,
  utcOffset: endpoint.utcOffset,
  offsetPolicy: endpoint.offsetPolicy,
});

// Builds the `count` cycles for one evaluated range. Cycle i's pillar is the
// month pillar advanced (i+1)*step sexagenary steps; its interval is
// [start + 10i local years, start + 10(i+1) local years), end exclusive.
// Each bound is a {earliest,latest} pair resolved from the range endpoints.
const cyclesFor = (timezone, range, monthStemIdx, monthBranchIdx, step, count, T, path) => {
  const bounds = [];
  for (let i = 0; i <= count; i += 1) {
    if (i === 0) {
      bounds.push({
        earliest: boundaryOf(range.start.earliest),
        latest: boundaryOf(range.start.latest),
      });
    } else {
      bounds.push({
        earliest: resolveStartWall(timezone, addLocalYears(range.start.earliest.wall, CYCLE_YEARS * i), path),
        latest: resolveStartWall(timezone, addLocalYears(range.start.latest.wall, CYCLE_YEARS * i), path),
      });
    }
  }
  const cycles = [];
  for (let i = 0; i < count; i += 1) {
    const stem = T.stems[mod(monthStemIdx + step * (i + 1), 10)];
    const branch = T.branches[mod(monthBranchIdx + step * (i + 1), 12)];
    cycles.push({
      id: `major.${i}`,
      index: i,
      pillar: {
        stem,
        branch,
        ganZhi: `${stem.hanzi}${branch.hanzi}`,
        korean: `${stem.korean}${branch.korean}`,
      },
      interval: {
        start: bounds[i],
        end: bounds[i + 1],
        endExclusive: true,
      },
    });
  }
  return cycles;
};

// Evaluates one interval piece into a start range: both piece bounds are
// evaluated (the start mapping is monotonic within a piece, so the endpoints
// carry the extremes) and reported as {earliest,latest}, never a midpoint.
const rangeForPiece = (timezone, piece, jie, direction, index, monthIdx, step, count, T, path) => {
  const atLo = evalStart(timezone, piece.lo, jie, direction, path);
  const atHi = evalStart(timezone, piece.hi, jie, direction, path);
  const [earliest, latest] = atLo.instantMs <= atHi.instantMs ? [atLo, atHi] : [atHi, atLo];
  const range = {
    index,
    birthInstants: {
      startMs: piece.lo,
      endMs: piece.hi,
      startIso: isoOf(piece.lo),
      endIso: isoOf(piece.hi),
      startInclusive: piece.loInclusive,
      endInclusive: piece.hiInclusive,
    },
    adjacentJie: jie,
    distance: {
      minMs: Math.min(atLo.distanceMs, atHi.distanceMs),
      maxMs: Math.max(atLo.distanceMs, atHi.distanceMs),
      minSeconds: Math.min(atLo.distanceSeconds, atHi.distanceSeconds),
      maxSeconds: Math.max(atLo.distanceSeconds, atHi.distanceSeconds),
    },
    start: { earliest, latest },
  };
  range.cycles = cyclesFor(
    timezone, range, monthIdx.stem, monthIdx.branch, step, count, T, path,
  );
  return range;
};

// Computes major cycles for every natal candidate.
//
//   computeMajorCycles({birth, natal, count, calendar?, rules?})
//     birth:    {date:{year,month,day}, timezone, gender} — the same solar
//               date and zone given to deriveNatal; gender 'male'|'female'
//               or null/omitted (never defaulted).
//     natal:    deriveNatal result; each candidate supplies its pillar set,
//               possible-instant interval and recorded jie boundary.
//     count:    integer 0..12 cycles to emit.
//     calendar: injectable {findSolarTerm({year,month})} for adjacent jie;
//               default createCalendar().
//     rules:    injectable parsed rules.json (default: loaded from disk).
//
// Returns {available, convention, secondsPerNominalYear, cycleYears, count,
// candidates[], limitations[]}. Each candidate entry carries candidateIndex,
// side, direction, directionBasis and ranges[]; each range carries the
// birth-instant piece, the adjacent jie used, the raw distance bounds, the
// {earliest,latest} start instants and the cycle list. Missing gender with
// count > 0 returns available:false and a MISSING_MAJOR_DIRECTION
// limitation; the natal input is never mutated.
export const computeMajorCycles = ({ birth, natal, count, calendar, rules }) => {
  const path = 'birth.timezone';
  if (!birth || typeof birth !== 'object' || typeof birth.timezone !== 'string'
      || !birth.date || !Number.isInteger(birth.date.year) || !Number.isInteger(birth.date.month)) {
    throw new MajorCycleError(
      'INVALID_INPUT', 'birth',
      `birth needs {date:{year,month,day}, timezone, gender}, got ${JSON.stringify(birth)}`,
    );
  }
  if (!Number.isInteger(count) || count < 0 || count > MAX_MAJOR_CYCLES) {
    throw new MajorCycleError(
      'INVALID_VALUE', 'queries.majorCycles',
      `count must be an integer 0..${MAX_MAJOR_CYCLES}, got ${JSON.stringify(count)}`,
    );
  }
  const ruleSet = rules ?? loadNatalRules();
  const T = { stems: ruleSet.labels.stems, branches: ruleSet.labels.branches };
  const cal = calendar ?? createCalendar();
  const limitations = [];
  const base = {
    convention: MAJOR_CYCLE_CONVENTION,
    secondsPerNominalYear: SECONDS_PER_NOMINAL_YEAR,
    cycleYears: CYCLE_YEARS,
    count,
  };

  if (count === 0) {
    return { available: true, ...base, candidates: [], limitations };
  }
  if (birth.gender !== 'male' && birth.gender !== 'female') {
    limitations.push({
      code: MISSING_MAJOR_DIRECTION,
      path: 'birth.gender',
      details: {
        gender: birth.gender ?? null,
        reason: 'major-cycle direction requires birth.gender male|female; never defaulted',
      },
    });
    return { available: false, ...base, candidates: [], limitations };
  }

  const candidates = natal.candidates.map((cand, candidateIndex) => {
    const yearStem = cand.pillars.year.stem;
    const forward = (yearStem.polarity === 'yang') === (birth.gender === 'male');
    const direction = forward ? 'forward' : 'reverse';
    const step = forward ? 1 : -1;
    const monthIdx = {
      stem: T.stems.findIndex((s) => s.hanzi === cand.pillars.month.stem.hanzi),
      branch: T.branches.findIndex((b) => b.hanzi === cand.pillars.month.branch.hanzi),
    };
    const T0 = cand.boundary.instantMs;
    const ranges = piecesFor(direction, cand.interval.startMs, cand.interval.endMs, T0)
      .map((piece, index) => rangeForPiece(
        birth.timezone, piece,
        jieForRole(piece.jieRole, cand, birth, cal),
        direction, index, monthIdx, step, count, T, path,
      ));
    return {
      candidateIndex,
      side: cand.side ?? null,
      direction,
      directionBasis: {
        yearStem: { id: yearStem.id, hanzi: yearStem.hanzi, korean: yearStem.korean },
        yearPolarity: yearStem.polarity,
        gender: birth.gender,
        rule: DIRECTION_RULE,
      },
      ranges,
    };
  });

  return { available: true, ...base, candidates, limitations };
};
