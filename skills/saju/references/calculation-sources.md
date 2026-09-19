# Calculation sources and attribution

Every number the deterministic saju kernel emits comes from the pinned runtime
dependencies below or from the declared rule tables — never from an LLM, a
network call, or a fixed-date shortcut. Versions are exact pins in
`skills/saju/scripts/package.json` + `package-lock.json`.

## Runtime dependencies (pinned, MIT)

### astronomy-engine 2.1.19 — MIT

- Upstream: https://github.com/cosinekitty/astronomy (Don Cross,
  `cosinekitty@gmail.com`), npm `astronomy-engine@2.1.19`.
- License: MIT. Copyright (c) 2019-2023 Don Cross. License text ships in the
  package (`node_modules/astronomy-engine/`); the MIT grant covers use,
  copy, modify, merge, publish, distribute, sublicense, sell.
- Used for: `SearchSunLongitude` root-finding of the twelve month-boundary
  jie longitudes (285/315/345/15/45/75/105/135/165/195/225/255 degrees of
  apparent geocentric ecliptic longitude of date) inside bounded ten-day UTC
  windows, and `SunPosition` for the angular residual check on each returned
  instant. `AstroTime.tt` (Terrestrial Time, J2000 days) is exposed for
  ephemeris comparison; the engine's Delta-T model is the Espenak/Meeus
  piecewise-polynomial fit documented in the upstream README.
- Also used by the pre-existing tropical astrology CLI `scripts/natal.mjs`
  (unchanged behavior).

### korean-lunar-calendar 0.4.0 — MIT

- Upstream: https://github.com/usingsky/korean_lunar_calendar_js (Jinil Lee,
  `usingsky@gmail.com`), npm `korean-lunar-calendar@0.4.0`.
- License: MIT. Copyright (c) 2022 Jinil Lee. License text ships in the
  package (`node_modules/korean-lunar-calendar/LICENSE`).
- Used for: Korean lunisolar <-> Gregorian date conversion only
  (`setLunarDate`/`setSolarDate` + `getLunarCalendar`/`getSolarCalendar`).
  A fresh converter object is created per call because the upstream
  constructor seeds "today" from the ambient clock and failed setters leave
  that state readable. Setter return booleans are always checked.
- Coverage: lunar 1000-01-01 .. 2050-11-18, solar 1000-02-13 .. 2050-12-31.
  Solar dates after 2050-12-31 yield `null` + `LUNAR_METADATA_OUT_OF_RANGE`.
- Explicitly NOT used: the converter's `getKoreanGapja`/`getChineseGapja`
  output. Saju year/month pillars derive from astronomical Ipchun/jie
  boundaries and the JDN day cycle, never from lunar-calendar labels; the
  Chinese ganji variant is never consulted (no China-time/China-calendar
  substitution anywhere in the kernel).

## Independent verification sources (test fixtures only, not runtime deps)

- KASI solc API (`https://astro.kasi.re.kr/life/solc?yyyy=..&mm=..&dd=..`):
  archived JSON responses anchor solar<->lunar conversion and the day-pillar
  (`LUNC_ILJIN`) fixtures in `tests/fixtures/saju/calendar.json`.
- JPL Horizons API (`https://ssd.jpl.nasa.gov/api/horizons.api`, OBSERVER
  quantity 31 `ObsEcLon`, geocentric apparent ecliptic-of-date, DE441):
  archived hourly+minute responses anchor the 26 solar-term cases in
  `tests/fixtures/saju/solar-terms.json`. 2024 cases are compared in UT;
  1899..2101 cases are compared in TT against `AstroTime.tt` because Horizons
  freezes known leap seconds while the engine models Delta-T.
- Declared tolerance: +/-120 s epistemic boundary band
  (`SOLAR_TERM_UNCERTAINTY_SECONDS`), not a claim of second-level truth.
