// Test-only fixture integrity validator for tests/fixtures/saju/.
//
// validateFixtureTree({fixtureDir, repoRoot}) returns a list of machine-readable
// problems [{code, path, message}]; an empty list means the fixture tree is
// internally consistent and anchored to its archived upstream raw responses.
// It never writes to the fixture tree, never imports production code or
// astronomy-engine, and treats every fixture/raw file as untrusted data.
//
// Problem codes (machine-consumed; tests assert codes, not prose):
//   MANIFEST_MISSING / MANIFEST_INVALID / FILE_MISSING / FILE_SHA256_MISMATCH /
//   UNDECLARED_FILE / UNREFERENCED_RAW / JSON_INVALID / SCHEMA_MISMATCH /
//   CASE_FIELD_MISMATCH / PROVENANCE_MISMATCH / RAW_SHA256_MISMATCH /
//   RAW_FILE_MISSING / RAW_BODY_INVALID / ANCHOR_MISMATCH / QUARANTINE_VIOLATION /
//   REQUEST_INVALID / EXPECT_INVALID / BASELINE_MISMATCH / ROOT_DERIVATION_MISMATCH

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const TOLERANCE_SECONDS = 120;
const MAX_BRACKET_SECONDS = 60;
const JD_UNIX_EPOCH = 2440587.5;
const DAY_CYCLE_STEMS = '甲乙丙丁戊己庚辛壬癸';
const DAY_CYCLE_BRANCHES = '子丑寅卯辰巳午未申酉戌亥';
const DAY_CYCLE_ANCHOR = { solarDate: '2000-01-07', ganZhi: '甲子' };
const SUPPORT_RANGE = { min: '1900-01-01', max: '2100-12-31' };
const KNOWN_LIMITATIONS = new Set([
  'UNKNOWN_BIRTH_TIME',
  'MISSING_MAJOR_DIRECTION',
  'AMBIGUOUS_NATAL_BOUNDARY',
  'SOLAR_TERM_UNCERTAINTY',
  'LUNAR_METADATA_OUT_OF_RANGE',
]);

// The 26-case solar-term oracle the fixture must contain, in fixture id form.
const JIE_BY_MONTH = [
  ['sohan', 285], ['ipchun', 315], ['gyeongchip', 345], ['cheongmyeong', 15],
  ['ipha', 45], ['mangjong', 75], ['soseo', 105], ['ipchu', 135],
  ['baengno', 165], ['hallo', 195], ['ipdong', 225], ['daeseol', 255],
];
const EXPECTED_SOLAR_CASES = (() => {
  const cases = [];
  for (let month = 1; month <= 12; month += 1) {
    const [term, angle] = JIE_BY_MONTH[month - 1];
    cases.push({ id: `ut-2024-${term}`, year: 2024, month, angle, timeScale: 'UT' });
  }
  for (const year of [1900, 1954, 1988, 2000, 2050, 2100]) {
    cases.push({ id: `tt-${year}-ipchun`, year, month: 2, angle: 315, timeScale: 'TT' });
    cases.push({ id: `tt-${year}-daeseol`, year, month: 12, angle: 255, timeScale: 'TT' });
  }
  cases.push({ id: 'tt-1899-daeseol', year: 1899, month: 12, angle: 255, timeScale: 'TT' });
  cases.push({ id: 'tt-2101-sohan', year: 2101, month: 1, angle: 285, timeScale: 'TT' });
  return cases;
})();

const MONTHS = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// --- independent date / angle arithmetic (no production imports) ------------

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

function jdnOfDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Math.round(jdFromCivil(y, m, d, 12, 0, 0));
}

function isGregorianDate(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return d <= dim;
}

function parseHorizonsTimestamp(text) {
  const m = text.trim().match(/^(\d{4})-([A-Za-z]{3})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const month = MONTHS[m[2]];
  if (!month) return null;
  return {
    year: Number(m[1]), month, day: Number(m[3]),
    hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6] ?? 0),
  };
}

function horizonsRowJd(row) {
  const t = parseHorizonsTimestamp(row.time);
  if (!t) return null;
  return jdFromCivil(t.year, t.month, t.day, t.hour, t.minute, t.second);
}

function deltaFromTarget(lon, target) {
  return ((((lon - target) % 360) + 540) % 360) - 180;
}

// --- Horizons raw body handling ----------------------------------------------

function horizonsMarkersOk(text, timeScale) {
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
  return required.every((re) => re.test(text));
}

function horizonsHeaderMeta(text) {
  const api = text.match(/^API VERSION: (\S+)/m);
  const eph = text.match(/^Target body name: Sun \(10\)\s+\{source: (\S+)\}/m);
  return { apiVersion: api?.[1] ?? null, ephemerisSource: eph?.[1] ?? null };
}

function parseHorizonsRows(text) {
  const soe = text.indexOf('$$SOE');
  const eoe = text.indexOf('$$EOE');
  if (soe < 0 || eoe < 0 || eoe <= soe) return null;
  const rows = [];
  for (const line of text.slice(soe + 5, eoe).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fields = trimmed.split(',');
    const lon = Number(fields[3]);
    if (!Number.isFinite(lon)) return null;
    rows.push({ time: fields[0].trim(), lon });
  }
  return rows.length >= 2 ? rows : null;
}

function findUniqueCrossing(rows, target) {
  const crossings = [];
  for (let i = 0; i + 1 < rows.length; i += 1) {
    const d1 = deltaFromTarget(rows[i].lon, target);
    const d2 = deltaFromTarget(rows[i + 1].lon, target);
    if (d1 <= 0 && d2 >= 0 && d2 - d1 > 0) crossings.push(i);
  }
  return crossings.length === 1 ? crossings[0] : null;
}

function interpolateRoot(rowA, rowB, target) {
  const jdA = horizonsRowJd(rowA);
  const jdB = horizonsRowJd(rowB);
  if (jdA === null || jdB === null) return null;
  const dA = deltaFromTarget(rowA.lon, target);
  const dB = deltaFromTarget(rowB.lon, target);
  if (dA === 0) return { jd: jdA, jdA, jdB };
  if (dB === 0) return { jd: jdB, jdA, jdB };
  return { jd: jdA + (jdB - jdA) * (-dA / (dB - dA)), jdA, jdB };
}

// --- civil-time candidate enumeration (Intl, no host TZ dependence) ----------

// Distinct UTC offsets (seconds) the zone applies within +/-48 h of the guess.
function zoneOffsetsAround(timezone, guessMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const offsets = new Set();
  for (let h = -48; h <= 48; h += 1) {
    const parts = dtf.formatToParts(new Date(guessMs + h * 3600e3));
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    offsets.add(Math.round((wallAsUtc - (guessMs + h * 3600e3)) / 1000));
  }
  return offsets;
}

// Count candidate instants whose zone wall fields equal the requested wall time.
function countLocalTimeCandidates(timezone, date, time) {
  const [y, mo, d] = date.split('-').map(Number);
  const [hh, mm, ss] = time.split(':').map(Number);
  const guessMs = Date.UTC(y, mo - 1, d, hh, mm, ss);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  let matches = 0;
  for (const offsetSec of zoneOffsetsAround(timezone, guessMs)) {
    const instant = guessMs - offsetSec * 1000;
    const parts = dtf.formatToParts(new Date(instant));
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    if (
      get('year') === y && get('month') === mo && get('day') === d &&
      get('hour') % 24 === hh && get('minute') === mm && get('second') === ss
    ) matches += 1;
  }
  return matches;
}

// --- small helpers ------------------------------------------------------------

function readJson(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function listFiles(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...listFiles(full, rel));
    else out.push(rel);
  }
  return out;
}

function extractHanzi(label) {
  const m = typeof label === 'string' ? label.match(/\(([^)]*)\)/) : null;
  return m ? m[1] : null;
}

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// --- section validators -------------------------------------------------------

function checkCalendar(fixtureDir, doc, problems, rawFiles) {
  const P = 'calendar.json';
  if (doc.schemaVersion !== 1) problems.push({ code: 'SCHEMA_MISMATCH', path: `${P}.schemaVersion`, message: 'schemaVersion must be 1' });
  if (!Array.isArray(doc.cases) || !Array.isArray(doc.sources)) {
    problems.push({ code: 'SCHEMA_MISMATCH', path: P, message: 'cases and sources must be arrays' });
    return;
  }
  if (doc.cases.length !== 3) problems.push({ code: 'CASE_FIELD_MISMATCH', path: `${P}.cases`, message: `expected 3 KASI cases, got ${doc.cases.length}` });
  if (doc.sources.length !== 3) problems.push({ code: 'CASE_FIELD_MISMATCH', path: `${P}.sources`, message: `expected 3 KASI sources, got ${doc.sources.length}` });
  const sources = new Map(doc.sources.map((s) => [s.id, s]));
  const caseIds = new Set();

  for (const kase of doc.cases) {
    const cp = `${P}.cases[${kase?.id ?? '?'}]`;
    if (!kase || typeof kase.id !== 'string') {
      problems.push({ code: 'SCHEMA_MISMATCH', path: cp, message: 'case id missing' });
      continue;
    }
    caseIds.add(kase.id);
    const src = sources.get(kase.sourceId);
    if (!src) {
      problems.push({ code: 'PROVENANCE_MISMATCH', path: `${cp}.sourceId`, message: `unresolved sourceId ${kase.sourceId}` });
      continue;
    }
    const sp = `${P}.sources[${src.id}]`;
    // URL must be the KASI solc endpoint echoing the requested solar date.
    let url;
    try { url = new URL(src.url); } catch { url = null; }
    if (!url || url.hostname !== 'astro.kasi.re.kr' || url.pathname !== '/life/solc') {
      problems.push({ code: 'PROVENANCE_MISMATCH', path: `${sp}.url`, message: `unexpected KASI url ${src.url}` });
      continue;
    }
    const q = {
      yyyy: url.searchParams.get('yyyy'),
      mm: url.searchParams.get('mm'),
      dd: url.searchParams.get('dd'),
    };
    if (src.requestHeaders?.['User-Agent'] !== 'Mozilla/5.0') {
      problems.push({ code: 'PROVENANCE_MISMATCH', path: `${sp}.requestHeaders`, message: 'explicit User-Agent Mozilla/5.0 required' });
    }
    if (typeof src.retrievedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(src.retrievedAt)) {
      problems.push({ code: 'PROVENANCE_MISMATCH', path: `${sp}.retrievedAt`, message: 'retrieval timestamp missing' });
    }
    const rawPath = join(fixtureDir, src.rawFile ?? '');
    rawFiles.add(src.rawFile);
    if (!existsSync(rawPath)) {
      problems.push({ code: 'RAW_FILE_MISSING', path: src.rawFile, message: `raw file for ${src.id} missing` });
      continue;
    }
    const rawText = readFileSync(rawPath, 'utf8');
    if (sha256(rawText) !== src.sha256) {
      problems.push({ code: 'RAW_SHA256_MISMATCH', path: `${sp}.sha256`, message: `archived bytes do not match recorded sha256 for ${src.id}` });
      continue; // body untrusted once hash fails
    }
    let raw;
    try { raw = JSON.parse(rawText); } catch { raw = null; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push({ code: 'RAW_BODY_INVALID', path: src.rawFile, message: 'KASI response is not a JSON object (HTML/error page?)' });
      continue;
    }
    // The archived body must echo the requested solar date.
    if (raw.SOLC_YYYY !== q.yyyy || raw.SOLC_MM !== q.mm || raw.SOLC_DD !== q.dd) {
      problems.push({ code: 'RAW_BODY_INVALID', path: src.rawFile, message: `SOLC fields ${raw.SOLC_YYYY}-${raw.SOLC_MM}-${raw.SOLC_DD} do not echo request ${q.yyyy}-${q.mm}-${q.dd}` });
    }
    for (const field of ['LUNC_ILJIN', 'LUNC_YYYY', 'LUNC_MM', 'LUNC_DD', 'LUNC_LEAP_MM', 'SOLC_JD']) {
      if (!(field in raw)) problems.push({ code: 'RAW_BODY_INVALID', path: src.rawFile, message: `missing field ${field}` });
    }
    // Case values must derive from the archived raw fields only.
    const solarIso = `${raw.SOLC_YYYY}-${raw.SOLC_MM}-${raw.SOLC_DD}`;
    if (kase.solar?.year !== Number(raw.SOLC_YYYY) || kase.solar?.month !== Number(raw.SOLC_MM) || kase.solar?.day !== Number(raw.SOLC_DD)) {
      problems.push({ code: 'ANCHOR_MISMATCH', path: `${cp}.solar`, message: 'case solar date does not match archived SOLC fields' });
    }
    if (kase.lunar?.year !== Number(raw.LUNC_YYYY) || kase.lunar?.month !== Number(raw.LUNC_MM) || kase.lunar?.day !== Number(raw.LUNC_DD)) {
      problems.push({ code: 'ANCHOR_MISMATCH', path: `${cp}.lunar`, message: 'case lunar date does not match archived LUNC fields' });
    }
    const leap = raw.LUNC_LEAP_MM === '윤' ? true : raw.LUNC_LEAP_MM === '평' ? false : null;
    if (leap === null || kase.lunar?.leapMonth !== leap) {
      problems.push({ code: 'ANCHOR_MISMATCH', path: `${cp}.lunar.leapMonth`, message: `LUNC_LEAP_MM=${raw.LUNC_LEAP_MM} vs leapMonth=${kase.lunar?.leapMonth}` });
    }
    // Only LUNC_ILJIN may anchor the day pillar.
    if (kase.dayGanZhi !== extractHanzi(raw.LUNC_ILJIN)) {
      problems.push({ code: 'ANCHOR_MISMATCH', path: `${cp}.dayGanZhi`, message: `dayGanZhi ${kase.dayGanZhi} != LUNC_ILJIN ${raw.LUNC_ILJIN}` });
    }
    // Quarantine: lunar-calendar year/month labels must never equal the anchor.
    for (const label of ['LUNC_PRCN', 'LUNC_WLGN']) {
      if (extractHanzi(raw[label]) === kase.dayGanZhi) {
        problems.push({ code: 'QUARANTINE_VIOLATION', path: `${cp}.dayGanZhi`, message: `dayGanZhi equals ${label} ${raw[label]}; anchor must come from LUNC_ILJIN only` });
      }
    }
    // Independent arithmetic anchor: JDN day-cycle index must reproduce the
    // recorded ganzhi relative to the 2000-01-07 = 甲子 epoch.
    const idx = (((jdnOfDate(solarIso) - jdnOfDate(DAY_CYCLE_ANCHOR.solarDate)) % 60) + 60) % 60;
    const derived = DAY_CYCLE_STEMS[idx % 10] + DAY_CYCLE_BRANCHES[idx % 12];
    if (derived !== kase.dayGanZhi) {
      problems.push({ code: 'ANCHOR_MISMATCH', path: `${cp}.dayGanZhi`, message: `JDN day-cycle index ${idx} derives ${derived}, not ${kase.dayGanZhi}` });
    }
    if (Number(raw.SOLC_JD) !== jdnOfDate(solarIso)) {
      problems.push({ code: 'ANCHOR_MISMATCH', path: `${cp}.solar`, message: `SOLC_JD ${raw.SOLC_JD} != computed JDN ${jdnOfDate(solarIso)}` });
    }
  }
  for (const id of sources.keys()) {
    if (!caseIds.has(id)) problems.push({ code: 'PROVENANCE_MISMATCH', path: `${P}.sources[${id}]`, message: 'source not referenced by any case' });
  }
}

function checkSolarTerms(fixtureDir, doc, problems, rawFiles) {
  const P = 'solar-terms.json';
  if (doc.schemaVersion !== 1) problems.push({ code: 'SCHEMA_MISMATCH', path: `${P}.schemaVersion`, message: 'schemaVersion must be 1' });
  if (!Array.isArray(doc.cases) || !Array.isArray(doc.sources)) {
    problems.push({ code: 'SCHEMA_MISMATCH', path: P, message: 'cases and sources must be arrays' });
    return;
  }
  const sources = new Map(doc.sources.map((s) => [s.id, s]));
  const seen = new Set();
  for (const want of EXPECTED_SOLAR_CASES) {
    const got = doc.cases.find((c) => c.id === want.id);
    const cp = `${P}.cases[${want.id}]`;
    if (!got) {
      problems.push({ code: 'CASE_FIELD_MISMATCH', path: cp, message: 'required case missing' });
      continue;
    }
    seen.add(got.id);
    for (const key of ['angle', 'year', 'month', 'timeScale']) {
      if (got[key] !== want[key]) {
        problems.push({ code: 'CASE_FIELD_MISMATCH', path: `${cp}.${key}`, message: `${got[key]} != ${want[key]}` });
      }
    }
    if (got.toleranceSeconds !== TOLERANCE_SECONDS) {
      problems.push({ code: 'CASE_FIELD_MISMATCH', path: `${cp}.toleranceSeconds`, message: `tolerance ${got.toleranceSeconds} != ${TOLERANCE_SECONDS}` });
    }
    if (!(got.bracketSeconds > 0 && got.bracketSeconds <= MAX_BRACKET_SECONDS)) {
      problems.push({ code: 'CASE_FIELD_MISMATCH', path: `${cp}.bracketSeconds`, message: `bracket ${got.bracketSeconds}s outside (0, ${MAX_BRACKET_SECONDS}]` });
    }
    if (!Array.isArray(got.sourceIds) || got.sourceIds.length !== 2) {
      problems.push({ code: 'PROVENANCE_MISMATCH', path: `${cp}.sourceIds`, message: 'case must name hourly+minute sources' });
      continue;
    }
    const [hourly, minute] = got.sourceIds.map((id) => sources.get(id));
    if (!hourly || !minute) {
      problems.push({ code: 'PROVENANCE_MISMATCH', path: `${cp}.sourceIds`, message: 'unresolved sourceIds' });
      continue;
    }
    const raws = {};
    for (const src of [hourly, minute]) {
      const sp = `${P}.sources[${src.id}]`;
      // Provenance contract: geocentric apparent ecliptic-of-date, quantity 31,
      // matching time scale, recorded API version and ephemeris source.
      if (src.center !== '500@399') problems.push({ code: 'PROVENANCE_MISMATCH', path: `${sp}.center`, message: `center ${src.center} != 500@399` });
      if (src.quantity !== '31') problems.push({ code: 'PROVENANCE_MISMATCH', path: `${sp}.quantity`, message: `quantity ${src.quantity} != 31` });
      if (src.frame !== 'apparent-ecliptic-of-date') problems.push({ code: 'PROVENANCE_MISMATCH', path: `${sp}.frame`, message: `frame ${src.frame} != apparent-ecliptic-of-date` });
      if (src.timeScale !== got.timeScale) problems.push({ code: 'PROVENANCE_MISMATCH', path: `${sp}.timeScale`, message: `source scale ${src.timeScale} != case scale ${got.timeScale}` });
      if (typeof src.apiVersion !== 'string' || typeof src.ephemerisSource !== 'string') {
        problems.push({ code: 'PROVENANCE_MISMATCH', path: sp, message: 'apiVersion/ephemerisSource missing' });
      }
      // The recorded URL must carry the same contract parameters.
      let url = null;
      try { url = new URL(src.url); } catch { /* invalid */ }
      const qp = url?.searchParams;
      if (!url || url.hostname !== 'ssd.jpl.nasa.gov' || !url.pathname.endsWith('horizons.api')) {
        problems.push({ code: 'PROVENANCE_MISMATCH', path: `${sp}.url`, message: `unexpected Horizons url ${src.url}` });
      } else if (
        qp.get('COMMAND') !== "'10'" || qp.get('EPHEM_TYPE') !== 'OBSERVER' ||
        qp.get('CENTER') !== '500@399' || qp.get('QUANTITIES') !== '31' ||
        qp.get('TIME_TYPE') !== got.timeScale || qp.get('CAL_TYPE') !== 'GREGORIAN' ||
        qp.get('APPARENT') !== 'AIRLESS' || qp.get('CSV_FORMAT') !== 'YES'
      ) {
        problems.push({ code: 'PROVENANCE_MISMATCH', path: `${sp}.url`, message: 'URL parameters drifted from the OBSERVER quantity-31 contract' });
      }
      rawFiles.add(src.rawFile);
      const rawPath = join(fixtureDir, src.rawFile ?? '');
      if (!existsSync(rawPath)) {
        problems.push({ code: 'RAW_FILE_MISSING', path: src.rawFile, message: `raw file for ${src.id} missing` });
        continue;
      }
      const text = readFileSync(rawPath, 'utf8');
      if (sha256(text) !== src.sha256) {
        problems.push({ code: 'RAW_SHA256_MISMATCH', path: `${sp}.sha256`, message: `archived bytes do not match recorded sha256 for ${src.id}` });
        continue;
      }
      if (!horizonsMarkersOk(text, got.timeScale)) {
        problems.push({ code: 'RAW_BODY_INVALID', path: src.rawFile, message: `raw response for ${src.id} lacks required Horizons markers (${got.timeScale})` });
        continue;
      }
      const meta = horizonsHeaderMeta(text);
      if (meta.apiVersion !== src.apiVersion || meta.ephemerisSource !== src.ephemerisSource) {
        problems.push({ code: 'PROVENANCE_MISMATCH', path: sp, message: `recorded apiVersion/ephemerisSource ${src.apiVersion}/${src.ephemerisSource} != body ${meta.apiVersion}/${meta.ephemerisSource}` });
      }
      raws[src.id] = text;
    }
    if (!raws[hourly.id] || !raws[minute.id]) continue;
    // Re-derive the reference root from the archived minute rows alone.
    const minuteRows = parseHorizonsRows(raws[minute.id]);
    const hourRows = parseHorizonsRows(raws[hourly.id]);
    if (!minuteRows || !hourRows) {
      problems.push({ code: 'RAW_BODY_INVALID', path: cp, message: 'unparseable $$SOE rows' });
      continue;
    }
    const mi = findUniqueCrossing(minuteRows, got.angle);
    const hi = findUniqueCrossing(hourRows, got.angle);
    if (mi === null || hi === null) {
      problems.push({ code: 'ROOT_DERIVATION_MISMATCH', path: cp, message: 'no unique longitude crossing in archived rows' });
      continue;
    }
    const root = interpolateRoot(minuteRows[mi], minuteRows[mi + 1], got.angle);
    if (!root) {
      problems.push({ code: 'ROOT_DERIVATION_MISMATCH', path: cp, message: 'unparseable row timestamps' });
      continue;
    }
    const bracket = Math.round((root.jdB - root.jdA) * 86400 * 1000) / 1000;
    if (!(bracket > 0 && bracket <= MAX_BRACKET_SECONDS)) {
      problems.push({ code: 'ROOT_DERIVATION_MISMATCH', path: cp, message: `recomputed bracket ${bracket}s exceeds ${MAX_BRACKET_SECONDS}s` });
    }
    const drift = Math.abs(root.jd - got.expectedJulianDay) * 86400;
    if (drift > 0.01) {
      problems.push({ code: 'ROOT_DERIVATION_MISMATCH', path: `${cp}.expectedJulianDay`, message: `re-derived root drifts ${drift.toFixed(4)}s from expectedJulianDay` });
    }
    const hA = horizonsRowJd(hourRows[hi]);
    const hB = horizonsRowJd(hourRows[hi + 1]);
    if (!(root.jdA >= hA - 1e-9 && root.jdB <= hB + 1e-9)) {
      problems.push({ code: 'ROOT_DERIVATION_MISMATCH', path: cp, message: 'minute bracket outside archived hourly bracket' });
    }
  }
  for (const kase of doc.cases) {
    if (!seen.has(kase.id)) problems.push({ code: 'CASE_FIELD_MISMATCH', path: `${P}.cases[${kase.id}]`, message: 'undeclared extra case' });
  }
  if (doc.cases.length !== EXPECTED_SOLAR_CASES.length) {
    problems.push({ code: 'CASE_FIELD_MISMATCH', path: `${P}.cases`, message: `expected ${EXPECTED_SOLAR_CASES.length} cases, got ${doc.cases.length}` });
  }
}

function checkRules(doc, problems) {
  const P = 'rules.json';
  if (doc.schemaVersion !== 1) problems.push({ code: 'SCHEMA_MISMATCH', path: `${P}.schemaVersion`, message: 'schemaVersion must be 1' });
  if (doc.evidenceClass !== 'policy') problems.push({ code: 'SCHEMA_MISMATCH', path: `${P}.evidenceClass`, message: 'rules must be labelled evidenceClass policy' });
  if (doc.source?.rulesetId !== 'kr-civil-midnight-v1') problems.push({ code: 'SCHEMA_MISMATCH', path: `${P}.source.rulesetId`, message: 'rulesetId must be kr-civil-midnight-v1' });
  const t = doc.tables ?? {};
  const expectPairs = (actual, expected, path) => {
    const norm = (pairs) => (pairs ?? []).map((p) => [...p].sort().join('')).sort();
    if (JSON.stringify(norm(actual)) !== JSON.stringify(norm(expected))) {
      problems.push({ code: 'SCHEMA_MISMATCH', path, message: `table drifted: ${JSON.stringify(actual)}` });
    }
  };
  if (t.dayCycleAnchor?.solarDate !== DAY_CYCLE_ANCHOR.solarDate || t.dayCycleAnchor?.dayGanZhi !== DAY_CYCLE_ANCHOR.ganZhi) {
    problems.push({ code: 'SCHEMA_MISMATCH', path: `${P}.tables.dayCycleAnchor`, message: 'day-cycle anchor must be 2000-01-07 甲子' });
  }
  const jie = t.periodBoundaries?.monthJieLongitudesDeg;
  if (JSON.stringify(jie) !== JSON.stringify([315, 345, 15, 45, 75, 105, 135, 165, 195, 225, 255, 285])) {
    problems.push({ code: 'SCHEMA_MISMATCH', path: `${P}.tables.periodBoundaries.monthJieLongitudesDeg`, message: 'jie longitude table drifted' });
  }
  const hidden = t.hiddenStems?.rankOrder ?? {};
  const expectedHidden = {
    子: ['癸'], 丑: ['己', '癸', '辛'], 寅: ['甲', '丙', '戊'], 卯: ['乙'],
    辰: ['戊', '乙', '癸'], 巳: ['丙', '戊', '庚'], 午: ['丁', '己'],
    未: ['己', '丁', '乙'], 申: ['庚', '壬', '戊'], 酉: ['辛'],
    戌: ['戊', '辛', '丁'], 亥: ['壬', '甲'],
  };
  if (JSON.stringify(hidden) !== JSON.stringify(expectedHidden)) {
    problems.push({ code: 'SCHEMA_MISMATCH', path: `${P}.tables.hiddenStems.rankOrder`, message: 'hidden-stem rank order drifted' });
  }
  if (t.hiddenStems?.weightsId !== 'hidden-602020-7030-v1') {
    problems.push({ code: 'SCHEMA_MISMATCH', path: `${P}.tables.hiddenStems.weightsId`, message: 'weights id drifted' });
  }
  const stages = t.twelveStages ?? {};
  if (JSON.stringify(stages.order) !== JSON.stringify(['長生', '沐浴', '冠帶', '建祿', '帝旺', '衰', '病', '死', '墓', '絕', '胎', '養'])) {
    problems.push({ code: 'SCHEMA_MISMATCH', path: `${P}.tables.twelveStages.order`, message: 'stage order drifted' });
  }
  const expectedStarts = { 甲: ['亥', '+'], 乙: ['午', '-'], 丙: ['寅', '+'], 戊: ['寅', '+'], 丁: ['酉', '-'], 己: ['酉', '-'], 庚: ['巳', '+'], 辛: ['子', '-'], 壬: ['申', '+'], 癸: ['卯', '-'] };
  for (const [stem, [start, dir]] of Object.entries(expectedStarts)) {
    const got = stages.startsAndDirections?.[stem];
    if (got?.start !== start || got?.direction !== dir) {
      problems.push({ code: 'SCHEMA_MISMATCH', path: `${P}.tables.twelveStages.startsAndDirections.${stem}`, message: `expected ${start}${dir}` });
    }
  }
  const combos = (t.stemCombinations ?? []).map((c) => ({ k: [...(c.pair ?? [])].sort().join(''), e: c.element }));
  const expectedCombos = [[['甲', '己'], '土'], [['乙', '庚'], '金'], [['丙', '辛'], '水'], [['丁', '壬'], '木'], [['戊', '癸'], '火']];
  for (const [pair, e] of expectedCombos) {
    const k = [...pair].sort().join('');
    if (!combos.some((c) => c.k === k && c.e === e)) {
      problems.push({ code: 'SCHEMA_MISMATCH', path: `${P}.tables.stemCombinations`, message: `missing ${pair.join('')}->${e}` });
    }
  }
  expectPairs(t.stemClashes, [['甲', '庚'], ['乙', '辛'], ['丙', '壬'], ['丁', '癸']], `${P}.tables.stemClashes`);
  expectPairs(t.branchClashes, [['子', '午'], ['丑', '未'], ['寅', '申'], ['卯', '酉'], ['辰', '戌'], ['巳', '亥']], `${P}.tables.branchClashes`);
  expectPairs(t.branchBreaks, [['子', '酉'], ['卯', '午'], ['辰', '丑'], ['戌', '未'], ['寅', '亥'], ['巳', '申']], `${P}.tables.branchBreaks`);
  expectPairs(t.branchHarms, [['子', '未'], ['丑', '午'], ['寅', '巳'], ['卯', '辰'], ['申', '亥'], ['酉', '戌']], `${P}.tables.branchHarms`);
  expectPairs(t.wonjin, [['子', '未'], ['丑', '午'], ['寅', '酉'], ['卯', '申'], ['辰', '亥'], ['巳', '戌']], `${P}.tables.wonjin`);
  expectPairs(t.gwimun, [['子', '酉'], ['丑', '午'], ['寅', '未'], ['卯', '申'], ['辰', '亥'], ['巳', '戌']], `${P}.tables.gwimun`);
  const liuhe = t.branchCombinations?.liuhe ?? [];
  const expectedLiuhe = [[['子', '丑'], '土'], [['寅', '亥'], '木'], [['卯', '戌'], '火'], [['辰', '酉'], '金'], [['巳', '申'], '水'], [['午', '未'], '土']];
  for (const [pair, e] of expectedLiuhe) {
    const k = [...pair].sort().join('');
    if (!liuhe.some((c) => [...(c.pair ?? [])].sort().join('') === k && c.element === e)) {
      problems.push({ code: 'SCHEMA_MISMATCH', path: `${P}.tables.branchCombinations.liuhe`, message: `missing ${pair.join('')}->${e}` });
    }
  }
  const sanhe = (t.branchCombinations?.sanhe ?? []).map((c) => [...(c.triple ?? [])].sort().join('') + c.element);
  for (const want of ['申子辰水', '亥卯未木', '寅午戌火', '巳酉丑金'].map((s) => [...s.slice(0, 3)].sort().join('') + s[3])) {
    if (!sanhe.includes(want)) problems.push({ code: 'SCHEMA_MISMATCH', path: `${P}.tables.branchCombinations.sanhe`, message: `missing ${want}` });
  }
  const pun = t.punishments ?? {};
  if (JSON.stringify(pun.directedCycles) !== JSON.stringify([['寅', '巳', '申'], ['丑', '戌', '未']])) {
    problems.push({ code: 'SCHEMA_MISMATCH', path: `${P}.tables.punishments.directedCycles`, message: 'directed punishment cycles drifted' });
  }
  expectPairs(pun.undirected, [['子', '卯']], `${P}.tables.punishments.undirected`);
  if (JSON.stringify(pun.selfPunishmentBranches) !== JSON.stringify(['辰', '午', '酉', '亥'])) {
    problems.push({ code: 'SCHEMA_MISMATCH', path: `${P}.tables.punishments.selfPunishmentBranches`, message: 'self-punishment branches drifted' });
  }
  const gm = t.gongmangByDayXun ?? {};
  const expectedGm = { 甲子: '戌亥', 甲戌: '申酉', 甲申: '午未', 甲午: '辰巳', 甲辰: '寅卯', 甲寅: '子丑' };
  for (const [xun, voids] of Object.entries(expectedGm)) {
    if ((gm[xun] ?? []).join('') !== voids) {
      problems.push({ code: 'SCHEMA_MISMATCH', path: `${P}.tables.gongmangByDayXun.${xun}`, message: `expected ${voids}` });
    }
  }
  if (t.majorCycles?.nominalYearSeconds !== 259200 || t.majorCycles?.startConventionId !== 'three-days-calendar-v1') {
    problems.push({ code: 'SCHEMA_MISMATCH', path: `${P}.tables.majorCycles`, message: 'major-cycle convention drifted' });
  }
  if (t.counts?.totalUnitsComplete !== 8 || t.counts?.totalUnitsWithoutHour !== 6) {
    problems.push({ code: 'SCHEMA_MISMATCH', path: `${P}.tables.counts`, message: 'unit totals drifted' });
  }
  if (t.age?.system !== 'completed-solar-years' || t.age?.anniversaryPolicy !== 'month-day-march1-for-feb29') {
    problems.push({ code: 'SCHEMA_MISMATCH', path: `${P}.tables.age`, message: 'age convention drifted' });
  }
}

function checkRequestShape(req, expect, name, problems) {
  const P = `requests/${name}`;
  if (req.schemaVersion !== 1) problems.push({ code: 'REQUEST_INVALID', path: `${P}.schemaVersion`, message: 'schemaVersion must be 1' });
  const b = req.birth ?? {};
  const allowedBirth = new Set(['calendar', 'date', 'leapMonth', 'time', 'timezone', 'utcOffset', 'gender']);
  for (const key of Object.keys(b)) {
    if (!allowedBirth.has(key)) problems.push({ code: 'REQUEST_INVALID', path: `${P}.birth.${key}`, message: 'unknown birth field' });
  }
  if (b.calendar === 'solar') {
    if ('leapMonth' in b) problems.push({ code: 'REQUEST_INVALID', path: `${P}.birth.leapMonth`, message: 'solar forbids leapMonth' });
  } else if (b.calendar === 'korean_lunar') {
    if (typeof b.leapMonth !== 'boolean') problems.push({ code: 'REQUEST_INVALID', path: `${P}.birth.leapMonth`, message: 'korean_lunar requires boolean leapMonth' });
  } else {
    problems.push({ code: 'REQUEST_INVALID', path: `${P}.birth.calendar`, message: `calendar ${b.calendar} invalid` });
  }
  if (typeof b.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) {
    problems.push({ code: 'REQUEST_INVALID', path: `${P}.birth.date`, message: `date ${b.date} malformed` });
  }
  if (!(b.time === null || (typeof b.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(b.time)))) {
    problems.push({ code: 'REQUEST_INVALID', path: `${P}.birth.time`, message: `time ${b.time} must be HH:mm:ss or null` });
  }
  if (typeof b.timezone !== 'string' || !isValidTimeZone(b.timezone)) {
    problems.push({ code: 'REQUEST_INVALID', path: `${P}.birth.timezone`, message: `timezone ${b.timezone} not a valid IANA zone` });
  }
  if ('utcOffset' in b && !(typeof b.utcOffset === 'string' && /^[+-]\d{2}:\d{2}(:\d{2})?$/.test(b.utcOffset))) {
    problems.push({ code: 'REQUEST_INVALID', path: `${P}.birth.utcOffset`, message: `utcOffset ${b.utcOffset} malformed` });
  }
  if ('gender' in b && !['male', 'female'].includes(b.gender)) {
    problems.push({ code: 'REQUEST_INVALID', path: `${P}.birth.gender`, message: `gender ${b.gender} invalid` });
  }
  const q = req.queries ?? {};
  for (const key of Object.keys(q)) {
    if (!['majorCycles', 'transits'].includes(key)) problems.push({ code: 'REQUEST_INVALID', path: `${P}.queries.${key}`, message: 'unknown queries field' });
  }
  if ('majorCycles' in q && !(Number.isInteger(q.majorCycles) && q.majorCycles >= 0 && q.majorCycles <= 12)) {
    problems.push({ code: 'REQUEST_INVALID', path: `${P}.queries.majorCycles`, message: `majorCycles ${q.majorCycles} outside 0..12` });
  }
  if ('transits' in q) {
    if (!Array.isArray(q.transits) || q.transits.length > 366) {
      problems.push({ code: 'REQUEST_INVALID', path: `${P}.queries.transits`, message: 'transits must be an array of <=366 instants' });
    } else {
      for (const [i, t] of q.transits.entries()) {
        if (typeof t !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/.test(t) || Number.isNaN(Date.parse(t))) {
          problems.push({ code: 'REQUEST_INVALID', path: `${P}.queries.transits[${i}]`, message: `transit ${t} is not an RFC3339 instant` });
        }
      }
    }
  }
  // The declared expectation must be well-formed and genuinely match the request.
  const ep = `manifest.requests.${name}.expect`;
  if (!expect || typeof expect !== 'object') {
    problems.push({ code: 'EXPECT_INVALID', path: ep, message: 'expect block missing' });
    return;
  }
  if (expect.outcome === 'success') {
    if (expect.exit !== 0) problems.push({ code: 'EXPECT_INVALID', path: `${ep}.exit`, message: 'success must declare exit 0' });
    if (typeof b.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.date) && !isGregorianDate(b.date)) {
      problems.push({ code: 'EXPECT_INVALID', path: ep, message: `success declared but birth.date ${b.date} is not a Gregorian date` });
    }
    for (const lim of expect.limitations ?? []) {
      if (!KNOWN_LIMITATIONS.has(lim)) problems.push({ code: 'EXPECT_INVALID', path: `${ep}.limitations`, message: `unknown limitation ${lim}` });
    }
    if ('majorCyclesRequested' in expect && expect.majorCyclesRequested !== q.majorCycles) {
      problems.push({ code: 'EXPECT_INVALID', path: `${ep}.majorCyclesRequested`, message: 'does not match queries.majorCycles' });
    }
    if ('transitsRequested' in expect && expect.transitsRequested !== (q.transits ?? []).length) {
      problems.push({ code: 'EXPECT_INVALID', path: `${ep}.transitsRequested`, message: 'does not match queries.transits length' });
    }
  } else if (expect.outcome === 'input-error') {
    if (expect.exit !== 2) problems.push({ code: 'EXPECT_INVALID', path: `${ep}.exit`, message: 'input-error must declare exit 2' });
    // The request must genuinely violate the contract at the declared seam.
    if (expect.code === 'NONEXISTENT_LOCAL_TIME' || expect.code === 'AMBIGUOUS_LOCAL_TIME') {
      if (b.time === null || 'utcOffset' in b) {
        problems.push({ code: 'EXPECT_INVALID', path: ep, message: `${expect.code} requires a wall time without utcOffset` });
      } else if (isValidTimeZone(b.timezone) && isGregorianDate(b.date)) {
        const n = countLocalTimeCandidates(b.timezone, b.date, b.time);
        const want = expect.code === 'NONEXISTENT_LOCAL_TIME' ? 0 : 2;
        if (expect.code === 'NONEXISTENT_LOCAL_TIME' ? n !== 0 : n < 2) {
          problems.push({ code: 'EXPECT_INVALID', path: ep, message: `${b.date} ${b.time} in ${b.timezone} yields ${n} candidates, expected ${want === 0 ? '0' : '>=2'}` });
        }
      }
    } else if (expect.path === 'birth.date') {
      const invalid = !isGregorianDate(b.date);
      const outOfRange = isGregorianDate(b.date) && (b.date < SUPPORT_RANGE.min || b.date > SUPPORT_RANGE.max);
      if (!invalid && !outOfRange) {
        problems.push({ code: 'EXPECT_INVALID', path: ep, message: `birth.date ${b.date} is valid and in range; declared violation is false` });
      }
    }
  } else {
    problems.push({ code: 'EXPECT_INVALID', path: `${ep}.outcome`, message: `outcome ${expect.outcome} unknown` });
  }
}

function checkBaseline(repoRoot, fixtureDir, doc, manifestEntry, problems) {
  const P = 'astrology-baseline.json';
  const pinned = manifestEntry?.pinnedScriptSha256;
  if (doc.source?.script !== manifestEntry?.pinnedScript) {
    problems.push({ code: 'BASELINE_MISMATCH', path: `${P}.source.script`, message: 'pinned script path drifted' });
  }
  if (doc.source?.sha256 !== pinned) {
    problems.push({ code: 'BASELINE_MISMATCH', path: `${P}.source.sha256`, message: 'baseline sha256 does not match manifest pin' });
  }
  const scriptPath = join(repoRoot, manifestEntry?.pinnedScript ?? 'skills/saju/scripts/natal.mjs');
  if (!existsSync(scriptPath)) {
    problems.push({ code: 'BASELINE_MISMATCH', path: P, message: `pinned script ${manifestEntry?.pinnedScript} missing` });
  } else if (sha256(readFileSync(scriptPath, 'utf8')) !== pinned) {
    problems.push({ code: 'BASELINE_MISMATCH', path: P, message: 'natal.mjs bytes no longer match the pinned baseline sha256' });
  }
  for (const section of ['natal', 'synastry']) {
    const s = doc[section];
    if (!s || typeof s.input !== 'object' || typeof s.expected !== 'object' || s.input === null || s.expected === null) {
      problems.push({ code: 'BASELINE_MISMATCH', path: `${P}.${section}`, message: 'input/expected objects missing' });
    }
  }
  const natal = doc.natal?.expected;
  if (natal) {
    if (typeof natal.utcDate !== 'string' || !Array.isArray(natal.planets) || !Array.isArray(natal.aspects) || !Array.isArray(natal.houses)) {
      problems.push({ code: 'BASELINE_MISMATCH', path: `${P}.natal.expected`, message: 'expected natal fields incomplete' });
    }
  }
  const syn = doc.synastry?.expected;
  if (syn && typeof syn.score !== 'number') {
    problems.push({ code: 'BASELINE_MISMATCH', path: `${P}.synastry.expected.score`, message: 'synastry score missing' });
  }
}

// --- entry point --------------------------------------------------------------

export function validateFixtureTree({ fixtureDir, repoRoot }) {
  const problems = [];
  const manifestPath = join(fixtureDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return [{ code: 'MANIFEST_MISSING', path: 'manifest.json', message: 'fixture manifest missing' }];
  }
  const manifestRead = readJson(manifestPath);
  if (!manifestRead.ok) {
    return [{ code: 'MANIFEST_INVALID', path: 'manifest.json', message: `unparseable: ${manifestRead.error.message}` }];
  }
  const manifest = manifestRead.value;
  if (manifest.schemaVersion !== 1) {
    problems.push({ code: 'MANIFEST_INVALID', path: 'manifest.json.schemaVersion', message: 'schemaVersion must be 1' });
  }
  const fx = manifest.fixtures ?? {};

  // Declared fixture files must exist and match their pinned sha256.
  const declared = new Set(['manifest.json']);
  const pinnedFiles = [];
  for (const key of ['calendar', 'solarTerms', 'rules', 'astrologyBaseline']) {
    if (fx[key]?.file) pinnedFiles.push([key, fx[key]]);
  }
  for (const [name, entry] of Object.entries(fx.requests ?? {})) {
    pinnedFiles.push([`requests.${name}`, entry]);
  }
  for (const [key, entry] of pinnedFiles) {
    if (typeof entry.file !== 'string' || typeof entry.sha256 !== 'string') {
      problems.push({ code: 'MANIFEST_INVALID', path: `manifest.fixtures.${key}`, message: 'file/sha256 missing' });
      continue;
    }
    declared.add(entry.file);
    const full = join(fixtureDir, entry.file);
    if (!existsSync(full)) {
      problems.push({ code: 'FILE_MISSING', path: entry.file, message: `declared fixture file for ${key} missing` });
      continue;
    }
    if (sha256(readFileSync(full, 'utf8')) !== entry.sha256) {
      problems.push({ code: 'FILE_SHA256_MISMATCH', path: entry.file, message: `bytes do not match manifest sha256 for ${key}` });
    }
  }

  const rawFiles = new Set();
  const load = (entry, key, fn) => {
    if (!entry?.file) return;
    const full = join(fixtureDir, entry.file);
    if (!existsSync(full)) return;
    const read = readJson(full);
    if (!read.ok) {
      problems.push({ code: 'JSON_INVALID', path: entry.file, message: `unparseable: ${read.error.message}` });
      return;
    }
    fn(read.value);
  };

  load(fx.calendar, 'calendar', (doc) => checkCalendar(fixtureDir, doc, problems, rawFiles));
  load(fx.solarTerms, 'solarTerms', (doc) => checkSolarTerms(fixtureDir, doc, problems, rawFiles));
  load(fx.rules, 'rules', (doc) => checkRules(doc, problems));
  load(fx.astrologyBaseline, 'astrologyBaseline', (doc) => checkBaseline(repoRoot, fixtureDir, doc, fx.astrologyBaseline, problems));
  for (const [name, entry] of Object.entries(fx.requests ?? {})) {
    load(entry, `requests.${name}`, (doc) => checkRequestShape(doc, entry.expect, name, problems));
  }

  // Tree completeness: no undeclared fixture file, no orphaned raw capture.
  for (const rel of listFiles(fixtureDir)) {
    if (rel.startsWith('raw/')) {
      if (!rawFiles.has(rel)) problems.push({ code: 'UNREFERENCED_RAW', path: rel, message: 'raw capture not referenced by any source' });
    } else if (!declared.has(rel)) {
      problems.push({ code: 'UNDECLARED_FILE', path: rel, message: 'fixture file not declared in manifest' });
    }
  }
  return problems;
}
