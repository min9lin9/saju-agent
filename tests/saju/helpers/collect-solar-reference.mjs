#!/usr/bin/env node
// Independent JPL Horizons solar-term reference collector.
//
// Captures the solar-terms oracle consumed by tests/fixtures/saju/solar-terms.json.
// Deliberately self-contained: native fetch + proleptic-Gregorian date arithmetic
// only. It MUST NOT import production code or astronomy-engine, so the fixture
// stays an independent anchor for the engine under test.
//
// Protocol (per plan "Root search recipe"):
//   1. OBSERVER quantity 31 (ObsEcLon, geocentric apparent ecliptic-of-date),
//      COMMAND='10' (Sun), CENTER='500@399' (Earth geocenter), APPARENT='AIRLESS'.
//   2. Hourly scan day 1 00:00 -> day 11 00:00 in the requested time scale
//      (UT for the twelve 2024 jie, TT for the historical/future anchors).
//   3. Unwrap longitude near the target, find the unique adjacent hour pair
//      crossing it, re-query only that one-hour bracket at STEP_SIZE='1 m'.
//   4. Linearly interpolate the two minute rows bracketing the target to get
//      the reference Julian Day in the requested scale. Bracket must be <=60 s.
//   5. Archive every raw response under tests/fixtures/saju/raw/horizons/ and
//      record URL, request headers, sha256, retrieval time, API version and
//      ephemeris source per source. One request at a time.
//
// Usage:
//   node tests/saju/helpers/collect-solar-reference.mjs            # collect all cases
//   node tests/saju/helpers/collect-solar-reference.mjs --only <id>[,<id>...]
//   node tests/saju/helpers/collect-solar-reference.mjs --validate # offline re-check
//
// --validate re-parses the archived raw files, recomputes every interpolated
// root and compares it to expectedJulianDay; it performs no network I/O.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(HERE, '../../fixtures/saju');
const RAW_DIR = path.join(FIXTURE_DIR, 'raw', 'horizons');
const FIXTURE_PATH = path.join(FIXTURE_DIR, 'solar-terms.json');

const API_URL = 'https://ssd.jpl.nasa.gov/api/horizons.api';
const REQUEST_HEADERS = {
  'User-Agent':
    'saju-agent-deterministic-fixture-collector/1.0 ' +
    '(https://github.com/min9lin9/saju-agent; independent JPL Horizons reference capture)',
  Accept: 'text/plain',
};
const REQUEST_DELAY_MS = 1200; // one request at a time, polite spacing
const TOLERANCE_SECONDS = 120;
const MAX_BRACKET_SECONDS = 60;

// Jie (month-start) apparent solar longitude by Gregorian month of occurrence.
const JIE_BY_MONTH = [
  ['sohan', 285],      //  1 Jan  소한
  ['ipchun', 315],     //  2 Feb  입춘
  ['gyeongchip', 345], //  3 Mar  경칩
  ['cheongmyeong', 15],//  4 Apr  청명
  ['ipha', 45],        //  5 May  입하
  ['mangjong', 75],    //  6 Jun  망종
  ['haji', 105],       //  7 Jul  하지
  ['ipchu', 135],      //  8 Aug  입추
  ['baengno', 165],    //  9 Sep  백로
  ['hallo', 195],      // 10 Oct  한로
  ['ipdong', 225],     // 11 Nov  입동
  ['daeseol', 255],    // 12 Dec  대설
];
const TERM_BY_ANGLE = new Map(JIE_BY_MONTH.map(([name, angle]) => [angle, name]));

const MONTHS = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

function buildCases() {
  const cases = [];
  // Twelve 2024 jie in UT (post-1962 UT is UTC per Horizons convention).
  for (let month = 1; month <= 12; month += 1) {
    const [term, angle] = JIE_BY_MONTH[month - 1];
    cases.push({ id: `ut-2024-${term}`, year: 2024, month, angle, timeScale: 'UT' });
  }
  // Ipchun + Daeseol anchors in TT for independent ephemeris comparison.
  for (const year of [1900, 1954, 1988, 2000, 2050, 2100]) {
    cases.push({ id: `tt-${year}-ipchun`, year, month: 2, angle: 315, timeScale: 'TT' });
    cases.push({ id: `tt-${year}-daeseol`, year, month: 12, angle: 255, timeScale: 'TT' });
  }
  // Edge terms just outside the 1900-2100 support range, also TT.
  cases.push({ id: 'tt-1899-daeseol', year: 1899, month: 12, angle: 255, timeScale: 'TT' });
  cases.push({ id: 'tt-2101-sohan', year: 2101, month: 1, angle: 285, timeScale: 'TT' });
  return cases;
}

// --- pure date/angle arithmetic -------------------------------------------

// Julian Day of a proleptic-Gregorian civil instant in whatever uniform scale
// the rows are labelled with (UT or TT). Meeus, Astronomical Algorithms ch.7.
function jdFromCivil(year, month, day, hour, minute, second) {
  let y = year;
  let m = month;
  if (m <= 2) { y -= 1; m += 12; }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  const dayFrac = (hour + minute / 60 + second / 3600) / 24;
  return (
    Math.floor(365.25 * (y + 4716)) +
    Math.floor(30.6001 * (m + 1)) +
    day + dayFrac + b - 1524.5
  );
}

function parseTimestamp(text) {
  const m = text.trim().match(
    /^(\d{4})-([A-Za-z]{3})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!m) throw new Error(`unparseable Horizons timestamp: ${JSON.stringify(text)}`);
  const month = MONTHS[m[2]];
  if (!month) throw new Error(`unknown month in timestamp: ${JSON.stringify(text)}`);
  return {
    year: Number(m[1]), month, day: Number(m[3]),
    hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6] ?? 0),
  };
}

function jdOfRow(row) {
  const t = parseTimestamp(row.time);
  return jdFromCivil(t.year, t.month, t.day, t.hour, t.minute, t.second);
}

// Signed shortest angular distance from target, in (-180, 180].
function deltaFromTarget(lon, target) {
  return ((((lon - target) % 360) + 540) % 360) - 180;
}

// --- Horizons access --------------------------------------------------------

function buildUrl({ timeScale, start, stop, step }) {
  const params = new URLSearchParams({
    format: 'text',
    COMMAND: "'10'",
    OBJ_DATA: 'NO',
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'OBSERVER',
    CENTER: '500@399',
    QUANTITIES: '31',
    TIME_TYPE: timeScale,
    TIME_ZONE: '+00:00',
    TIME_DIGITS: 'SECONDS',
    CAL_TYPE: 'GREGORIAN',
    APPARENT: 'AIRLESS',
    CSV_FORMAT: 'YES',
    EXTRA_PREC: 'YES',
    START_TIME: `'${start}'`,
    STOP_TIME: `'${stop}'`,
    STEP_SIZE: `'${step}'`,
  });
  return `${API_URL}?${params.toString()}`;
}

// Positive-marker validation: HTTP 200 alone is not success. Horizons reports
// failures (unknown target, bad dates, rate limits) as 200 responses lacking
// the ephemeris block, so require every expected header plus $$SOE/$$EOE.
function validateResponse(text, timeScale) {
  const required = [
    /^API VERSION: (\S+)/m,
    /^Target body name: Sun \(10\)\s+\{source: (\S+)\}/m,
    /^Center body name: Earth \(399\)\s+\{source: (\S+)\}/m,
    /^Center-site name: GEOCENTRIC/m,
    new RegExp(`^Start time\\s+: A\\.D\\. .+ ${timeScale}\\s*$`, 'm'),
    new RegExp(`^Stop  time\\s+: A\\.D\\. .+ ${timeScale}\\s*$`, 'm'),
    new RegExp(`^ Date__\\(${timeScale}\\)__HR:MN(?::SS)?,`, 'm'),
    /,\s*ObsEcLon,\s*ObsEcLat,/,
    /^\$\$SOE$/m,
    /^\$\$EOE$/m,
  ];
  for (const re of required) {
    if (!re.test(text)) {
      throw new Error(`Horizons response failed validation (missing ${re})`);
    }
  }
  const apiVersion = text.match(/^API VERSION: (\S+)/m)[1];
  const ephemerisSource = text.match(/^Target body name: Sun \(10\)\s+\{source: (\S+)\}/m)[1];
  return { apiVersion, ephemerisSource };
}

function parseRows(text) {
  const soe = text.indexOf('$$SOE');
  const eoe = text.indexOf('$$EOE');
  if (soe < 0 || eoe < 0 || eoe <= soe) throw new Error('missing $$SOE/$$EOE block');
  return text
    .slice(soe + '$$SOE'.length, eoe)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const fields = line.split(',');
      const lon = Number(fields[3]);
      if (!Number.isFinite(lon)) {
        throw new Error(`unparseable ObsEcLon row: ${JSON.stringify(line)}`);
      }
      return { time: fields[0].trim(), lon };
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchHorizons(args) {
  const url = buildUrl(args);
  const retrievedAt = new Date().toISOString();
  const res = await fetch(url, { headers: REQUEST_HEADERS });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Horizons HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const meta = validateResponse(text, args.timeScale);
  return { url, retrievedAt, text, ...meta };
}

// Unique adjacent pair whose unwrapped longitudes straddle the target.
function findCrossing(rows, target) {
  const crossings = [];
  for (let i = 0; i + 1 < rows.length; i += 1) {
    const d1 = deltaFromTarget(rows[i].lon, target);
    const d2 = deltaFromTarget(rows[i + 1].lon, target);
    if ((d1 <= 0 && d2 >= 0) && (d2 - d1) > 0) crossings.push(i);
  }
  if (crossings.length !== 1) {
    throw new Error(`expected exactly one longitude crossing, found ${crossings.length}`);
  }
  return crossings[0];
}

// Root of target longitude between two bracketing rows, linear in JD.
function interpolate(rowA, rowB, target) {
  const jdA = jdOfRow(rowA);
  const jdB = jdOfRow(rowB);
  const dA = deltaFromTarget(rowA.lon, target);
  const dB = deltaFromTarget(rowB.lon, target);
  if (dA === 0) return { jd: jdA, jdA, jdB };
  if (dB === 0) return { jd: jdB, jdA, jdB };
  const jd = jdA + (jdB - jdA) * (-dA / (dB - dA));
  return { jd, jdA, jdB };
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function collectCase(kase) {
  const pad = (n) => String(n).padStart(2, '0');
  const day1 = `${kase.year}-${pad(kase.month)}-01 00:00`;
  const day11 = `${kase.year}-${pad(kase.month)}-11 00:00`;

  const hourly = await fetchHorizons({
    timeScale: kase.timeScale, start: day1, stop: day11, step: '1 h',
  });
  await sleep(REQUEST_DELAY_MS);

  const hourRows = parseRows(hourly.text);
  const hourIdx = findCrossing(hourRows, kase.angle);
  const bracketStart = hourRows[hourIdx].time;
  const bracketStop = hourRows[hourIdx + 1].time;

  const minute = await fetchHorizons({
    timeScale: kase.timeScale, start: bracketStart, stop: bracketStop, step: '1 m',
  });
  await sleep(REQUEST_DELAY_MS);

  const minuteRows = parseRows(minute.text);
  const minuteIdx = findCrossing(minuteRows, kase.angle);
  const { jd, jdA, jdB } = interpolate(
    minuteRows[minuteIdx], minuteRows[minuteIdx + 1], kase.angle,
  );
  // Rows are minute-stepped; JD subtraction carries ~3.7e-5 s of float noise,
  // so round to milliseconds before enforcing the <=60 s contract.
  const bracketSeconds = Math.round((jdB - jdA) * 86400 * 1000) / 1000;
  if (!(bracketSeconds >= 0 && bracketSeconds <= MAX_BRACKET_SECONDS)) {
    throw new Error(`bracket ${bracketSeconds}s exceeds ${MAX_BRACKET_SECONDS}s`);
  }

  const hourlyFile = `${kase.id}-hourly.txt`;
  const minuteFile = `${kase.id}-minute.txt`;
  await writeFile(path.join(RAW_DIR, hourlyFile), hourly.text, 'utf8');
  await writeFile(path.join(RAW_DIR, minuteFile), minute.text, 'utf8');

  const sourceFor = (response, rawFile) => ({
    id: `${kase.id}-${rawFile.endsWith('hourly.txt') ? 'hourly' : 'minute'}`,
    url: response.url,
    requestHeaders: { ...REQUEST_HEADERS },
    rawFile: `raw/horizons/${rawFile}`,
    sha256: sha256(response.text),
    retrievedAt: response.retrievedAt,
    center: '500@399',
    quantity: '31',
    frame: 'apparent-ecliptic-of-date',
    timeScale: kase.timeScale,
    apiVersion: response.apiVersion,
    ephemerisSource: response.ephemerisSource,
  });

  return {
    record: {
      id: kase.id,
      angle: kase.angle,
      year: kase.year,
      month: kase.month,
      timeScale: kase.timeScale,
      expectedJulianDay: Number(jd.toFixed(9)),
      toleranceSeconds: TOLERANCE_SECONDS,
      sourceIds: [`${kase.id}-hourly`, `${kase.id}-minute`],
      bracketSeconds: Number(bracketSeconds.toFixed(3)),
    },
    sources: [sourceFor(hourly, hourlyFile), sourceFor(minute, minuteFile)],
    detail: {
      bracketStart, bracketStop,
      before: minuteRows[minuteIdx], after: minuteRows[minuteIdx + 1],
    },
  };
}

// --- offline validation -----------------------------------------------------

async function validate() {
  const fixture = JSON.parse(await readFile(FIXTURE_PATH, 'utf8'));
  if (fixture.schemaVersion !== 1) throw new Error('schemaVersion must be 1');
  const sources = new Map(fixture.sources.map((s) => [s.id, s]));
  const expected = buildCases();
  const problems = [];

  if (fixture.cases.length !== expected.length) {
    problems.push(`case count ${fixture.cases.length} != ${expected.length}`);
  }
  for (const want of expected) {
    const got = fixture.cases.find((c) => c.id === want.id);
    if (!got) { problems.push(`missing case ${want.id}`); continue; }
    for (const key of ['angle', 'year', 'month', 'timeScale']) {
      if (got[key] !== want[key]) problems.push(`${want.id}: ${key} ${got[key]} != ${want[key]}`);
    }
    if (got.toleranceSeconds !== TOLERANCE_SECONDS) {
      problems.push(`${want.id}: toleranceSeconds ${got.toleranceSeconds}`);
    }
    if (!(got.bracketSeconds >= 0 && got.bracketSeconds <= MAX_BRACKET_SECONDS)) {
      problems.push(`${want.id}: bracketSeconds ${got.bracketSeconds} > ${MAX_BRACKET_SECONDS}`);
    }
    if (!Array.isArray(got.sourceIds) || got.sourceIds.length !== 2) {
      problems.push(`${want.id}: sourceIds must name hourly+minute sources`);
      continue;
    }
    // Re-derive the root from the archived minute response alone.
    const minuteSource = sources.get(got.sourceIds[1]);
    const hourlySource = sources.get(got.sourceIds[0]);
    if (!minuteSource || !hourlySource) {
      problems.push(`${want.id}: unresolved sourceIds`);
      continue;
    }
    for (const src of [hourlySource, minuteSource]) {
      const raw = await readFile(path.join(FIXTURE_DIR, src.rawFile), 'utf8');
      if (sha256(raw) !== src.sha256) problems.push(`${src.id}: sha256 mismatch`);
      try {
        validateResponse(raw, src.timeScale);
      } catch (err) {
        problems.push(`${src.id}: ${err.message}`);
      }
      if (src.center !== '500@399' || src.quantity !== '31') {
        problems.push(`${src.id}: center/quantity drifted`);
      }
    }
    const minuteRows = parseRows(await readFile(path.join(FIXTURE_DIR, minuteSource.rawFile), 'utf8'));
    const idx = findCrossing(minuteRows, got.angle);
    const { jd, jdA, jdB } = interpolate(minuteRows[idx], minuteRows[idx + 1], got.angle);
    const bracket = Math.round((jdB - jdA) * 86400 * 1000) / 1000;
    if (bracket > MAX_BRACKET_SECONDS) {
      problems.push(`${want.id}: recomputed bracket ${bracket}s`);
    }
    const driftSeconds = Math.abs(jd - got.expectedJulianDay) * 86400;
    if (driftSeconds > 0.01) {
      problems.push(`${want.id}: recomputed JD drifts ${driftSeconds}s from expectedJulianDay`);
    }
    // The archived hourly rows must contain the minute bracket.
    const hourRows = parseRows(await readFile(path.join(FIXTURE_DIR, hourlySource.rawFile), 'utf8'));
    const hIdx = findCrossing(hourRows, got.angle);
    const hA = jdOfRow(hourRows[hIdx]);
    const hB = jdOfRow(hourRows[hIdx + 1]);
    if (!(jdA >= hA - 1e-9 && jdB <= hB + 1e-9)) {
      problems.push(`${want.id}: minute bracket outside archived hourly bracket`);
    }
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`INVALID: ${p}`);
    throw new Error(`${problems.length} fixture problem(s)`);
  }
  console.log(`validated ${fixture.cases.length} cases, ${fixture.sources.length} sources: all roots re-derived from archived raw responses, brackets <= ${MAX_BRACKET_SECONDS}s`);
}

// --- entry point ------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--validate')) {
    await validate();
    return;
  }
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? new Set(args[onlyIdx + 1].split(',')) : null;

  await mkdir(RAW_DIR, { recursive: true });
  const cases = buildCases().filter((c) => !only || only.has(c.id));
  if (cases.length === 0) throw new Error('no matching cases');

  const records = [];
  const sources = [];
  for (const kase of cases) {
    const { record, sources: src, detail } = await collectCase(kase);
    records.push(record);
    sources.push(...src);
    const iso = new Date((record.expectedJulianDay - 2440587.5) * 86400000).toISOString();
    console.log(
      `${record.id} angle=${record.angle} ${record.timeScale} ` +
      `JD=${record.expectedJulianDay} (~${iso} unix-scale) ` +
      `bracket=${record.bracketSeconds}s ` +
      `[${detail.before.time} ${detail.before.lon} -> ${detail.after.time} ${detail.after.lon}]`,
    );
  }

  if (only) {
    // Merge into an existing fixture instead of rewriting unrelated cases.
    let existing = { cases: [], sources: [] };
    try {
      existing = JSON.parse(await readFile(FIXTURE_PATH, 'utf8'));
    } catch { /* first collection: start fresh */ }
    const byId = new Map(existing.cases.map((c) => [c.id, c]));
    const srcById = new Map(existing.sources.map((s) => [s.id, s]));
    for (const r of records) byId.set(r.id, r);
    for (const s of sources) srcById.set(s.id, s);
    const order = new Map(buildCases().map((c, i) => [c.id, i]));
    const merged = [...byId.values()].sort((a, b) => order.get(a.id) - order.get(b.id));
    const fixture = { schemaVersion: 1, cases: merged, sources: [...srcById.values()] };
    await writeFile(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  } else {
    const fixture = { schemaVersion: 1, cases: records, sources };
    await writeFile(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  }
  console.log(`wrote ${FIXTURE_PATH}`);
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
