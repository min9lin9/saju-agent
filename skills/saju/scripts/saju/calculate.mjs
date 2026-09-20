// calculate.mjs — library composition for the deterministic saju result.
//
// Pipeline (pure, importable without side effects — all file reads happen
// inside functions, never at module top level):
//   validateRequest            input.mjs: shape, ranges, leap flag, instants
//   lunarToSolar               calendar.mjs: korean_lunar -> solar; a failed
//                              conversion or a solar result outside the
//                              declared 1900-01-01..2100-12-31 range rejects
//   resolveCivilTime           time.mjs: one UTC instant for a known wall
//                              time (injected into deriveNatal so the
//                              calendar section and natal share the exact
//                              same resolution); null time stays unresolved
//   deriveNatal                natal.mjs: candidates, pillars, counts,
//                              relations, per-candidate jie boundary
//   computeMajorCycles         major-cycles.mjs: direction/start/cycles;
//                              the ONLY source of MISSING_MAJOR_DIRECTION,
//                              emitted solely when queries.majorCycles > 0
//   computeTransits            transits.mjs: dated pillars, age, contexts;
//                              cycles are passed through, never manufactured
//
// Assembled result field order is the contract order:
//   {schemaVersion:1, rulesetId:"kr-civil-midnight-v1", provenance, input,
//    calendar, natal, majorCycles, transits, limitations}
//
// provenance carries exact declared+resolved package versions, SHA256 of
// the canonical (stable-stringify-v1) rules.json and relation-rules.json,
// process.versions node/icu/tz (tz explicitly null when absent), the
// calendar-converter ID and the ephemeris ID.
//
// limitations merge natal + cycles + transits + assembly records, dedupe by
// {code,path,details} and sort by code then path.
//
// Error contract: module typed errors (InputError/TimeError/CalendarError/
// NatalError/MajorCycleError/TransitError) propagate unchanged with their
// {code,path}; the CLI maps them to exit 2.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { InputError, validateRequest } from './input.mjs';
import { resolveCivilTime } from './time.mjs';
import {
  LUNAR_METADATA_LIMITATION,
  LUNAR_METADATA_MAX_SOLAR,
  createCalendar,
} from './calendar.mjs';
import { deriveNatal, loadNatalRules } from './natal.mjs';
import { computeMajorCycles } from './major-cycles.mjs';
import { computeTransits } from './transits.mjs';
import { loadRelationRules } from './relations.mjs';
import { CANONICALIZATION_ID, canonicalStringify } from './serialize.mjs';

// Declared solar support range (same contract constant input.mjs enforces;
// restated here for the post-conversion lunar check).
const SOLAR_RANGE = { min: '1900-01-01', max: '2100-12-31' };

const PACKAGE_JSON_URL = new URL('../package.json', import.meta.url);
const PACKAGE_LOCK_URL = new URL('../package-lock.json', import.meta.url);

const pad2 = (n) => String(n).padStart(2, '0');
const dateText = (d) => `${String(d.year).padStart(4, '0')}-${pad2(d.month)}-${pad2(d.day)}`;
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// --- provenance -----------------------------------------------------------------

// Exact package versions from package.json (declared) and package-lock.json
// (resolved), canonical rule-table hashes, runtime versions and the two
// upstream component IDs. Deterministic for a fixed install: identical input
// AND provenance yield byte-identical output; no cross-runtime identity is
// claimed.
const buildProvenance = (rules, relationRules) => {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_URL, 'utf8'));
  const lock = JSON.parse(readFileSync(PACKAGE_LOCK_URL, 'utf8'));
  const packages = {};
  for (const name of Object.keys(pkg.dependencies ?? {}).sort()) {
    packages[name] = {
      declared: pkg.dependencies[name],
      resolved: lock.packages?.[`node_modules/${name}`]?.version ?? null,
    };
  }
  return {
    packages,
    ruleTables: {
      'saju/rules.json': {
        sha256: sha256(canonicalStringify(rules)),
        canonicalization: CANONICALIZATION_ID,
      },
      'saju/relation-rules.json': {
        sha256: sha256(canonicalStringify(relationRules)),
        canonicalization: CANONICALIZATION_ID,
      },
    },
    runtime: {
      node: process.versions.node,
      icu: process.versions.icu ?? null,
      tz: process.versions.tz ?? null,
    },
    calendarConverter: {
      id: 'korean-lunar-calendar',
      version: packages['korean-lunar-calendar']?.resolved ?? null,
    },
    ephemeris: {
      id: 'astronomy-engine',
      version: packages['astronomy-engine']?.resolved ?? null,
    },
  };
};

// --- calendar section -------------------------------------------------------------

// The candidate's recorded boundary jie plus the adjacent terms (previous
// and next month), deduplicated by eventId and sorted by instantMs. Every
// entry carries its UTC instant and event ID.
const surroundingJieEvents = (natal, solarDate, calendar) => {
  const byId = new Map();
  const add = (term, role) => {
    if (!term) return;
    const eventId = term.eventId ?? `${term.year}-${term.termId}`;
    if (byId.has(eventId)) return;
    byId.set(eventId, {
      eventId,
      termId: term.termId ?? null,
      role,
      iso: term.iso ?? new Date(term.instantMs).toISOString(),
      instantMs: term.instantMs,
      uncertaintySeconds: term.uncertaintySeconds ?? null,
    });
  };
  for (const candidate of natal.candidates ?? []) {
    add(candidate.boundary, 'boundary');
  }
  const { year, month } = solarDate;
  add(
    calendar.findSolarTerm({
      year: month === 1 ? year - 1 : year,
      month: month === 1 ? 12 : month - 1,
    }),
    'previous',
  );
  add(
    calendar.findSolarTerm({
      year: month === 12 ? year + 1 : year,
      month: month === 12 ? 1 : month + 1,
    }),
    'next',
  );
  return [...byId.values()].sort((a, b) => a.instantMs - b.instantMs);
};

// --- sections ---------------------------------------------------------------------

// The validated request echoed back with original text fields.
const inputSection = (request) => ({
  schemaVersion: request.schemaVersion,
  birth: {
    calendar: request.birth.calendar,
    date: request.birth.date.text,
    leapMonth: request.birth.leapMonth,
    time: request.birth.time === null ? null : request.birth.time.text,
    timezone: request.birth.timezone,
    utcOffset: request.birth.utcOffset === null ? null : request.birth.utcOffset.text,
    gender: request.birth.gender,
  },
  queries: {
    majorCycles: request.queries.majorCycles,
    transits: request.queries.transits.map((t) => t.text),
  },
});

// Dedupe by {code,path,details} (canonical key, undefined normalized to
// null), then sort by code then path with a canonical tiebreak for a total
// deterministic order.
const mergeLimitations = (lists) => {
  const byKey = new Map();
  for (const lim of lists.flat()) {
    const key = canonicalStringify({
      code: lim.code, path: lim.path, details: lim.details,
    });
    if (!byKey.has(key)) byKey.set(key, lim);
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    const ka = canonicalStringify(a.details);
    const kb = canonicalStringify(b.details);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
};

// --- assembly ---------------------------------------------------------------------

// Runs the full pipeline for one raw request object and returns the
// assembled result in contract field order. Throws the modules' typed
// errors unchanged; never catches, never falls back.
export const calculate = (raw) => {
  const request = validateRequest(raw);
  const rules = loadNatalRules();
  const relationRules = loadRelationRules();
  const calendar = createCalendar();
  const birth = request.birth;
  const assemblyLimitations = [];

  // Korean lunar input converts first; the solar result must land inside
  // the declared support range.
  let solarDate;
  if (birth.calendar === 'korean_lunar') {
    const converted = calendar.lunarToSolar({
      year: birth.date.year,
      month: birth.date.month,
      day: birth.date.day,
      leapMonth: birth.leapMonth,
    });
    const text = dateText(converted);
    if (text < SOLAR_RANGE.min || text > SOLAR_RANGE.max) {
      throw new InputError(
        'DATE_OUT_OF_RANGE', 'birth.date',
        `lunar ${birth.date.text} converts to solar ${text}, outside`
          + ` ${SOLAR_RANGE.min}..${SOLAR_RANGE.max}`,
      );
    }
    solarDate = converted;
  } else {
    solarDate = { year: birth.date.year, month: birth.date.month, day: birth.date.day };
  }
  const solarText = dateText(solarDate);

  // One civil-time resolution shared by the calendar section and natal.
  let resolved = null;
  if (birth.time !== null) {
    resolved = resolveCivilTime({
      date: solarDate,
      time: birth.time,
      timezone: birth.timezone,
      utcOffset: birth.utcOffset === null ? undefined : birth.utcOffset.seconds,
    });
  }

  const natal = deriveNatal({
    date: solarDate,
    time: birth.time,
    timezone: birth.timezone,
    utcOffset: birth.utcOffset === null ? undefined : birth.utcOffset.seconds,
    calendar,
    resolveTime: resolved === null ? undefined : () => resolved,
    rules,
  });

  // Korean lunar metadata for the solar birth date; beyond the converter's
  // coverage this is a limitation, never a failed solar calculation.
  const lunar = calendar.solarToLunar(solarDate);
  if (lunar === null) {
    assemblyLimitations.push({
      code: LUNAR_METADATA_LIMITATION,
      path: 'birth.date',
      details: { solarDate: solarText, maxSolarDate: LUNAR_METADATA_MAX_SOLAR },
    });
  }

  const majorCycles = computeMajorCycles({
    birth: { date: solarDate, timezone: birth.timezone, gender: birth.gender },
    natal,
    count: request.queries.majorCycles,
    calendar,
    rules,
  });

  const transitResult = computeTransits({
    birth: { date: solarDate, timezone: birth.timezone },
    targets: request.queries.transits,
    natal,
    majorCycles,
    calendar,
    rules,
    relationRules,
  });

  const { rulesetId, dayMaster, candidates, coverageComplete } = natal;
  const {
    limitations: _cycleLimitations,
    ...majorCyclesSection
  } = majorCycles;

  return {
    schemaVersion: 1,
    rulesetId,
    provenance: buildProvenance(rules, relationRules),
    input: inputSection(request),
    calendar: {
      supplied: {
        calendar: birth.calendar,
        date: birth.date.text,
        leapMonth: birth.leapMonth,
        time: birth.time === null ? null : birth.time.text,
        timezone: birth.timezone,
        utcOffset: birth.utcOffset === null ? null : birth.utcOffset.text,
      },
      solarDate: solarText,
      lunar,
      resolvedInstant: resolved === null
        ? null
        : {
          iso: resolved.iso,
          instantMs: resolved.instantMs,
          utcOffset: resolved.utcOffset,
          ambiguous: resolved.ambiguous,
        },
      jieEvents: surroundingJieEvents(natal, solarDate, calendar),
    },
    natal: { dayMaster, candidates, coverageComplete },
    majorCycles: majorCyclesSection,
    transits: transitResult.transits,
    limitations: mergeLimitations([
      assemblyLimitations,
      natal.limitations,
      majorCycles.limitations,
      transitResult.limitations,
    ]),
  };
};
