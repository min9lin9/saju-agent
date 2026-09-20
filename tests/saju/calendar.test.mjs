// calendar.test.mjs — Korean lunar conversion and astronomical solar terms.
//
// Oracles are the task-1 independent fixtures only:
//   tests/fixtures/saju/calendar.json     KASI solc solar<->lunar anchors
//   tests/fixtures/saju/solar-terms.json  JPL Horizons OBSERVER quantity-31
//                                       roots (UT for 2024 civil checks,
//                                       TT for the 1899..2101 ephemeris span)
// No expected value in this file is derived from the runtime under test.
// Solar-term comparisons reuse each case's declared time scale: UT cases
// compare the engine's UT instant, TT cases compare the engine's TT instant
// (Horizons freezes future leap seconds while the engine models Delta-T, so
// mixing scales would test different conventions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CalendarError,
  JIE_BY_MONTH,
  LUNAR_METADATA_LIMITATION,
  SOLAR_TERM_RANGE,
  SOLAR_TERM_UNCERTAINTY_SECONDS,
  createCalendar,
  findSolarTerm,
  lunarToSolar,
  solarToLunar,
} from '../../skills/saju/scripts/saju/calendar.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const fixtureDir = join(here, '..', 'fixtures', 'saju');

// The test file lives outside skills/saju/scripts, so bare 'astronomy-engine'
// does not resolve here. Resolve the package through the production module's
// own require context, then import its ESM entry by file URL: this is the
// exact same module instance calendar.mjs uses, so injected AstroTime values
// satisfy the engine's instanceof checks.
const scriptsRequire = createRequire(join(repoRoot, 'skills', 'saju', 'scripts', 'saju', 'calendar.mjs'));
const engineCjsPath = scriptsRequire.resolve('astronomy-engine');
const engineEsmUrl = pathToFileURL(join(dirname(engineCjsPath), 'esm', 'astronomy.js')).href;
const Astronomy = await import(engineEsmUrl);
const calendarFixture = JSON.parse(readFileSync(join(fixtureDir, 'calendar.json'), 'utf8'));
const solarTermsFixture = JSON.parse(readFileSync(join(fixtureDir, 'solar-terms.json'), 'utf8'));

const JD_UNIX_EPOCH = 2440587.5;
const jdToMs = (jd) => Math.round((jd - JD_UNIX_EPOCH) * 86400 * 1000);

const assertCalendarError = (fn, code) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CalendarError, `expected CalendarError, got ${err}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return err;
  }
  assert.fail(`expected CalendarError ${code}, call succeeded`);
};

// --- solar terms against the independent Horizons oracle ---------------------

test('all 26 independently sourced solar terms land within 120 s in their own time scale', () => {
  assert.equal(solarTermsFixture.cases.length, 26);
  const deltas = [];
  for (const kase of solarTermsFixture.cases) {
    const term = findSolarTerm({ year: kase.year, month: kase.month });
    assert.equal(term.angleDeg, kase.angle, kase.id);
    assert.equal(term.uncertaintySeconds, SOLAR_TERM_UNCERTAINTY_SECONDS, kase.id);
    assert.equal(term.uncertaintySeconds, 120, kase.id);
    const engineJd = kase.timeScale === 'TT' ? term.julianDayTT : term.julianDayUT;
    const deltaSeconds = Math.abs(engineJd - kase.expectedJulianDay) * 86400;
    assert.ok(
      deltaSeconds <= kase.toleranceSeconds,
      `${kase.id}: |engine ${kase.timeScale} JD ${engineJd} - expected ${kase.expectedJulianDay}|`
        + ` = ${deltaSeconds.toFixed(3)}s > ${kase.toleranceSeconds}s`,
    );
    deltas.push({ id: kase.id, scale: kase.timeScale, deltaSeconds });
    // The returned instant is the same event expressed in UTC milliseconds
    // (Date truncates fractional ms, so allow a 1 ms representation delta).
    assert.ok(Math.abs(term.instantMs - jdToMs(term.julianDayUT)) <= 1, kase.id);
    assert.match(term.iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, kase.id);
    // Angular residual at the returned instant is independently verified.
    const residualDeg = Math.abs(
      (((Astronomy.SunPosition(new Date(term.instantMs)).elon - kase.angle) % 360) + 540) % 360 - 180,
    );
    assert.ok(residualDeg < 0.001, `${kase.id}: residual ${residualDeg} deg`);
    // Bounded window evidence: result stays inside the declared 10-day window.
    assert.ok(
      term.instantMs >= Date.parse(term.windowStartIso)
        && term.instantMs <= Date.parse(term.windowStartIso) + term.windowDays * 86400 * 1000,
      `${kase.id}: instant outside its own search window`,
    );
  }
  // Evidence for the report: worst observed delta per time scale.
  const worst = (scale) => Math.max(...deltas.filter((d) => d.scale === scale).map((d) => d.deltaSeconds));
  assert.ok(worst('UT') <= 120 && worst('TT') <= 120);
});

test('engine TT is exposed for ephemeris comparison and differs from UT by Delta-T', () => {
  const term = findSolarTerm({ year: 2024, month: 2 }); // ut-2024-ipchun
  assert.ok(Number.isFinite(term.ttDays) && Number.isFinite(term.utDays));
  const deltaTSeconds = (term.ttDays - term.utDays) * 86400;
  // Delta-T in 2024 is roughly 69 s; a wide sanity band only proves the two
  // scales are genuinely distinct engine outputs, not a copied field.
  assert.ok(deltaTSeconds > 30 && deltaTSeconds < 400, `Delta-T ${deltaTSeconds}s implausible`);
});

test('solar terms are astronomical events, not fixed-date or fixed-time shortcuts', () => {
  const times = new Set();
  const dates = new Set();
  for (const year of [1998, 2000, 2017, 2024, 2050]) {
    const term = findSolarTerm({ year, month: 2 });
    times.add(term.iso.slice(11));
    dates.add(term.iso.slice(0, 10));
  }
  // Ipchun's UTC time-of-day (and even its UTC date) varies year to year; a
  // fixed-date or fixed-clock table cannot satisfy this.
  assert.ok(times.size >= 4, `ipchun UTC times suspiciously constant: ${[...times]}`);
  assert.ok(dates.size >= 2, `ipchun UTC dates suspiciously constant: ${[...dates]}`);
});

test('jie table maps each month to the declared longitude', () => {
  const expected = [285, 315, 345, 15, 45, 75, 105, 135, 165, 195, 225, 255];
  assert.deepEqual(JIE_BY_MONTH.map((j) => j.angleDeg), expected);
  for (let month = 1; month <= 12; month += 1) {
    const term = findSolarTerm({ year: 2024, month });
    assert.equal(term.angleDeg, expected[month - 1], `month ${month}`);
    assert.equal(term.eventId, `2024-${JIE_BY_MONTH[month - 1].id}`);
  }
});

test('bounded search: ten-day window starting on the first of the month', () => {
  const calls = [];
  const spy = (targetLon, dateStart, limitDays) => {
    calls.push({ targetLon, dateStart, limitDays });
    return Astronomy.SearchSunLongitude(targetLon, dateStart, limitDays);
  };
  const term = findSolarTerm({ year: 2024, month: 2, search: spy });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].targetLon, 315);
  assert.equal(calls[0].limitDays, 10);
  assert.equal(calls[0].dateStart.toISOString(), '2024-02-01T00:00:00.000Z');
  assert.equal(term.windowStartIso, '2024-02-01T00:00:00.000Z');
  assert.equal(term.windowDays, 10);
});

test('lookup failure is explicit: injected search null yields a calculation error, no fallback', () => {
  const err = assertCalendarError(
    () => findSolarTerm({ year: 2024, month: 2, search: () => null }),
    'SOLAR_TERM_SEARCH_FAILED',
  );
  assert.match(err.message, /315/);
});

test('injected search throwing is wrapped as a calculation error, never swallowed', () => {
  assertCalendarError(
    () => findSolarTerm({ year: 2024, month: 2, search: () => { throw new Error('engine exploded'); } }),
    'SOLAR_TERM_SEARCH_FAILED',
  );
});

test('injected wrong instant fails the residual check instead of passing silently', () => {
  const wrong = new Date(Date.UTC(2024, 1, 4, 12, 0, 0)); // inside window, wrong root
  assertCalendarError(
    () => findSolarTerm({ year: 2024, month: 2, search: () => wrong }),
    'SOLAR_TERM_SEARCH_FAILED',
  );
});

test('injected instant outside the bounded window is rejected', () => {
  const outside = new Date(Date.UTC(2024, 1, 20, 0, 0, 0));
  assertCalendarError(
    () => findSolarTerm({ year: 2024, month: 2, search: () => outside }),
    'SOLAR_TERM_SEARCH_FAILED',
  );
});

test('term months outside the declared search range reject explicitly', () => {
  for (const ym of [[1899, 11], [2101, 2], [2024, 0], [2024, 13]]) {
    const [year, month] = ym;
    assertCalendarError(() => findSolarTerm({ year, month }), 'INVALID_SOLAR_TERM');
  }
  // Boundary months are supported: 1899-12 Daeseol and 2101-01 Sohan exist
  // in the fixture and must resolve.
  assert.equal(findSolarTerm({ year: 1899, month: 12 }).angleDeg, 255);
  assert.equal(findSolarTerm({ year: 2101, month: 1 }).angleDeg, 285);
  assert.equal(SOLAR_TERM_RANGE.min, '1899-12');
  assert.equal(SOLAR_TERM_RANGE.max, '2101-01');
});

test('createCalendar memoizes terms within one request but not across instances', () => {
  const cal = createCalendar();
  const a = cal.findSolarTerm({ year: 2024, month: 2 });
  const b = cal.findSolarTerm({ year: 2024, month: 2 });
  assert.equal(a, b); // same memoized object inside one calculation request
  const other = createCalendar().findSolarTerm({ year: 2024, month: 2 });
  assert.notEqual(other, a); // no cross-request cache
  assert.equal(other.instantMs, a.instantMs); // deterministic value
});

// --- Korean lunar conversion -------------------------------------------------

test('KASI-anchored lunar->solar conversions match the archived responses', () => {
  for (const kase of calendarFixture.cases) {
    const got = lunarToSolar({ ...kase.lunar });
    assert.deepEqual(got, kase.solar, kase.id);
  }
});

test('KASI-anchored solar->lunar conversions match the archived responses', () => {
  for (const kase of calendarFixture.cases) {
    const got = solarToLunar({ ...kase.solar });
    assert.deepEqual(got, kase.lunar, kase.id);
  }
});

test('Korean leap-month round-trips preserve the leap flag', () => {
  // Independently anchored leap case plus converter-verified leap months
  // (2020 leap 4, 2023 leap 2, 2025 leap 6): each must convert to solar and
  // back with the same leap flag, never collapsing into the flat month.
  const leapCases = [
    { year: 2017, month: 5, day: 1, leapMonth: true },
    { year: 2020, month: 4, day: 1, leapMonth: true },
    { year: 2020, month: 4, day: 29, leapMonth: true },
    { year: 2023, month: 2, day: 15, leapMonth: true },
    { year: 2025, month: 6, day: 10, leapMonth: true },
  ];
  for (const lunar of leapCases) {
    const solar = lunarToSolar(lunar);
    const back = solarToLunar(solar);
    assert.deepEqual(back, lunar, `round-trip failed for ${JSON.stringify(lunar)} via ${JSON.stringify(solar)}`);
    // The flat twin month must land on a different solar date.
    const flat = lunarToSolar({ ...lunar, leapMonth: false });
    assert.notDeepEqual(flat, solar, `leap and flat ${lunar.year}-${lunar.month} collapsed`);
  }
});

test('solar sweep round-trips every day across leap and non-leap years', () => {
  // 2000-2050 covers every leap month in the supported product horizon; each
  // solar day must map to a lunar date that converts back to itself.
  const start = Date.UTC(2000, 0, 1);
  const end = Date.UTC(2050, 11, 31);
  let checked = 0;
  for (let ms = start; ms <= end; ms += 86400 * 1000) {
    const d = new Date(ms);
    const solar = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    const lunar = solarToLunar(solar);
    assert.ok(lunar !== null, `solarToLunar returned null inside coverage: ${JSON.stringify(solar)}`);
    const back = lunarToSolar(lunar);
    assert.deepEqual(back, solar, `round-trip failed for ${JSON.stringify(solar)} via ${JSON.stringify(lunar)}`);
    checked += 1;
  }
  assert.ok(checked > 18000);
});

test('impossible lunar dates reject explicitly', () => {
  // 2017 has no leap 1st month; leap 5/2017 has only 29 days; month 13 and
  // day 31 never exist; lunar 2050-11-19 is past the converter's last day.
  for (const lunar of [
    { year: 2017, month: 1, day: 1, leapMonth: true },
    { year: 2017, month: 5, day: 30, leapMonth: true },
    { year: 2017, month: 13, day: 1, leapMonth: false },
    { year: 2017, month: 5, day: 31, leapMonth: false },
    { year: 2050, month: 11, day: 19, leapMonth: false },
    { year: 999, month: 1, day: 1, leapMonth: false },
  ]) {
    assertCalendarError(() => lunarToSolar(lunar), 'INVALID_LUNAR_DATE');
  }
});

test('lunar metadata beyond 2050-12-31 is null with the declared limitation code', () => {
  assert.equal(LUNAR_METADATA_LIMITATION, 'LUNAR_METADATA_OUT_OF_RANGE');
  assert.equal(solarToLunar({ year: 2050, month: 12, day: 31 }) !== null, true);
  assert.equal(solarToLunar({ year: 2051, month: 1, day: 1 }), null);
  assert.equal(solarToLunar({ year: 2100, month: 12, day: 31 }), null);
});

test('no stale converter state leaks between calls', () => {
  // A failed conversion must not poison the next one: the upstream object
  // keeps constructor "today" state after a failed setter, so a fresh
  // converter per call is the contract this test pins.
  assertCalendarError(
    () => lunarToSolar({ year: 2017, month: 1, day: 1, leapMonth: true }),
    'INVALID_LUNAR_DATE',
  );
  const solar = lunarToSolar({ year: 2017, month: 5, day: 1, leapMonth: true });
  assert.deepEqual(solar, { year: 2017, month: 6, day: 24 });
  // Interleaved directions stay independent.
  assert.deepEqual(solarToLunar({ year: 2000, month: 1, day: 7 }), {
    year: 1999, month: 12, day: 1, leapMonth: false,
  });
  assert.deepEqual(lunarToSolar({ year: 1998, month: 9, day: 8, leapMonth: false }), {
    year: 1998, month: 10, day: 27,
  });
});

test('malformed converter arguments reject instead of throwing upstream garbage', () => {
  assertCalendarError(() => lunarToSolar({ year: '2017', month: 5, day: 1, leapMonth: true }), 'INVALID_LUNAR_DATE');
  assertCalendarError(() => lunarToSolar({ year: 2017, month: 5, day: 1, leapMonth: 'yes' }), 'INVALID_LUNAR_DATE');
  assertCalendarError(() => solarToLunar({ year: 2017.5, month: 6, day: 24 }), 'INVALID_SOLAR_DATE');
});
