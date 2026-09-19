// Input contract validation for the deterministic saju kernel.
//
// Exercises validateRequest() from skills/saju/scripts/saju/input.mjs against
// the plan's exact request contract: versioned envelope, strict field
// cardinality, Gregorian solar dates in the declared 1900-2100 support range,
// the explicit Korean-lunar leap flag, RFC3339 transit instants with mandatory
// offsets, and cardinality limits. Error assertions pin machine-consumed
// {code, path} pairs, never prose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateRequest, InputError } from '../../skills/saju/scripts/saju/input.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const requestFixture = (name) =>
  JSON.parse(readFileSync(join(repoRoot, 'tests', 'fixtures', 'saju', 'requests', `${name}.json`), 'utf8'));

const baseBirth = () => ({
  calendar: 'solar',
  date: '1998-10-27',
  time: '20:40:00',
  timezone: 'Asia/Seoul',
});
const baseRequest = () => ({ schemaVersion: 1, birth: baseBirth() });

// Asserts validateRequest throws InputError with the exact code and path.
const rejects = (raw, code, path) => {
  assert.throws(
    () => validateRequest(raw),
    (err) => {
      assert.ok(err instanceof InputError, `expected InputError, got ${err}`);
      assert.equal(err.code, code, `code: ${err.code}`);
      assert.equal(err.path, path, `path: ${err.path}`);
      assert.equal(typeof err.message, 'string');
      return true;
    },
  );
};

test('known fixture validates and normalizes every supplied field', () => {
  const req = validateRequest(requestFixture('known'));
  assert.equal(req.schemaVersion, 1);
  assert.equal(req.birth.calendar, 'solar');
  assert.deepEqual(req.birth.date, { year: 1998, month: 10, day: 27, text: '1998-10-27' });
  assert.deepEqual(req.birth.time, { hour: 20, minute: 40, second: 0, text: '20:40:00' });
  assert.equal(req.birth.timezone, 'Asia/Seoul');
  assert.deepEqual(req.birth.utcOffset, { text: '+09:00', seconds: 32400 });
  assert.equal(req.birth.gender, 'male');
  assert.equal(req.birth.leapMonth, null);
  assert.equal(req.queries.majorCycles, 10);
  assert.equal(req.queries.transits.length, 1);
  const t = req.queries.transits[0];
  assert.equal(t.text, '2026-09-17T12:00:00+09:00');
  assert.equal(t.instantMs, Date.parse('2026-09-17T03:00:00Z'));
  assert.equal(t.offsetSeconds, 32400);
  assert.equal(t.localDate, '2026-09-17');
});

test('transits fixture retains request order and duplicates', () => {
  const req = validateRequest(requestFixture('transits'));
  assert.equal(req.queries.transits.length, 3);
  assert.equal(req.queries.transits[0].text, '2026-09-17T12:00:00+09:00');
  assert.equal(req.queries.transits[1].text, '2027-01-01T00:00:00Z');
  assert.equal(req.queries.transits[2].text, '2026-09-17T12:00:00+09:00');
  assert.equal(req.queries.transits[0].instantMs, req.queries.transits[2].instantMs);
  // 2027-01-01T00:00:00Z is 2027-01-01 09:00 in the birth zone.
  assert.equal(req.queries.transits[1].localDate, '2027-01-01');
});

test('unknown-time fixture: explicit null time stays null', () => {
  const req = validateRequest(requestFixture('unknown-time'));
  assert.equal(req.birth.time, null);
  assert.equal(req.queries.majorCycles, 4);
});

test('missing-gender fixture: absent gender stays null, never defaulted', () => {
  const req = validateRequest(requestFixture('missing-gender'));
  assert.equal(req.birth.gender, null);
  assert.equal(req.queries.majorCycles, 10);
});

test('lunar-leap fixture: korean_lunar keeps explicit leapMonth flag', () => {
  const req = validateRequest(requestFixture('lunar-leap'));
  assert.equal(req.birth.calendar, 'korean_lunar');
  assert.equal(req.birth.leapMonth, true);
  assert.deepEqual(req.birth.date, { year: 2017, month: 5, day: 1, text: '2017-05-01' });
});

test('invalid-date fixture rejects 2026-02-30 at birth.date', () => {
  rejects(requestFixture('invalid-date'), 'INVALID_DATE', 'birth.date');
});

test('out-of-range fixture rejects 1899-12-31 at birth.date', () => {
  rejects(requestFixture('out-of-range'), 'DATE_OUT_OF_RANGE', 'birth.date');
});

test('dst-gap and dst-fold fixtures pass schema validation (resolution is time.mjs scope)', () => {
  // Civil-time existence/ambiguity is resolved by resolveCivilTime, not the
  // schema validator; both fixtures are well-formed requests.
  assert.ok(validateRequest(requestFixture('dst-gap')).birth.time);
  assert.ok(validateRequest(requestFixture('dst-fold')).birth.time);
});

test('omitted queries defaults to {majorCycles:0, transits:[]}', () => {
  const req = validateRequest(baseRequest());
  assert.deepEqual(req.queries, { majorCycles: 0, transits: [] });
});

test('validation is deterministic and host-TZ independent', () => {
  const raw = requestFixture('known');
  const a = validateRequest(raw);
  const saved = process.env.TZ;
  process.env.TZ = 'Pacific/Kiritimati';
  try {
    assert.deepEqual(validateRequest(raw), a);
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test('envelope: non-object, unknown fields, wrong/missing schemaVersion reject', () => {
  rejects(null, 'INVALID_REQUEST', '$');
  rejects([], 'INVALID_REQUEST', '$');
  rejects('saju', 'INVALID_REQUEST', '$');
  rejects({ schemaVersion: 1, birth: baseBirth(), extra: 1 }, 'UNKNOWN_FIELD', 'extra');
  rejects({ birth: baseBirth() }, 'MISSING_FIELD', 'schemaVersion');
  rejects({ schemaVersion: 2, birth: baseBirth() }, 'SCHEMA_VERSION_UNSUPPORTED', 'schemaVersion');
  rejects({ schemaVersion: '1', birth: baseBirth() }, 'SCHEMA_VERSION_UNSUPPORTED', 'schemaVersion');
});

test('birth: non-object, missing required fields, unknown fields reject', () => {
  rejects({ schemaVersion: 1, birth: null }, 'INVALID_FIELD', 'birth');
  rejects({ schemaVersion: 1, birth: 'x' }, 'INVALID_FIELD', 'birth');
  const noCal = baseRequest(); delete noCal.birth.calendar;
  rejects(noCal, 'MISSING_FIELD', 'birth.calendar');
  const noDate = baseRequest(); delete noDate.birth.date;
  rejects(noDate, 'MISSING_FIELD', 'birth.date');
  const noTz = baseRequest(); delete noTz.birth.timezone;
  rejects(noTz, 'MISSING_FIELD', 'birth.timezone');
  const noTime = baseRequest(); delete noTime.birth.time;
  rejects(noTime, 'MISSING_FIELD', 'birth.time');
  const extra = baseRequest(); extra.birth.longitude = 127;
  rejects(extra, 'UNKNOWN_FIELD', 'birth.longitude');
  const age = baseRequest(); age.birth.age = 30;
  rejects(age, 'UNKNOWN_FIELD', 'birth.age');
});

test('calendar: only solar|korean_lunar; leapMonth cardinality enforced', () => {
  const bad = baseRequest(); bad.birth.calendar = 'lunar';
  rejects(bad, 'INVALID_VALUE', 'birth.calendar');
  const solarLeap = baseRequest(); solarLeap.birth.leapMonth = false;
  rejects(solarLeap, 'LEAP_MONTH_FORBIDDEN', 'birth.leapMonth');
  const lunarMissing = baseRequest();
  lunarMissing.birth.calendar = 'korean_lunar';
  rejects(lunarMissing, 'LEAP_MONTH_REQUIRED', 'birth.leapMonth');
  const lunarNonBool = baseRequest();
  lunarNonBool.birth.calendar = 'korean_lunar';
  lunarNonBool.birth.leapMonth = 'yes';
  rejects(lunarNonBool, 'INVALID_VALUE', 'birth.leapMonth');
  const lunarOk = baseRequest();
  lunarOk.birth.calendar = 'korean_lunar';
  lunarOk.birth.leapMonth = false;
  assert.equal(validateRequest(lunarOk).birth.leapMonth, false);
});

test('date: strict YYYY-MM-DD, real Gregorian dates, declared support range', () => {
  for (const [value, code] of [
    ['1998-2-7', 'INVALID_DATE'],
    ['1998/10/27', 'INVALID_DATE'],
    ['19981027', 'INVALID_DATE'],
    ['2024-02-30', 'INVALID_DATE'],
    ['1900-02-29', 'INVALID_DATE'], // 1900 is not a Gregorian leap year
    ['2023-04-31', 'INVALID_DATE'],
    ['1998-00-10', 'INVALID_DATE'],
    ['1998-13-01', 'INVALID_DATE'],
    ['1998-10-00', 'INVALID_DATE'],
    ['1899-12-31', 'DATE_OUT_OF_RANGE'],
    ['2101-01-01', 'DATE_OUT_OF_RANGE'],
  ]) {
    const raw = baseRequest(); raw.birth.date = value;
    rejects(raw, code, 'birth.date');
  }
  for (const ok of ['2000-02-29', '2024-02-29', '1900-01-01', '2100-12-31']) {
    const raw = baseRequest(); raw.birth.date = ok;
    assert.equal(validateRequest(raw).birth.date.text, ok);
  }
  const nonString = baseRequest(); nonString.birth.date = 19981027;
  rejects(nonString, 'INVALID_VALUE', 'birth.date');
});

test('time: strict HH:mm:ss 00:00:00-23:59:59 or explicit null', () => {
  for (const value of ['20:40', '20:40:00.0', '8:40:00', '24:00:00', '23:59:60', '12:60:00', 'noon']) {
    const raw = baseRequest(); raw.birth.time = value;
    rejects(raw, 'INVALID_TIME', 'birth.time');
  }
  const nonString = baseRequest(); nonString.birth.time = 20;
  rejects(nonString, 'INVALID_VALUE', 'birth.time');
  for (const ok of ['00:00:00', '23:59:59', '01:02:03']) {
    const raw = baseRequest(); raw.birth.time = ok;
    assert.equal(validateRequest(raw).birth.time.text, ok);
  }
});

test('timezone: required IANA name validated by Intl', () => {
  const bad1 = baseRequest(); bad1.birth.timezone = 'Mars/Olympus';
  rejects(bad1, 'INVALID_TIMEZONE', 'birth.timezone');
  const bad2 = baseRequest(); bad2.birth.timezone = '';
  rejects(bad2, 'INVALID_TIMEZONE', 'birth.timezone');
  const bad3 = baseRequest(); bad3.birth.timezone = 9;
  rejects(bad3, 'INVALID_TIMEZONE', 'birth.timezone');
  for (const ok of ['UTC', 'Asia/Seoul', 'America/New_York', 'Etc/GMT-14']) {
    const raw = baseRequest(); raw.birth.timezone = ok;
    assert.equal(validateRequest(raw).birth.timezone, ok);
  }
});

test('utcOffset: optional ±HH:mm[:ss], seconds retained', () => {
  for (const value of ['+9:00', '9:00', '+09:60', '+24:00', '+09:00:60', 'KST', '+09:00x']) {
    const raw = baseRequest(); raw.birth.utcOffset = value;
    rejects(raw, 'INVALID_UTC_OFFSET', 'birth.utcOffset');
  }
  const nonString = baseRequest(); nonString.birth.utcOffset = 9;
  rejects(nonString, 'INVALID_UTC_OFFSET', 'birth.utcOffset');
  const secs = baseRequest(); secs.birth.utcOffset = '+08:27:52';
  assert.deepEqual(validateRequest(secs).birth.utcOffset, { text: '+08:27:52', seconds: 30472 });
  const neg = baseRequest(); neg.birth.utcOffset = '-05:30';
  assert.equal(validateRequest(neg).birth.utcOffset.seconds, -19800);
  const absent = baseRequest();
  assert.equal(validateRequest(absent).birth.utcOffset, null);
});

test('gender: optional male|female, never defaulted', () => {
  for (const value of ['other', 'm', 'MALE', 1, true]) {
    const raw = baseRequest(); raw.birth.gender = value;
    rejects(raw, 'INVALID_VALUE', 'birth.gender');
  }
  for (const ok of ['male', 'female']) {
    const raw = baseRequest(); raw.birth.gender = ok;
    assert.equal(validateRequest(raw).birth.gender, ok);
  }
});

test('queries: object shape, majorCycles integer 0..12, transits array <=366', () => {
  const nonObj = baseRequest(); nonObj.queries = 'all';
  rejects(nonObj, 'INVALID_FIELD', 'queries');
  const nullQ = baseRequest(); nullQ.queries = null;
  rejects(nullQ, 'INVALID_FIELD', 'queries');
  const unknownQ = baseRequest(); unknownQ.queries = { daily: true };
  rejects(unknownQ, 'UNKNOWN_FIELD', 'queries.daily');
  for (const value of [-1, 13, 1.5, '5', null, true]) {
    const raw = baseRequest(); raw.queries = { majorCycles: value };
    rejects(raw, 'INVALID_VALUE', 'queries.majorCycles');
  }
  for (const ok of [0, 1, 12]) {
    const raw = baseRequest(); raw.queries = { majorCycles: ok };
    assert.equal(validateRequest(raw).queries.majorCycles, ok);
  }
  const nonArr = baseRequest(); nonArr.queries = { transits: '2026-09-17T12:00:00+09:00' };
  rejects(nonArr, 'INVALID_FIELD', 'queries.transits');
  const over = baseRequest();
  over.queries = { transits: Array.from({ length: 367 }, () => '2026-09-17T12:00:00+09:00') };
  rejects(over, 'TOO_MANY_TRANSITS', 'queries.transits');
  const at = baseRequest();
  at.queries = { transits: Array.from({ length: 366 }, () => '2026-09-17T12:00:00+09:00') };
  assert.equal(validateRequest(at).queries.transits.length, 366);
});

test('transits: RFC3339 instants require explicit numeric offset and real date', () => {
  for (const value of [
    'noon',
    '2026-09-17T12:00:00',        // no offset: not an instant
    '2026-09-17 12:00:00Z',       // space separator not RFC3339
    '2026-09-17T12:00:00-00:00',  // RFC3339 unknown-local-offset convention
    '2026-09-17T12:00:00+9:00',
    '2026-09-17T24:00:00Z',
    '2026-06-30T23:59:60Z',       // leap second not representable
    '2026-02-30T00:00:00Z',
    '2026-09-17',                 // date alone is not an instant
    1726e10,
    null,
  ]) {
    const raw = baseRequest(); raw.queries = { transits: [value] };
    rejects(raw, 'INVALID_TRANSIT', 'queries.transits[0]');
  }
  // Offset forms that must parse.
  for (const ok of ['2026-09-17T12:00:00+09:00', '2026-09-17T12:00:00Z',
                    '2026-09-17t12:00:00z', '2026-09-17T12:00:00.5Z',
                    '2026-09-17T12:00:00-05:00']) {
    const raw = baseRequest(); raw.queries = { transits: [ok] };
    assert.equal(validateRequest(raw).queries.transits.length, 1);
  }
});

test('transits: instant must fall inside support range in the birth zone', () => {
  const future = baseRequest();
  future.queries = { transits: ['2101-01-01T00:00:00+09:00'] };
  rejects(future, 'TRANSIT_OUT_OF_RANGE', 'queries.transits[0]');
  const past = baseRequest();
  past.queries = { transits: ['1899-12-31T20:00:00+09:00'] }; // 1899-12-31 in Seoul
  rejects(past, 'TRANSIT_OUT_OF_RANGE', 'queries.transits[0]');
  // Same UTC instant can be in-range in one zone and out in another: the
  // birth zone decides. 2100-12-31T16:00:00Z is 2101-01-01 01:00 in Seoul.
  const boundary = baseRequest();
  boundary.queries = { transits: ['2100-12-31T16:00:00Z'] };
  rejects(boundary, 'TRANSIT_OUT_OF_RANGE', 'queries.transits[0]');
  boundary.birth.timezone = 'UTC';
  assert.equal(validateRequest(boundary).queries.transits[0].localDate, '2100-12-31');
});

test('error objects carry stable machine fields', () => {
  try {
    validateRequest(requestFixture('invalid-date'));
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof InputError);
    assert.equal(err.name, 'InputError');
    assert.equal(err.code, 'INVALID_DATE');
    assert.equal(err.path, 'birth.date');
    assert.equal(typeof err.message, 'string');
  }
});
