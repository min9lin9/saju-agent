# Local saju calculation contract (saju.mjs)

`saju.mjs` is the deterministic calculation kernel of this skill. It computes
the natal chart (원국), major cycles (대운) and dated transits (세운·월운·일운)
locally, with no network, no ambient clock and no LLM involvement. Everything
it emits is a computed fact with provenance; everything it cannot compute is
an explicit limitation or a typed error.

The LLM's job is interpretation only. Never recalculate, estimate or fill in
any value this CLI could produce.

## Invocation

```bash
node skills/saju/scripts/saju.mjs --input <request.json>
node skills/saju/scripts/saju.mjs --help
```

Installed copy: `node <workspace>/skills/saju/scripts/saju.mjs --input <request.json>`.

- Reads one UTF-8 JSON object from the named file. `--input=<path>` also works.
- Exit 0: exactly one JSON result on stdout (full or partial success).
- Exit 2: empty stdout, one `{"error":{"code","path","message"}}` object on
  stderr. Covers every typed error: request validation, civil-time
  resolution, calendar conversion and computation errors.
- Exit 1: untyped internal failure (missing dependency, rule-table file
  that is not parseable JSON, bug). Empty stdout. A missing or unreadable
  rule-table file is typed — the fs error carries a string `.code` (e.g.
  `ENOENT`) — so it exits 2, not 1. A rule-table file that parses but has
  invalid content is a typed `INVALID_RULE_TABLE` (exit 2), not exit 1.
- Unknown flags and unknown request fields are rejected, never ignored.
- Requires Node.js and the pinned dependencies in `scripts/package.json`
  (`astronomy-engine` 2.1.19, `korean-lunar-calendar` 0.4.0). `install.sh`
  installs them. Without dependencies the CLI fails with exit 1; it never
  falls back to a provider or to the LLM.

## Request shape

```json
{
  "schemaVersion": 1,
  "birth": {
    "calendar": "solar",
    "date": "1998-10-27",
    "time": "20:40:00",
    "timezone": "Asia/Seoul",
    "utcOffset": "+09:00",
    "gender": "male"
  },
  "queries": {
    "majorCycles": 10,
    "transits": ["2026-09-17T12:00:00+09:00"]
  }
}
```

Field rules (enforced by the validator, not conventions):

| field | rule |
|---|---|
| `schemaVersion` | required, must be `1` |
| `birth.calendar` | `solar` or `korean_lunar` |
| `birth.date` | `YYYY-MM-DD`. Solar range: 1900-01-01..2100-12-31. Lunar: day <= 30, and the converted solar date must land in the solar range |
| `birth.leapMonth` | required boolean for `korean_lunar`, forbidden for `solar` |
| `birth.time` | `HH:mm:ss` or `null`. `null` means unknown time; never invent one |
| `birth.timezone` | required IANA name, validated by `Intl` (e.g. `Asia/Seoul`) |
| `birth.utcOffset` | optional `±HH:mm[:ss]`; only needed to disambiguate a repeated (DST fold) local time, and must match the zone |
| `birth.gender` | optional `male`/`female`; used only for traditional major-cycle direction, never defaulted |
| `queries.majorCycles` | integer 0..12, default 0 |
| `queries.transits` | array of <=366 RFC3339 instants with explicit offset; order and duplicates are retained |

No longitude field, no solar-time correction, no age input, no names. The
kernel uses civil time in the supplied zone with midnight day rollover.

## Result shape

Top-level keys in fixed order: `schemaVersion`, `rulesetId`, `provenance`,
`input`, `calendar`, `natal`, `majorCycles`, `transits`, `limitations`.
Identical input plus identical provenance gives byte-identical output.

- `provenance`: exact declared+resolved package versions, SHA256 of the
  canonical rule tables, `process.versions` node/icu/tz, converter and
  ephemeris IDs. Cite it when the user asks how a value was produced.
- `input`: the validated request echoed back with original text fields.
- `calendar.supplied`: the user's original calendar/date/time/zone, preserved
  verbatim. `calendar.solarDate`: the solar date actually used.
  `calendar.lunar`: Korean lunar metadata or `null`.
  `calendar.resolvedInstant`: the resolved UTC instant or `null`.
  `calendar.jieEvents[]`: surrounding solar-term events with UTC instants.
- `natal.dayMaster`: day stem with `dayCycleIndex` and the 甲子 anchor.
- `natal.candidates[]`: one entry per possible chart. Known time normally
  yields one; unknown time or a birth inside a solar-term uncertainty band
  yields more. Each candidate has `interval`, `side`, `boundary`,
  `uncertain`, `pillarIds`, `pillars`, `counts`, `relations`,
  `specialRules`.
- `natal.candidates[].pillars`: `year`, `month`, `day`, `hour`. `hour` is
  `null` when the birth time is unknown; it is never filled with noon or a
  guess. Each pillar carries `stem`, `branch`, `ganZhi`, `korean`,
  `stemTenGod`, `hiddenStems[]` (rank, `weightTenths`, per-stem `tenGod` and
  `stage`), `branchTenGod`, `dayStemStage`, `stemStage`.
- `natal.candidates[].counts`: `visibleStems`, `visibleBranches`,
  `combinedSurface` (each `units` + `totalUnits`) and
  `stemsPlusWeightedHidden` (`tenths`, `units`, `totalTenths`, `totalUnits`,
  `weightsId`). Totals are 8 units with hour, 6 without. These are measured
  counts, not strength verdicts.
- `natal.candidates[].relations[]`: every detected 합충형파해 record with
  `ruleId`, `occurrenceIds`, `completion` (`complete`|`partial`), `element`
  when applicable, `subtype` (`arched_triad` for a partial 三合 without the
  cardinal branch) and `transformationStatus`, which is always
  `not_evaluated`. `specialRules[]` holds the named rules `gongmang`,
  `wonjin`, `gwimun` with the same record shape plus `voidBranches` /
  `referenceOccurrenceId` for gongmang.
- `natal.coverageComplete`: false when the hour pillar is missing.
- `majorCycles`: `available`, `convention` (`three-days-calendar-v1`),
  `secondsPerNominalYear` (259200), `cycleYears` (10), `count`,
  `candidates[]`. Each candidate carries `direction`, `directionBasis`
  (year stem, polarity, gender, rule id) and `ranges[]`. Each range has
  `birthInstants`, `adjacentJie`, `distance` (raw ms/seconds), `start`
  (`earliest`/`latest` instants with wall time and `age`
  {years,months,days,seconds}) and `cycles[]` with `id` (`major.N`),
  `pillar` and `interval` (`start`/`end` bounds, `endExclusive`). Unknown
  birth time produces start ranges, never a midpoint.
- `transits[]`: one entry per requested instant: `input`, `iso`, `local`
  wall fields in the birth zone, `age`, `pillarCandidates[]` (annual,
  monthly, daily pillars; two sets inside a term-uncertainty band) and
  `contexts[]` per natal candidate with day-master-relative ten gods and
  stages, `activeMajorCycle` (`status`: `determinate`|`ambiguous`|`none`|
  `not_requested`|`unavailable`) and, inside each context, `relations[]`
  tagged with `sources` (`natal`|`major`|`transit`).
- `transits[].age`: `{system:"completed-solar-years", years, asOfDate,
  timezone, anniversaryPolicy:"month-day-march1-for-feb29", reason}`.
  `years` is `null` with `reason:"BEFORE_BIRTH_DATE"` before the birth date.
- `limitations[]`: stable `{code,path,details}` records sorted by code then
  path: `UNKNOWN_BIRTH_TIME`, `MISSING_MAJOR_DIRECTION`,
  `AMBIGUOUS_NATAL_BOUNDARY`, `SOLAR_TERM_UNCERTAINTY`,
  `LUNAR_METADATA_OUT_OF_RANGE`.

## Error codes (exit 2)

Request/validation: `INVALID_REQUEST`, `MISSING_FIELD`, `UNKNOWN_FIELD`,
`SCHEMA_VERSION_UNSUPPORTED`, `INVALID_FIELD`, `INVALID_VALUE`,
`INVALID_DATE`, `DATE_OUT_OF_RANGE`, `INVALID_TIME`, `INVALID_TIMEZONE`,
`INVALID_UTC_OFFSET`, `OFFSET_MISMATCH`, `NONEXISTENT_LOCAL_TIME`,
`AMBIGUOUS_LOCAL_TIME`, `LEAP_MONTH_REQUIRED`, `LEAP_MONTH_FORBIDDEN`,
`INVALID_TRANSIT`, `TRANSIT_OUT_OF_RANGE`, `TOO_MANY_TRANSITS`.

Computation: `INVALID_LUNAR_DATE`, `INVALID_SOLAR_DATE`,
`INVALID_SOLAR_TERM`, `LUNAR_CONVERSION_FAILED`, `SOLAR_TERM_SEARCH_FAILED`,
`NEGATIVE_JIE_DISTANCE`, `START_WALL_UNRESOLVABLE`, `INVALID_INPUT`,
`NONEXISTENT_LOCAL_DATE`, `LOCAL_DATE_UNRESOLVABLE`.

CLI: `UNKNOWN_ARGUMENT`, `MISSING_ARGUMENT`, `INPUT_FILE_UNREADABLE`,
`INVALID_JSON`.

Internal/contract guards (typed, exit 2; indicate a kernel or rule-table
bug rather than user input): `INVALID_OCCURRENCES`, `INVALID_OCCURRENCE`,
`DUPLICATE_OCCURRENCE_ID`, `INVALID_RULE_TABLE`,
`RESULT_CONTRACT_VIOLATION`, `UNSERIALIZABLE_VALUE`.

Untyped failures: `INTERNAL_ERROR` (exit 1).

## Interpretation rules (binding)

1. Use computed fields or omit. Every 사주 fact in the answer must come from
   the result JSON. Never recalculate stems, branches, ten gods, element
   counts, relations, cycle dates or ages from the birth data.
2. Cite evidence per major claim with the JSON path, e.g.
   `natal.candidates[0].pillars.day.ganZhi`, `majorCycles.candidates[0].ranges[0].cycles`,
   `transits[0].age.years`.
3. Age: copy `transits[].age.years` and label it 만나이 with the matching
   `asOfDate`. Never compute an age in prose.
4. Multiple candidates: present each candidate separately. Never merge or
   average them.
5. `limitations[]` entries are part of the answer. Relay them honestly
   instead of covering gaps with guesses.
6. `transformationStatus` is always `not_evaluated`: a 합 is a detected
   relation, not a completed transformation, a benefit or a harm verdict.
7. Counts are measured distributions. Do not derive 용신, 신강/신약 scores
   or any new numeric rubric from them.
8. No cross-person computation exists. This CLI has no two-person endpoint;
   never derive 합충형파해 between two charts. Mark that field uncomputed.
9. Preserve user-supplied charts verbatim. If a user's existing chart or
   profile disagrees with the computed result, show both; do not silently
   correct either.
10. Provider output (A027/B017) and astrology output (natal.mjs) are
    separate sources. Label them; never present their numbers as kernel
    output or vice versa.
