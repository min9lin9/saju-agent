// calendar.mjs — Korean lunar conversion and astronomical solar-term adapters.
//
// Two upstream contracts are adapted here, nothing more:
//   korean-lunar-calendar 0.4.0 (MIT): Korean lunisolar <-> Gregorian table
//     conversion. A NEW converter object is created per call: the upstream
//     constructor seeds "today" from the ambient clock and a failed setter
//     leaves that stale state readable, so reusing an instance would leak
//     nondeterminism into results. Setter booleans are always checked; a
//     false return is an explicit lookup failure, never a silent fallback.
//     The converter's gapja output is NOT used: saju year/month pillars come
//     from Ipchun/jie boundaries and the JDN day cycle, never from lunar
//     calendar labels.
//   astronomy-engine 2.1.19 (MIT): SearchSunLongitude inside a bounded
//     ten-day UTC window (month day 1 00:00Z through day 11 00:00Z, matching
//     the independent Horizons fixture recipe). The returned instant is
//     verified against the window and an angular residual check; a null or
//     wrong result is a calculation error (SOLAR_TERM_SEARCH_FAILED), never
//     a fixed-date fallback. Both ut and tt day values are exposed so
//     ephemeris tests can compare TT against TT references; the engine's
//     Delta-T model is Espenak/Meeus piecewise polynomials.
//
// Epistemic boundary tolerance is +/-120 s (SOLAR_TERM_UNCERTAINTY_SECONDS):
// instants inside that band around a term are uncertain by declaration, not
// by claimed second-level astronomical truth.
//
// Error contract: every rejection is a CalendarError carrying stable
// machine-consumed {code, path} fields; messages are for humans only.

import * as Astronomy from 'astronomy-engine';
import KoreanLunarCalendar from 'korean-lunar-calendar';

export class CalendarError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'CalendarError';
    this.code = code;
    this.path = path;
  }
}

// Declared epistemic tolerance around each computed solar term, in seconds.
export const SOLAR_TERM_UNCERTAINTY_SECONDS = 120;

// Limitation code the caller attaches when solarToLunar returns null.
export const LUNAR_METADATA_LIMITATION = 'LUNAR_METADATA_OUT_OF_RANGE';

// Solar dates beyond this day have no Korean lunar metadata (converter data
// ends at solar 2050-12-31); solarToLunar returns null there.
export const LUNAR_METADATA_MAX_SOLAR = '2050-12-31';

// The twelve month-boundary jie longitudes by Gregorian month, per the plan's
// period-boundary table: month m's jie is the Sun reaching angleDeg.
export const JIE_BY_MONTH = [
  { id: 'sohan', angleDeg: 285 },
  { id: 'ipchun', angleDeg: 315 },
  { id: 'gyeongchip', angleDeg: 345 },
  { id: 'cheongmyeong', angleDeg: 15 },
  { id: 'ipha', angleDeg: 45 },
  { id: 'mangjong', angleDeg: 75 },
  { id: 'haji', angleDeg: 105 },
  { id: 'ipchu', angleDeg: 135 },
  { id: 'baengno', angleDeg: 165 },
  { id: 'hallo', angleDeg: 195 },
  { id: 'ipdong', angleDeg: 225 },
  { id: 'daeseol', angleDeg: 255 },
];

// Solar-term search is supported for the declared solar range plus the
// adjacent terms needed to bracket its edges: 1899-12 Daeseol through
// 2101-01 Sohan.
export const SOLAR_TERM_RANGE = { min: '1899-12', max: '2101-01' };

const SEARCH_WINDOW_DAYS = 10; // bounded window: day 1 00:00Z .. day 11 00:00Z
const RESIDUAL_TOLERANCE_DEG = 0.001; // ~3.6 arcsec sanity bound on the root
const J2000_JD = 2451545.0;
const MS_PER_DAY = 86400 * 1000;

const pad2 = (n) => String(n).padStart(2, '0');

const isInt = (v) => Number.isInteger(v);

// Signed degrees from `lon` to `target`, in (-180, 180].
const longitudeOffset = (lon, target) => ((((lon - target) % 360) + 540) % 360) - 180;

// --- solar terms --------------------------------------------------------------

// Finds the UTC instant the Sun reaches the month-boundary jie longitude for
// the given Gregorian {year, month}.
//
//   findSolarTerm({year, month, search?})
//     search: injectable SearchSunLongitude-compatible function for tests;
//             defaults to Astronomy.SearchSunLongitude.
//
// Returns:
//   {eventId, termId, angleDeg, year, month,
//    instantMs, iso,                 UTC instant, millisecond precision
//    utDays, ttDays,                 engine J2000 day values (tt for TT tests)
//    julianDayUT, julianDayTT,       Julian days in each scale
//    uncertaintySeconds,             declared +/-120 s epistemic band
//    windowStartIso, windowDays}     the bounded search window used
//
// Throws CalendarError SOLAR_TERM_SEARCH_FAILED on any lookup failure —
// null result, thrown engine error, instant outside the window, or angular
// residual above tolerance. There is no fixed-date or China-time fallback.
export const findSolarTerm = ({ year, month, search = Astronomy.SearchSunLongitude }) => {
  const path = 'birth.date';
  if (!isInt(year) || !isInt(month) || month < 1 || month > 12) {
    throw new CalendarError(
      'INVALID_SOLAR_TERM', path,
      `solar-term lookup needs integer year/month, got ${JSON.stringify({ year, month })}`,
    );
  }
  const ym = `${String(year).padStart(4, '0')}-${pad2(month)}`;
  if (ym < SOLAR_TERM_RANGE.min || ym > SOLAR_TERM_RANGE.max) {
    throw new CalendarError(
      'INVALID_SOLAR_TERM', path,
      `solar-term month ${ym} outside supported range ${SOLAR_TERM_RANGE.min}..${SOLAR_TERM_RANGE.max}`,
    );
  }
  const { id: termId, angleDeg } = JIE_BY_MONTH[month - 1];

  const windowStart = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const windowEndMs = windowStart.getTime() + SEARCH_WINDOW_DAYS * MS_PER_DAY;

  let result;
  try {
    result = search(angleDeg, windowStart, SEARCH_WINDOW_DAYS);
  } catch (err) {
    throw new CalendarError(
      'SOLAR_TERM_SEARCH_FAILED', path,
      `sun-longitude search for ${angleDeg} deg in ${ym} threw: ${err?.message ?? err}`,
    );
  }
  if (result === null || result === undefined) {
    throw new CalendarError(
      'SOLAR_TERM_SEARCH_FAILED', path,
      `sun-longitude search for ${angleDeg} deg in ${ym} returned no instant`,
    );
  }

  const time = Astronomy.MakeTime(result);
  const instantMs = time.date.getTime();
  if (!Number.isFinite(instantMs) || instantMs < windowStart.getTime() || instantMs > windowEndMs) {
    throw new CalendarError(
      'SOLAR_TERM_SEARCH_FAILED', path,
      `search returned ${time.date.toISOString()} outside the bounded window`
        + ` ${windowStart.toISOString()}..${new Date(windowEndMs).toISOString()}`,
    );
  }

  let residualDeg;
  try {
    residualDeg = Math.abs(longitudeOffset(Astronomy.SunPosition(time).elon, angleDeg));
  } catch (err) {
    throw new CalendarError(
      'SOLAR_TERM_SEARCH_FAILED', path,
      `residual check for ${angleDeg} deg in ${ym} threw: ${err?.message ?? err}`,
    );
  }
  if (!(residualDeg <= RESIDUAL_TOLERANCE_DEG)) {
    throw new CalendarError(
      'SOLAR_TERM_SEARCH_FAILED', path,
      `search returned ${time.date.toISOString()} with angular residual`
        + ` ${residualDeg} deg > ${RESIDUAL_TOLERANCE_DEG} deg from ${angleDeg}`,
    );
  }

  return {
    eventId: `${year}-${termId}`,
    termId,
    angleDeg,
    year,
    month,
    instantMs,
    iso: time.date.toISOString(),
    utDays: time.ut,
    ttDays: time.tt,
    julianDayUT: time.ut + J2000_JD,
    julianDayTT: time.tt + J2000_JD,
    uncertaintySeconds: SOLAR_TERM_UNCERTAINTY_SECONDS,
    windowStartIso: windowStart.toISOString(),
    windowDays: SEARCH_WINDOW_DAYS,
  };
};

// --- Korean lunar conversion ----------------------------------------------------

const checkDateArgs = (d, path, kind) => {
  if (d === null || typeof d !== 'object'
      || !isInt(d.year) || !isInt(d.month) || !isInt(d.day)) {
    throw new CalendarError(
      kind, path,
      `expected {year,month,day} integers, got ${JSON.stringify(d)}`,
    );
  }
};

// Converts a Korean lunar date to its Gregorian solar date.
//
//   lunarToSolar({year, month, day, leapMonth}) -> {year, month, day}
//
// leapMonth must be a boolean. An impossible lunar date (nonexistent leap
// month, day beyond the month, outside the converter's 1000-01-01..2050-11-18
// lunar coverage) throws INVALID_LUNAR_DATE; a converter state that fails to
// echo the request throws LUNAR_CONVERSION_FAILED. No China-calendar
// substitution and no approximate fallback exists.
export const lunarToSolar = ({ year, month, day, leapMonth }) => {
  const path = 'birth.date';
  if (typeof leapMonth !== 'boolean') {
    throw new CalendarError(
      'INVALID_LUNAR_DATE', 'birth.leapMonth',
      `leapMonth must be a boolean, got ${JSON.stringify(leapMonth)}`,
    );
  }
  checkDateArgs({ year, month, day }, path, 'INVALID_LUNAR_DATE');

  const converter = new KoreanLunarCalendar(); // fresh per call: stale-state hazard
  if (converter.setLunarDate(year, month, day, leapMonth) !== true) {
    throw new CalendarError(
      'INVALID_LUNAR_DATE', path,
      `Korean lunar date ${year}-${pad2(month)}-${pad2(day)}`
        + ` (leapMonth=${leapMonth}) does not exist`,
    );
  }
  const solar = converter.getSolarCalendar();
  const echo = converter.getLunarCalendar();
  if (!solar || !isInt(solar.year) || !isInt(solar.month) || !isInt(solar.day)
      || !echo || echo.year !== year || echo.month !== month || echo.day !== day
      || Boolean(echo.intercalation) !== leapMonth) {
    throw new CalendarError(
      'LUNAR_CONVERSION_FAILED', path,
      `converter state does not echo lunar ${year}-${pad2(month)}-${pad2(day)} leap=${leapMonth}`,
    );
  }
  return { year: solar.year, month: solar.month, day: solar.day };
};

// Converts a Gregorian solar date to Korean lunar metadata.
//
//   solarToLunar({year, month, day}) -> {year, month, day, leapMonth} | null
//
// Returns null when the solar date is beyond the converter's coverage (after
// LUNAR_METADATA_MAX_SOLAR): the caller reports LUNAR_METADATA_LIMITATION
// rather than failing the solar calculation. A date inside coverage whose
// conversion state fails to echo throws LUNAR_CONVERSION_FAILED.
export const solarToLunar = ({ year, month, day }) => {
  const path = 'birth.date';
  checkDateArgs({ year, month, day }, path, 'INVALID_SOLAR_DATE');

  const converter = new KoreanLunarCalendar(); // fresh per call: stale-state hazard
  if (converter.setSolarDate(year, month, day) !== true) {
    // checkValidDate rejects both malformed dates and dates outside coverage;
    // malformed shapes were rejected above, so a false here is the declared
    // metadata boundary, reported as null + LUNAR_METADATA_OUT_OF_RANGE.
    return null;
  }
  const lunar = converter.getLunarCalendar();
  const echo = converter.getSolarCalendar();
  if (!lunar || !isInt(lunar.year) || !isInt(lunar.month) || !isInt(lunar.day)
      || !echo || echo.year !== year || echo.month !== month || echo.day !== day) {
    throw new CalendarError(
      'LUNAR_CONVERSION_FAILED', path,
      `converter state does not echo solar ${year}-${pad2(month)}-${pad2(day)}`,
    );
  }
  return { year: lunar.year, month: lunar.month, day: lunar.day, leapMonth: Boolean(lunar.intercalation) };
};

// --- per-request calendar -------------------------------------------------------

// Creates a calendar facade for ONE calculation request. Solar-term results
// are memoized within the instance (a request asks for the same terms many
// times); nothing is shared across instances, so no state survives a request.
export const createCalendar = () => {
  const termCache = new Map();
  return {
    findSolarTerm({ year, month, search }) {
      const key = `${year}-${pad2(month)}`;
      if (!termCache.has(key)) {
        termCache.set(key, findSolarTerm({ year, month, search }));
      }
      return termCache.get(key);
    },
    lunarToSolar,
    solarToLunar,
  };
};
