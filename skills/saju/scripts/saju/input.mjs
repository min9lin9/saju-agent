// input.mjs — versioned request validation for the deterministic saju kernel.
//
// validateRequest(raw) enforces the exact request contract:
//   {schemaVersion:1, birth:{calendar,date,time,timezone,utcOffset?,gender?},
//    queries?{majorCycles?,transits?}}
// Pure function: no profile reads, no network, no ambient clock, no host-TZ
// dependence. Unknown fields reject; optional fields are never defaulted
// beyond the declared queries defaults {majorCycles:0, transits:[]}.
//
// Scope boundary: this module validates shape, ranges and instant syntax.
// Civil-time existence/ambiguity (DST gaps/folds) is resolved by time.mjs
// resolveCivilTime; Korean-lunar conversion is calendar.mjs scope. A lunar
// date is checked for strict YYYY-MM-DD shape and day<=30 only; month-length
// and conversion success belong to the converter.
//
// Error contract: every rejection is an InputError carrying stable
// machine-consumed {code, path} fields; messages are for humans only.

import {
  parseDateFields,
  parseTimeFields,
  parseUtcOffset,
  parseRfc3339Instant,
  isValidTimezone,
  wallFieldsAt,
} from './time.mjs';

export class InputError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'InputError';
    this.code = code;
    this.path = path;
  }
}

const SUPPORTED_SCHEMA_VERSION = 1;
const SOLAR_RANGE = { min: '1900-01-01', max: '2100-12-31' };
const MAX_MAJOR_CYCLES = 12;
const MAX_TRANSITS = 366;
const LUNAR_MAX_DAY = 30; // Korean lunar months never exceed 30 days.

const pad2 = (n) => String(n).padStart(2, '0');
const dateText = (d) => `${String(d.year).padStart(4, '0')}-${pad2(d.month)}-${pad2(d.day)}`;

const fail = (code, path, message) => {
  throw new InputError(code, path, message);
};

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// Rejects keys outside the allowed set; returns the object's own keys.
const checkFields = (obj, allowed, basePath) => {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      fail('UNKNOWN_FIELD', basePath ? `${basePath}.${key}` : key, `unknown field: ${key}`);
    }
  }
};

const requireField = (obj, key, basePath) => {
  if (!(key in obj)) fail('MISSING_FIELD', `${basePath}.${key}`, `missing required field: ${key}`);
  return obj[key];
};

const validateSolarDate = (value, path) => {
  if (typeof value !== 'string') {
    fail('INVALID_VALUE', path, `date must be a YYYY-MM-DD string, got ${JSON.stringify(value)}`);
  }
  const d = parseDateFields(value);
  if (!d) fail('INVALID_DATE', path, `not a Gregorian date: ${value}`);
  const text = dateText(d);
  if (text < SOLAR_RANGE.min || text > SOLAR_RANGE.max) {
    fail(
      'DATE_OUT_OF_RANGE', path,
      `${text} is outside the declared solar support range ${SOLAR_RANGE.min}..${SOLAR_RANGE.max}`,
    );
  }
  return { ...d, text };
};

const validateLunarDate = (value, path) => {
  if (typeof value !== 'string') {
    fail('INVALID_VALUE', path, `date must be a YYYY-MM-DD string, got ${JSON.stringify(value)}`);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) fail('INVALID_DATE', path, `not a YYYY-MM-DD date: ${value}`);
  const d = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  if (d.month < 1 || d.month > 12 || d.day < 1 || d.day > LUNAR_MAX_DAY) {
    fail('INVALID_DATE', path, `not a possible Korean lunar date: ${value}`);
  }
  return { ...d, text: dateText(d) };
};

const validateBirth = (raw) => {
  if (!isPlainObject(raw)) fail('INVALID_FIELD', 'birth', 'birth must be an object');
  checkFields(raw, new Set(['calendar', 'date', 'leapMonth', 'time', 'timezone', 'utcOffset', 'gender']), 'birth');

  const calendar = requireField(raw, 'calendar', 'birth');
  if (calendar !== 'solar' && calendar !== 'korean_lunar') {
    fail('INVALID_VALUE', 'birth.calendar', `calendar must be solar|korean_lunar, got ${JSON.stringify(calendar)}`);
  }

  if (calendar === 'solar') {
    if ('leapMonth' in raw) {
      fail('LEAP_MONTH_FORBIDDEN', 'birth.leapMonth', 'leapMonth is only valid for korean_lunar');
    }
  } else {
    if (!('leapMonth' in raw)) {
      fail('LEAP_MONTH_REQUIRED', 'birth.leapMonth', 'korean_lunar requires an explicit leapMonth boolean');
    }
    if (typeof raw.leapMonth !== 'boolean') {
      fail('INVALID_VALUE', 'birth.leapMonth', `leapMonth must be a boolean, got ${JSON.stringify(raw.leapMonth)}`);
    }
  }

  const dateValue = requireField(raw, 'date', 'birth');
  const date = calendar === 'solar'
    ? validateSolarDate(dateValue, 'birth.date')
    : validateLunarDate(dateValue, 'birth.date');

  const timeValue = requireField(raw, 'time', 'birth');
  let time = null;
  if (timeValue !== null) {
    if (typeof timeValue !== 'string') {
      fail('INVALID_VALUE', 'birth.time', `time must be HH:mm:ss or null, got ${JSON.stringify(timeValue)}`);
    }
    const t = parseTimeFields(timeValue);
    if (!t) fail('INVALID_TIME', 'birth.time', `not an HH:mm:ss civil time: ${timeValue}`);
    time = { ...t, text: timeValue };
  }

  const timezone = requireField(raw, 'timezone', 'birth');
  if (!isValidTimezone(timezone)) {
    fail('INVALID_TIMEZONE', 'birth.timezone', `unknown IANA timezone: ${JSON.stringify(timezone)}`);
  }

  let utcOffset = null;
  if ('utcOffset' in raw && raw.utcOffset !== undefined) {
    const seconds = parseUtcOffset(raw.utcOffset);
    if (seconds === null) {
      fail('INVALID_UTC_OFFSET', 'birth.utcOffset', `not a ±HH:mm[:ss] offset: ${JSON.stringify(raw.utcOffset)}`);
    }
    utcOffset = { text: raw.utcOffset, seconds };
  }

  let gender = null;
  if ('gender' in raw && raw.gender !== undefined) {
    if (raw.gender !== 'male' && raw.gender !== 'female') {
      fail('INVALID_VALUE', 'birth.gender', `gender must be male|female, got ${JSON.stringify(raw.gender)}`);
    }
    gender = raw.gender;
  }

  return {
    calendar,
    date,
    leapMonth: calendar === 'korean_lunar' ? raw.leapMonth : null,
    time,
    timezone,
    utcOffset,
    gender,
  };
};

const validateTransit = (value, index, timezone) => {
  const path = `queries.transits[${index}]`;
  const parsed = parseRfc3339Instant(value);
  if (!parsed) {
    fail('INVALID_TRANSIT', path, `not an RFC3339 instant with explicit offset: ${JSON.stringify(value)}`);
  }
  const w = wallFieldsAt(timezone, parsed.instantMs);
  const localDate = dateText(w);
  if (localDate < SOLAR_RANGE.min || localDate > SOLAR_RANGE.max) {
    fail(
      'TRANSIT_OUT_OF_RANGE', path,
      `instant ${value} falls on ${localDate} in ${timezone}, outside ${SOLAR_RANGE.min}..${SOLAR_RANGE.max}`,
    );
  }
  return { ...parsed, localDate };
};

const validateQueries = (raw, timezone) => {
  if (raw === undefined) return { majorCycles: 0, transits: [] };
  if (!isPlainObject(raw)) fail('INVALID_FIELD', 'queries', 'queries must be an object');
  checkFields(raw, new Set(['majorCycles', 'transits']), 'queries');

  let majorCycles = 0;
  if ('majorCycles' in raw && raw.majorCycles !== undefined) {
    if (!Number.isInteger(raw.majorCycles) || raw.majorCycles < 0 || raw.majorCycles > MAX_MAJOR_CYCLES) {
      fail(
        'INVALID_VALUE', 'queries.majorCycles',
        `majorCycles must be an integer 0..${MAX_MAJOR_CYCLES}, got ${JSON.stringify(raw.majorCycles)}`,
      );
    }
    majorCycles = raw.majorCycles;
  }

  let transits = [];
  if ('transits' in raw && raw.transits !== undefined) {
    if (!Array.isArray(raw.transits)) {
      fail('INVALID_FIELD', 'queries.transits', 'transits must be an array of RFC3339 instants');
    }
    if (raw.transits.length > MAX_TRANSITS) {
      fail('TOO_MANY_TRANSITS', 'queries.transits', `transits allows at most ${MAX_TRANSITS} entries`);
    }
    transits = raw.transits.map((v, i) => validateTransit(v, i, timezone));
  }

  return { majorCycles, transits };
};

// Validates one request object. Returns a normalized copy:
//   {schemaVersion:1, birth:{calendar,date:{year,month,day,text},leapMonth,
//    time:{hour,minute,second,text}|null,timezone,utcOffset:{text,seconds}|null,
//    gender}, queries:{majorCycles,transits:[{text,instantMs,offsetSeconds,localDate}]}}
// Throws InputError with stable {code,path} on any contract violation.
export const validateRequest = (raw) => {
  if (!isPlainObject(raw)) {
    fail('INVALID_REQUEST', '$', 'request must be a single JSON object');
  }
  checkFields(raw, new Set(['schemaVersion', 'birth', 'queries']), '');

  if (!('schemaVersion' in raw)) {
    fail('MISSING_FIELD', 'schemaVersion', 'missing required field: schemaVersion');
  }
  if (raw.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    fail(
      'SCHEMA_VERSION_UNSUPPORTED', 'schemaVersion',
      `schemaVersion must be ${SUPPORTED_SCHEMA_VERSION}, got ${JSON.stringify(raw.schemaVersion)}`,
    );
  }

  if (!('birth' in raw)) {
    fail('MISSING_FIELD', 'birth', 'missing required field: birth');
  }
  const birth = validateBirth(raw.birth);
  const queries = validateQueries(raw.queries, birth.timezone);
  return { schemaVersion: SUPPORTED_SCHEMA_VERSION, birth, queries };
};
