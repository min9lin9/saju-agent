// time.mjs — deterministic civil-time resolution for the saju kernel.
//
// Pure functions only: no process timezone, no implicit Date parsing, no
// ambient clock. Civil time is resolved exclusively through Intl: distinct
// UTC offsets found in a +/-48-hour window around the wall-time-as-UTC guess
// are enumerated, each offset yields a candidate instant, and every candidate
// is round-tripped back to the exact input wall fields. Zero matches is
// NONEXISTENT_LOCAL_TIME; multiple matches require a matching utcOffset or
// AMBIGUOUS_LOCAL_TIME is thrown. A supplied utcOffset must describe the
// resolved instant or OFFSET_MISMATCH is thrown. Offsets retain seconds so
// historic LMT zones (e.g. Seoul +08:27:52) resolve exactly.
//
// Error contract: every rejection is a TimeError carrying stable
// machine-consumed {code, path} fields; messages are for humans only.

export class TimeError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'TimeError';
    this.code = code;
    this.path = path;
  }
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2}):(\d{2})$/;
const OFFSET_RE = /^([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/;
const RFC3339_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/;

// Enumeration window: +/-48h around the wall-time-as-UTC guess covers every
// real zone offset (max |offset| is far below 24h) plus margin for historic
// LMT. The plan calls for hourly sampling; 15-minute sampling is strictly
// finer. An offset island shorter than the sample step could in principle be
// missed, but no real IANA zone has sub-15-minute transitions.
const WINDOW_MS = 48 * 3600 * 1000;
const SAMPLE_MS = 15 * 60 * 1000;

const pad2 = (n) => String(n).padStart(2, '0');

// Date.UTC treats years 0-99 as 1900+year; setUTCFullYear avoids the trap.
// The base year must be a leap year: building on 1900 rolls Feb 29 to Mar 1
// before setUTCFullYear can correct it, so every Feb-29 instant shifts +1 day.
const utcMs = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => {
  const dt = new Date(Date.UTC(2000, mo - 1, d, h, mi, s, ms));
  dt.setUTCFullYear(y);
  return dt.getTime();
};

export const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

export const daysInMonth = (y, mo) =>
  [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];

// Parses strict YYYY-MM-DD into integer fields; null when the shape is wrong
// or the date is not a real proleptic-Gregorian calendar date.
export const parseDateFields = (text) => {
  if (typeof text !== 'string') return null;
  const m = DATE_RE.exec(text);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
};

// Parses strict HH:mm:ss into integer fields; null when out of range.
// 24:00:00 and leap-second 60 are not civil times in this contract.
export const parseTimeFields = (text) => {
  if (typeof text !== 'string') return null;
  const m = TIME_RE.exec(text);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const second = Number(m[3]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second };
};

// Parses ±HH:mm[:ss] into signed seconds; null when malformed or out of
// range. Seconds are retained for historic zone offsets.
export const parseUtcOffset = (text) => {
  if (typeof text !== 'string') return null;
  const m = OFFSET_RE.exec(text);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const hh = Number(m[2]);
  const mm = Number(m[3]);
  const ss = m[4] === undefined ? 0 : Number(m[4]);
  if (hh > 23 || mm > 59 || ss > 59) return null;
  return sign * (hh * 3600 + mm * 60 + ss);
};

// Formats signed offset seconds as +HH:mm, appending :ss when nonzero.
export const formatUtcOffset = (seconds) => {
  const sign = seconds < 0 ? '-' : '+';
  const abs = Math.abs(seconds);
  const hh = Math.floor(abs / 3600);
  const mm = Math.floor((abs % 3600) / 60);
  const ss = abs % 60;
  const base = `${sign}${pad2(hh)}:${pad2(mm)}`;
  return ss === 0 ? base : `${base}:${pad2(ss)}`;
};

// Parses an RFC3339 timestamp that carries an explicit numeric offset (Z or
// ±HH:mm). Returns {text, instantMs, offsetSeconds} or null. Rejected:
// missing offset (a local date-time is not an instant), -00:00 (the RFC3339
// unknown-local-offset convention carries no usable offset), leap-second 60,
// unreal calendar dates. Fractional seconds are truncated to milliseconds.
export const parseRfc3339Instant = (text) => {
  if (typeof text !== 'string') return null;
  const m = RFC3339_RE.exec(text);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const frac = m[7];
  const zone = m[8];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offsetSeconds;
  if (zone === 'Z' || zone === 'z') {
    offsetSeconds = 0;
  } else {
    offsetSeconds = parseUtcOffset(zone);
    if (offsetSeconds === null) return null;
    if (zone[0] === '-' && offsetSeconds === 0) return null; // -00:00
  }
  const ms = frac === undefined ? 0 : Number((frac + '000').slice(0, 3));
  const instantMs = utcMs(year, month, day, hour, minute, second, ms) - offsetSeconds * 1000;
  return { text, instantMs, offsetSeconds };
};

export const isValidTimezone = (timezone) => {
  if (typeof timezone !== 'string' || timezone.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
};

// Intl formatters are pure and immutable; caching per zone is safe and keeps
// the 384-sample enumeration window cheap.
const formatterCache = new Map();
const formatterFor = (timezone, path) => {
  let fmt = formatterCache.get(timezone);
  if (fmt === undefined) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      throw new TimeError('INVALID_TIMEZONE', path, `unknown IANA timezone: ${timezone}`);
    }
    formatterCache.set(timezone, fmt);
  }
  return fmt;
};

// Exact civil fields of an instant in the zone. hourCycle h23 guarantees
// hour 0-23 (midnight is 00 of the new day, never 24).
export const wallFieldsAt = (timezone, instantMs, path = 'birth.timezone') => {
  const parts = formatterFor(timezone, path).formatToParts(new Date(instantMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
};

// Signed seconds the zone is ahead of UTC at the instant. The wall fields
// are second-truncated, so the instant's sub-second remainder is added back
// to keep real zone offsets (always whole seconds) exact for ms instants.
export const offsetSecondsAt = (timezone, instantMs, path = 'birth.timezone') => {
  const w = wallFieldsAt(timezone, instantMs, path);
  const wallMs = utcMs(w.year, w.month, w.day, w.hour, w.minute, w.second)
    + (((instantMs % 1000) + 1000) % 1000);
  return (wallMs - instantMs) / 1000;
};

// Enumerates the distinct zone offsets inside guess +/- WINDOW_MS.
const distinctOffsetsInWindow = (timezone, guessMs, path) => {
  const offsets = new Set();
  for (let t = guessMs - WINDOW_MS; t <= guessMs + WINDOW_MS; t += SAMPLE_MS) {
    offsets.add(offsetSecondsAt(timezone, t, path));
  }
  return offsets;
};

const sameWall = (w, d, t) =>
  w.year === d.year && w.month === d.month && w.day === d.day &&
  w.hour === t.hour && w.minute === t.minute && w.second === t.second;

// Resolves a civil wall time to its UTC instant.
//
//   resolveCivilTime({date, time, timezone, utcOffset?})
//     date/time: 'YYYY-MM-DD' / 'HH:mm:ss' strings or parsed field objects
//     timezone:  IANA name
//     utcOffset: '±HH:mm[:ss]' string or signed seconds, optional
//
// Returns {instantMs, iso, offsetSeconds, utcOffset, ambiguous,
//          candidateOffsets}. `ambiguous` reports that the wall time repeats
// in the zone (a supplied utcOffset selected one occurrence);
// `candidateOffsets` lists every offset under which the wall time occurs.
export const resolveCivilTime = ({ date, time, timezone, utcOffset, paths = {} }) => {
  const datePath = paths.date ?? 'birth.date';
  const timePath = paths.time ?? 'birth.time';
  const timezonePath = paths.timezone ?? 'birth.timezone';
  const offsetPath = paths.utcOffset ?? 'birth.utcOffset';

  const d = typeof date === 'string' ? parseDateFields(date) : date;
  if (!d || !Number.isInteger(d.year) || !Number.isInteger(d.month) || !Number.isInteger(d.day)
      || d.month < 1 || d.month > 12 || d.day < 1 || d.day > daysInMonth(d.year, d.month)) {
    throw new TimeError('INVALID_DATE', datePath, `not a Gregorian date: ${JSON.stringify(date)}`);
  }
  const t = typeof time === 'string' ? parseTimeFields(time) : time;
  if (!t || !Number.isInteger(t.hour) || !Number.isInteger(t.minute) || !Number.isInteger(t.second)
      || t.hour > 23 || t.minute > 59 || t.second > 59) {
    throw new TimeError('INVALID_TIME', timePath, `not an HH:mm:ss civil time: ${JSON.stringify(time)}`);
  }
  if (!isValidTimezone(timezone)) {
    throw new TimeError('INVALID_TIMEZONE', timezonePath, `unknown IANA timezone: ${timezone}`);
  }

  let suppliedOffset = null;
  if (utcOffset !== undefined && utcOffset !== null) {
    suppliedOffset = typeof utcOffset === 'number' ? utcOffset : parseUtcOffset(utcOffset);
    if (suppliedOffset === null || !Number.isInteger(suppliedOffset)) {
      throw new TimeError(
        'INVALID_UTC_OFFSET', offsetPath, `not a ±HH:mm[:ss] offset: ${JSON.stringify(utcOffset)}`,
      );
    }
  }

  const guessMs = utcMs(d.year, d.month, d.day, t.hour, t.minute, t.second);
  const candidates = [];
  for (const off of distinctOffsetsInWindow(timezone, guessMs, timezonePath)) {
    const instantMs = guessMs - off * 1000;
    if (sameWall(wallFieldsAt(timezone, instantMs, timezonePath), d, t)) {
      candidates.push({ instantMs, offsetSeconds: off });
    }
  }
  candidates.sort((a, b) => a.instantMs - b.instantMs);
  const candidateOffsets = candidates.map((c) => c.offsetSeconds);

  if (candidates.length === 0) {
    const hint = suppliedOffset === null
      ? ''
      : ` (supplied utcOffset ${formatUtcOffset(suppliedOffset)} cannot manufacture an instant inside a gap)`;
    throw new TimeError(
      'NONEXISTENT_LOCAL_TIME', timePath,
      `${d.year}-${pad2(d.month)}-${pad2(d.day)} ${pad2(t.hour)}:${pad2(t.minute)}:${pad2(t.second)}`
        + ` does not exist in ${timezone}${hint}`,
    );
  }

  let chosen;
  if (candidates.length === 1) {
    chosen = candidates[0];
    if (suppliedOffset !== null && suppliedOffset !== chosen.offsetSeconds) {
      throw new TimeError(
        'OFFSET_MISMATCH', offsetPath,
        `utcOffset ${formatUtcOffset(suppliedOffset)} does not match ${timezone} offset`
          + ` ${formatUtcOffset(chosen.offsetSeconds)} at this instant`,
      );
    }
  } else {
    if (suppliedOffset === null) {
      throw new TimeError(
        'AMBIGUOUS_LOCAL_TIME', timePath,
        `${d.year}-${pad2(d.month)}-${pad2(d.day)} ${pad2(t.hour)}:${pad2(t.minute)}:${pad2(t.second)}`
          + ` occurs ${candidates.length} times in ${timezone} (offsets`
          + ` ${candidateOffsets.map(formatUtcOffset).join(', ')}); supply utcOffset`,
      );
    }
    chosen = candidates.find((c) => c.offsetSeconds === suppliedOffset);
    if (!chosen) {
      throw new TimeError(
        'OFFSET_MISMATCH', offsetPath,
        `utcOffset ${formatUtcOffset(suppliedOffset)} matches none of the candidate offsets`
          + ` ${candidateOffsets.map(formatUtcOffset).join(', ')} for this wall time`,
      );
    }
  }

  return {
    instantMs: chosen.instantMs,
    iso: new Date(chosen.instantMs).toISOString(),
    offsetSeconds: chosen.offsetSeconds,
    utcOffset: formatUtcOffset(chosen.offsetSeconds),
    ambiguous: candidates.length > 1,
    candidateOffsets,
  };
};
