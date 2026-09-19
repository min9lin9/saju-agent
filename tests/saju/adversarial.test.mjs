// adversarial.test.mjs — adversarial and adjacent-surface regressions for the
// deterministic saju kernel.
//
// Oracles, in order of authority:
//   tests/fixtures/saju/calendar.json      KASI solc solar<->lunar anchors
//   tests/fixtures/saju/solar-terms.json   JPL Horizons Ipchun-2024 root (UT)
//   tests/fixtures/saju/astrology-baseline.json  golden output of the legacy
//                                        skills/saju/scripts/natal.mjs
//   hand-derived values below              computed from the stipulated
//                                          kr-civil-midnight-v1 rules (day
//                                          cycle epoch 2000-01-07 = 甲子,
//                                          Ipchun/jie boundaries, three-days
//                                          calendar), never from the runtime
//                                          under test
//   injected jie facts                     stub calendars return fixed term
//                                          instants so boundary distances are
//                                          computed by hand
//
// Coverage: day-cycle/major-cycle epoch boundaries, the +/-120 s solar-term
// uncertainty band, Korean-vs-Chinese lunar divergence, DST folds/gaps,
// stale-converter/provenance surfacing, unknown-birth-time candidates,
// rule-table duplicate/malformed rejection, the 2050 lunar-metadata cutoff,
// transit range endpoints and RFC3339 offset enforcement, CLI exit-2 typed
// errors for malformed/oversized/injection-shaped input, host-TZ
// independence, and the same-pin astrology baseline.
//
// Determinism: no sleeps, no polling, no ambient clock; every spawned
// process is a bounded spawnSync wait and every temp file is removed in
// try/finally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { calculate } from '../../skills/saju/scripts/saju/calculate.mjs';
import {
  CalendarError,
  LUNAR_METADATA_LIMITATION,
  LUNAR_METADATA_MAX_SOLAR,
  SOLAR_TERM_UNCERTAINTY_SECONDS,
  findSolarTerm,
  lunarToSolar,
  solarToLunar,
} from '../../skills/saju/scripts/saju/calendar.mjs';
import {
  dayCycleIndex,
  deriveNatal,
  gregorianDayNumber,
} from '../../skills/saju/scripts/saju/natal.mjs';
import {
  computeMajorCycles,
  decomposeNominalAge,
} from '../../skills/saju/scripts/saju/major-cycles.mjs';
import { computeTransits } from '../../skills/saju/scripts/saju/transits.mjs';
import { detectRelations } from '../../skills/saju/scripts/saju/relations.mjs';
import { canonicalStringify } from '../../skills/saju/scripts/saju/serialize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const CLI = join(repoRoot, 'skills', 'saju', 'scripts', 'saju.mjs');
const LEGACY = join(repoRoot, 'skills', 'saju', 'scripts', 'natal.mjs');
const REQUESTS = join(repoRoot, 'tests', 'fixtures', 'saju', 'requests');
const fixtureJson = (name) =>
  JSON.parse(readFileSync(join(repoRoot, 'tests', 'fixtures', 'saju', name), 'utf8'));
const requestFixture = (name) =>
  JSON.parse(readFileSync(join(REQUESTS, `${name}.json`), 'utf8'));

const solarTermsFixture = fixtureJson('solar-terms.json');
const calendarFixture = fixtureJson('calendar.json');
const baseline = fixtureJson('astrology-baseline.json');

const ms = (iso) => Date.parse(iso);
const DAY = 86400 * 1000;
const JD_UNIX_EPOCH = 2440587.5;

// Independent Horizons oracle for the real 2024 Ipchun instant (UT scale).
const IPCHUN_2024 = solarTermsFixture.cases.find((c) => c.id === 'ut-2024-ipchun');

// --- CLI helpers ---------------------------------------------------------------

const runCli = (args, env) => spawnSync(process.execPath, [CLI, ...args], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  timeout: 60000,
  env: env === undefined ? process.env : { ...process.env, ...env },
});

// Writes one request (object or raw text) to a fresh temp dir, runs fn on the
// file path, and always removes the dir. Returns fn's result.
const withRequestFile = (content, fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'saju-adv-'));
  try {
    const file = join(dir, 'request.json');
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return fn(file, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const runRequest = (content, env) =>
  withRequestFile(content, (file) => runCli(['--input', file], env));

// Parses a successful run: exit 0, non-empty stdout that is one JSON object.
const okResult = (proc) => {
  assert.equal(proc.error, undefined, `spawn error: ${proc.error}`);
  assert.equal(proc.status, 0, `exit ${proc.status}; stderr: ${proc.stderr}`);
  assert.ok(proc.stdout.length > 0, 'stdout must not be empty on success');
  return JSON.parse(proc.stdout);
};

// Parses a rejected run: exit 2, empty stdout, stderr JSON {error:{code,...}}.
const errResult = (proc) => {
  assert.equal(proc.error, undefined, `spawn error: ${proc.error}`);
  assert.equal(proc.status, 2, `exit ${proc.status}; stdout: ${proc.stdout}`);
  assert.equal(proc.stdout, '', 'stdout must be empty on rejection');
  const parsed = JSON.parse(proc.stderr);
  assert.equal(typeof parsed.error, 'object');
  assert.equal(typeof parsed.error.code, 'string');
  assert.ok('path' in parsed.error);
  assert.equal(typeof parsed.error.message, 'string');
  return parsed.error;
};

const solarRequest = (birth, queries = { majorCycles: 0, transits: [] }) => ({
  schemaVersion: 1,
  birth: { calendar: 'solar', ...birth },
  queries,
});

const pillarGZ = (cand, key) => (cand.pillars[key] === null ? null : cand.pillars[key].ganZhi);
const limitationCodes = (result) => result.limitations.map((l) => l.code);

// A calendar stub keyed by 'YYYY-MM' returning injected term facts.
const stubCalendar = (terms) => ({
  findSolarTerm({ year, month }) {
    const t = terms[`${year}-${String(month).padStart(2, '0')}`];
    if (!t) {
      throw new CalendarError(
        'SOLAR_TERM_SEARCH_FAILED', 'birth.date', `stub has no term for ${year}-${month}`,
      );
    }
    return {
      eventId: `${year}-${t.termId}`,
      termId: t.termId,
      iso: new Date(t.ms).toISOString(),
      instantMs: t.ms,
      uncertaintySeconds: 120,
    };
  },
});

// --- epoch increments ------------------------------------------------------------

test('day-cycle epoch: index wraps mod 60 across day, month, year and century bounds', () => {
  // Stipulated epoch: 2000-01-07 = 甲子 (index 0). Hand-derived neighbors:
  // index = (gdn(date) - gdn(2000-01-07)) mod 60.
  assert.equal(dayCycleIndex({ year: 2000, month: 1, day: 7 }), 0); // 甲子 epoch
  assert.equal(dayCycleIndex({ year: 2000, month: 1, day: 6 }), 59); // 癸亥, one day before
  assert.equal(dayCycleIndex({ year: 2000, month: 1, day: 8 }), 1); // 乙丑
  assert.equal(dayCycleIndex({ year: 2000, month: 3, day: 6 }), 59); // 60-day wrap
  assert.equal(dayCycleIndex({ year: 2000, month: 3, day: 7 }), 0); // second epoch turn
  assert.equal(dayCycleIndex({ year: 1999, month: 12, day: 31 }), 53); // 丁巳, negative direction
  // Integer proleptic-Gregorian day numbers: +1 across every boundary,
  // including the 1900 non-leap century and the 2000 leap century.
  assert.equal(gregorianDayNumber(2000, 1, 8) - gregorianDayNumber(2000, 1, 7), 1);
  assert.equal(gregorianDayNumber(1900, 3, 1) - gregorianDayNumber(1900, 2, 28), 1);
  assert.equal(gregorianDayNumber(2000, 3, 1) - gregorianDayNumber(2000, 2, 29), 1);
  assert.equal(gregorianDayNumber(2001, 1, 1) - gregorianDayNumber(2000, 12, 31), 1);
});

test('day pillar rolls at civil midnight; hour branch rolls at 23:00 on the same day', () => {
  const at = (day, time) => deriveNatal({
    date: { year: 1998, month: 10, day },
    time,
    timezone: 'Asia/Seoul',
  }).candidates[0];
  // 23:59:59 -> 00:00:00 flips the day pillar (丁未 -> 戊申, KASI-anchored 丁未).
  assert.equal(pillarGZ(at(27, { hour: 23, minute: 59, second: 59 }), 'day'), '丁未');
  assert.equal(pillarGZ(at(28, { hour: 0, minute: 0, second: 0 }), 'day'), '戊申');
  // 22:59:59 -> 23:00:00 flips the hour branch (亥 -> 子) on the SAME day stem:
  // 丁 day -> 辛亥 then 庚子.
  assert.equal(pillarGZ(at(27, { hour: 22, minute: 59, second: 59 }), 'hour'), '辛亥');
  assert.equal(pillarGZ(at(27, { hour: 23, minute: 0, second: 0 }), 'hour'), '庚子');
  assert.equal(pillarGZ(at(27, { hour: 23, minute: 0, second: 0 }), 'day'), '丁未');
});

test('major-cycle epoch: the inclusive adjacent jie switches exactly at the term instant', () => {
  // Injected jie facts: birth instant is stepped 1 ms across the March jie.
  // Forward direction (甲辰 yang year + male): t <= T0 measures distance to
  // the CURRENT jie, t > T0 to the NEXT — a ~25-day discontinuity on a 1 ms
  // step. Exact equality is distance zero, never clamped or rounded.
  const T0 = ms('2024-03-10T12:00:00.000Z');
  const terms = {
    '2024-02': { termId: 'ipchun', ms: ms('2024-02-04T12:00:00Z') },
    '2024-03': { termId: 'gyeongchip', ms: T0 },
    '2024-04': { termId: 'cheongmyeong', ms: ms('2024-04-04T12:00:00Z') },
  };
  const cyclesAt = (offsetMs) => {
    const natal = deriveNatal({
      date: { year: 2024, month: 3, day: 10 },
      time: { hour: 12, minute: 0, second: 0 },
      timezone: 'UTC',
      calendar: stubCalendar(terms),
      resolveTime: () => ({ instantMs: T0 + offsetMs }),
    });
    return computeMajorCycles({
      birth: { date: { year: 2024, month: 3, day: 10 }, timezone: 'UTC', gender: 'male' },
      natal,
      count: 1,
      calendar: stubCalendar(terms),
    });
  };
  const before = cyclesAt(-1);
  assert.equal(before.candidates[0].ranges[0].adjacentJie.role, 'current');
  assert.equal(before.candidates[0].ranges[0].distance.minMs, 1);
  const exact = cyclesAt(0);
  assert.equal(exact.candidates[0].ranges[0].adjacentJie.role, 'current');
  assert.equal(exact.candidates[0].ranges[0].distance.minMs, 0);
  assert.equal(exact.candidates[0].ranges[0].start.earliest.instantMs, T0);
  const after = cyclesAt(1);
  assert.equal(after.candidates[0].ranges[0].adjacentJie.role, 'next');
  assert.equal(after.candidates[0].ranges[0].adjacentJie.termId, 'cheongmyeong');
  assert.equal(after.candidates[0].ranges[0].distance.minMs, ms('2024-04-04T12:00:00Z') - T0 - 1);
  // Nominal-age decomposition boundary: 259200 s = exactly one nominal year;
  // 1 ms below decomposes to 0y 11m 29d 86399.88s, never rounded up.
  assert.deepEqual(
    decomposeNominalAge(259200 * 1000 - 1),
    { years: 0, months: 11, days: 29, seconds: 86399.88 },
  );
  assert.deepEqual(
    decomposeNominalAge(259200 * 1000),
    { years: 1, months: 0, days: 0, seconds: 0 },
  );
});

// --- solar-term uncertainty band ---------------------------------------------------

test('jie ±120 s band: real Ipchun 2024 splits birth candidates inside the band only', () => {
  assert.equal(SOLAR_TERM_UNCERTAINTY_SECONDS, 120);
  // The engine's instant must agree with the independent Horizons oracle
  // within the fixture's declared 120 s tolerance (UT scale).
  const engine = findSolarTerm({ year: 2024, month: 2 });
  const oracleDeltaSeconds = Math.abs(engine.julianDayUT - IPCHUN_2024.expectedJulianDay) * 86400;
  assert.ok(
    oracleDeltaSeconds <= IPCHUN_2024.toleranceSeconds,
    `engine Ipchun ${oracleDeltaSeconds}s from Horizons oracle`,
  );
  // Ipchun 2024 = 08:26:49.630Z = 17:26:49.630 Asia/Seoul. Birth times are
  // whole seconds, so the nearest probes sit 370/630 ms clear of the edges:
  //   17:24:49 = T0-120.630s outside | 17:24:50 = T0-119.630s inside
  //   17:28:49 = T0+119.370s inside | 17:28:50 = T0+120.370s outside
  const run = (time) => okResult(runRequest(solarRequest({
    date: '2024-02-04', time, timezone: 'Asia/Seoul', utcOffset: '+09:00', gender: 'male',
  })));
  const outsideLo = run('17:24:49');
  assert.equal(outsideLo.natal.candidates.length, 1);
  assert.equal(outsideLo.natal.candidates[0].side, 'before');
  assert.ok(!limitationCodes(outsideLo).includes('SOLAR_TERM_UNCERTAINTY'));

  for (const time of ['17:24:50', '17:26:49', '17:28:49']) {
    const r = run(time);
    assert.equal(r.natal.candidates.length, 2, time);
    assert.deepEqual(r.natal.candidates.map((c) => c.side), ['before', 'after']);
    assert.equal(r.natal.candidates[0].uncertain, true);
    // The band splits year AND month pillars at Ipchun; day/hour are stable.
    assert.deepEqual(
      [pillarGZ(r.natal.candidates[0], 'year'), pillarGZ(r.natal.candidates[0], 'month')],
      ['癸卯', '乙丑'],
    );
    assert.deepEqual(
      [pillarGZ(r.natal.candidates[1], 'year'), pillarGZ(r.natal.candidates[1], 'month')],
      ['甲辰', '丙寅'],
    );
    assert.equal(pillarGZ(r.natal.candidates[0], 'day'), '戊戌');
    assert.equal(pillarGZ(r.natal.candidates[1], 'day'), '戊戌');
    const lim = r.limitations.find((l) => l.code === 'SOLAR_TERM_UNCERTAINTY');
    assert.ok(lim, `SOLAR_TERM_UNCERTAINTY missing at ${time}`);
    assert.equal(lim.path, 'birth.time');
    assert.equal(lim.details.eventId, '2024-ipchun');
    assert.equal(lim.details.uncertaintySeconds, 120);
    assert.equal(r.natal.coverageComplete, false);
  }

  const outsideHi = run('17:28:50');
  assert.equal(outsideHi.natal.candidates.length, 1);
  assert.equal(outsideHi.natal.candidates[0].side, 'after');
  assert.ok(!limitationCodes(outsideHi).includes('SOLAR_TERM_UNCERTAINTY'));
});

test('jie ±120 s band: transit instants at the exact band edges split pillar sets', () => {
  // RFC3339 targets carry millisecond precision, so the exact inclusive edges
  // T0-120000 and T0+120000 are reachable; ±121000 ms is outside.
  const T0 = findSolarTerm({ year: 2024, month: 2 }).instantMs;
  const target = (offsetMs) => new Date(T0 + offsetMs).toISOString();
  const r = computeTransits({
    birth: { date: { year: 1998, month: 10, day: 27 }, timezone: 'Asia/Seoul' },
    targets: [target(-121000), target(-120000), target(0), target(120000), target(121000)],
  });
  const [before, edgeLo, exact, edgeHi, after] = r.transits;
  assert.equal(before.pillarCandidates.length, 1);
  assert.equal(before.pillarCandidates[0].side, 'before');
  assert.equal(after.pillarCandidates.length, 1);
  assert.equal(after.pillarCandidates[0].side, 'after');
  for (const t of [edgeLo, exact, edgeHi]) {
    assert.equal(t.pillarCandidates.length, 2);
    assert.deepEqual(t.pillarCandidates.map((c) => c.side), ['before', 'after']);
    assert.equal(t.pillarCandidates[0].uncertain, true);
    // Annual/monthly flip at Ipchun; the daily pillar is identical on both sides.
    assert.equal(t.pillarCandidates[0].pillars.annual.ganZhi, '癸卯');
    assert.equal(t.pillarCandidates[0].pillars.monthly.ganZhi, '乙丑');
    assert.equal(t.pillarCandidates[1].pillars.annual.ganZhi, '甲辰');
    assert.equal(t.pillarCandidates[1].pillars.monthly.ganZhi, '丙寅');
    assert.equal(t.pillarCandidates[0].pillars.daily.ganZhi, '戊戌');
    assert.equal(t.pillarCandidates[1].pillars.daily.ganZhi, '戊戌');
  }
  assert.deepEqual(
    r.limitations.map((l) => `${l.code}@${l.path}`),
    [
      'SOLAR_TERM_UNCERTAINTY@queries.transits[1]',
      'SOLAR_TERM_UNCERTAINTY@queries.transits[2]',
      'SOLAR_TERM_UNCERTAINTY@queries.transits[3]',
    ],
  );
});

// --- Korean-vs-Chinese lunar divergence ----------------------------------------------

test('Korean lunar converter: the 2017 leap-month divergence proves the Korean table', () => {
  // Korea observed a leap FIFTH month in 2017 (KASI-anchored: leap 5/1 =
  // solar 2017-06-24); the Chinese calendar placed its leap month after the
  // SIXTH month. A Chinese-table converter would reject Korean leap-5 or map
  // it to a different solar date, and would accept leap-6.
  const kasi = calendarFixture.cases.find((c) => c.id === 'kasi-solc-2017-06-24');
  assert.deepEqual(kasi.lunar, { year: 2017, month: 5, day: 1, leapMonth: true });
  assert.deepEqual(
    lunarToSolar({ year: 2017, month: 5, day: 1, leapMonth: true }),
    kasi.solar,
  );
  assert.deepEqual(kasi.solar, { year: 2017, month: 6, day: 24 });
  // The Chinese-calendar leap month does not exist in the Korean table.
  assert.throws(
    () => lunarToSolar({ year: 2017, month: 6, day: 1, leapMonth: true }),
    (e) => e instanceof CalendarError && e.code === 'INVALID_LUNAR_DATE' && e.path === 'birth.date',
  );
  // Solar 2017-07-23 is Korean flat 6/1 — inside the Chinese leap month, so a
  // Chinese table cannot produce this metadata.
  assert.deepEqual(
    solarToLunar({ year: 2017, month: 7, day: 23 }),
    { year: 2017, month: 6, day: 1, leapMonth: false },
  );
  // End to end: the CLI result for the leap fixture converts to the Korean
  // solar date and names the converter in provenance.
  const result = okResult(runCli(['--input', join(REQUESTS, 'lunar-leap.json')]));
  assert.equal(result.calendar.solarDate, '2017-06-24');
  assert.deepEqual(result.calendar.lunar, { year: 2017, month: 5, day: 1, leapMonth: true });
  assert.equal(result.provenance.calendarConverter.id, 'korean-lunar-calendar');
  assert.equal(result.provenance.calendarConverter.version, '0.4.0');
});

// --- DST folds and gaps through the real CLI -----------------------------------------

test('DST fold: ambiguous wall time rejects without utcOffset, resolves with it', () => {
  // America/New_York 2024-11-03 01:30 occurs twice (-04:00 then -05:00).
  const err = errResult(runCli(['--input', join(REQUESTS, 'dst-fold.json')]));
  assert.equal(err.code, 'AMBIGUOUS_LOCAL_TIME');
  assert.equal(err.path, 'birth.time');

  const fold = (utcOffset) => solarRequest({
    date: '2024-11-03', time: '01:30:00', timezone: 'America/New_York', utcOffset, gender: 'male',
  });
  const dst = okResult(runRequest(fold('-04:00')));
  assert.equal(dst.calendar.resolvedInstant.iso, '2024-11-03T05:30:00.000Z');
  assert.equal(dst.calendar.resolvedInstant.utcOffset, '-04:00');
  assert.equal(dst.calendar.resolvedInstant.ambiguous, true);
  const std = okResult(runRequest(fold('-05:00')));
  assert.equal(std.calendar.resolvedInstant.iso, '2024-11-03T06:30:00.000Z');
  assert.equal(std.calendar.resolvedInstant.utcOffset, '-05:00');
  // The two disambiguations are different instants but the same civil date:
  // identical day pillars, different resolved instants.
  assert.equal(
    pillarGZ(dst.natal.candidates[0], 'day'),
    pillarGZ(std.natal.candidates[0], 'day'),
  );
  assert.notEqual(
    dst.calendar.resolvedInstant.instantMs,
    std.calendar.resolvedInstant.instantMs,
  );
  // An offset matching neither candidate is OFFSET_MISMATCH, not a silent pick.
  const bad = errResult(runRequest(fold('-06:00')));
  assert.equal(bad.code, 'OFFSET_MISMATCH');
  assert.equal(bad.path, 'birth.utcOffset');
});

test('DST gap: nonexistent wall time rejects and no utcOffset can rescue it', () => {
  const err = errResult(runCli(['--input', join(REQUESTS, 'dst-gap.json')]));
  assert.equal(err.code, 'NONEXISTENT_LOCAL_TIME');
  assert.equal(err.path, 'birth.time');
  const withOffset = errResult(runRequest(solarRequest({
    date: '2024-03-10', time: '02:30:00', timezone: 'America/New_York',
    utcOffset: '-05:00', gender: 'female',
  })));
  assert.equal(withOffset.code, 'NONEXISTENT_LOCAL_TIME');
  assert.equal(withOffset.path, 'birth.time');
});

test('historic Seoul DST: 1988 fold disambiguates by offset, 1961 gap rejects', () => {
  // tzdb Asia/Seoul: 1988-10-09 fell back +10:00 -> +09:00 (02:30 twice);
  // 1961-08-10 jumped +08:30 -> +09:00 (00:00-00:30 never existed).
  const fold = okResult(runRequest(solarRequest({
    date: '1988-10-09', time: '02:30:00', timezone: 'Asia/Seoul',
    utcOffset: '+10:00', gender: 'female',
  })));
  assert.equal(fold.calendar.resolvedInstant.iso, '1988-10-08T16:30:00.000Z');
  assert.equal(fold.calendar.resolvedInstant.utcOffset, '+10:00');
  assert.equal(fold.calendar.resolvedInstant.ambiguous, true);
  const gap = errResult(runRequest(solarRequest({
    date: '1961-08-10', time: '00:15:00', timezone: 'Asia/Seoul',
  })));
  assert.equal(gap.code, 'NONEXISTENT_LOCAL_TIME');
  assert.equal(gap.path, 'birth.time');
});

// --- stale converter rejection --------------------------------------------------------

test('stale converter rejection: provenance surfaces identity, versions and rule hashes', () => {
  // The seam the code exposes is provenance: a stale or substituted converter
  // install shows up as a declared/resolved version mismatch and a wrong
  // converter id — surfaced in the result, never silently accepted. Pin the
  // honest-lock state: resolved versions equal the lockfile, declared equal
  // package.json, and rule-table hashes equal the canonical hash of the
  // on-disk tables.
  const pkg = JSON.parse(
    readFileSync(join(repoRoot, 'skills', 'saju', 'scripts', 'package.json'), 'utf8'),
  );
  const lock = JSON.parse(
    readFileSync(join(repoRoot, 'skills', 'saju', 'scripts', 'package-lock.json'), 'utf8'),
  );
  const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
  const rules = JSON.parse(
    readFileSync(join(repoRoot, 'skills', 'saju', 'scripts', 'saju', 'rules.json'), 'utf8'),
  );
  const relationRules = JSON.parse(
    readFileSync(join(repoRoot, 'skills', 'saju', 'scripts', 'saju', 'relation-rules.json'), 'utf8'),
  );

  const result = okResult(runCli(['--input', join(REQUESTS, 'lunar-leap.json')]));
  const p = result.provenance;
  assert.equal(p.calendarConverter.id, 'korean-lunar-calendar');
  assert.equal(p.calendarConverter.version, lock.packages['node_modules/korean-lunar-calendar'].version);
  assert.equal(p.ephemeris.id, 'astronomy-engine');
  assert.equal(p.ephemeris.version, lock.packages['node_modules/astronomy-engine'].version);
  for (const name of Object.keys(pkg.dependencies).sort()) {
    assert.equal(p.packages[name].declared, pkg.dependencies[name], `${name} declared`);
    assert.equal(
      p.packages[name].resolved,
      lock.packages[`node_modules/${name}`].version,
      `${name} resolved: a stale install surfaces here`,
    );
  }
  assert.equal(
    p.ruleTables['saju/rules.json'].sha256,
    sha256(canonicalStringify(rules)),
  );
  assert.equal(
    p.ruleTables['saju/relation-rules.json'].sha256,
    sha256(canonicalStringify(relationRules)),
  );
  assert.equal(p.ruleTables['saju/rules.json'].canonicalization, 'stable-stringify-v1');
});

test('stale converter rejection: a failed conversion leaves no reusable state', () => {
  // The upstream converter object keeps constructor "today" state after a
  // failed setter; the seam contract is a fresh converter per call. A failed
  // conversion must throw AND the next call must return exact results —
  // interleaved in both directions.
  assert.throws(
    () => lunarToSolar({ year: 2017, month: 1, day: 1, leapMonth: true }),
    (e) => e instanceof CalendarError && e.code === 'INVALID_LUNAR_DATE',
  );
  assert.deepEqual(
    lunarToSolar({ year: 2017, month: 5, day: 1, leapMonth: true }),
    { year: 2017, month: 6, day: 24 },
  );
  assert.equal(solarToLunar({ year: 2051, month: 1, day: 1 }), null); // out of coverage
  assert.deepEqual(
    solarToLunar({ year: 1998, month: 10, day: 27 }),
    { year: 1998, month: 9, day: 8, leapMonth: false },
  );
  assert.deepEqual(
    lunarToSolar({ year: 1998, month: 9, day: 8, leapMonth: false }),
    { year: 1998, month: 10, day: 27 },
  );
});

// --- unknown birth time ---------------------------------------------------------------

test('unknown birth time on a jie day: two candidates, null hour pillars, three limitations', () => {
  // 2024-02-04 contains the real Ipchun instant (17:26:49.630 Seoul), so the
  // whole-day enumeration splits into before/after candidates; the hour
  // pillar is never inferred.
  const result = okResult(runRequest(solarRequest({
    date: '2024-02-04', time: null, timezone: 'Asia/Seoul', gender: 'female',
  })));
  assert.equal(result.calendar.resolvedInstant, null);
  assert.equal(result.natal.candidates.length, 2);
  const [before, after] = result.natal.candidates;
  assert.equal(before.side, 'before');
  assert.equal(after.side, 'after');
  assert.equal(before.pillars.hour, null);
  assert.equal(after.pillars.hour, null);
  assert.equal(result.natal.coverageComplete, false);
  assert.deepEqual(
    [pillarGZ(before, 'year'), pillarGZ(before, 'month'), pillarGZ(before, 'day')],
    ['癸卯', '乙丑', '戊戌'],
  );
  assert.deepEqual(
    [pillarGZ(after, 'year'), pillarGZ(after, 'month'), pillarGZ(after, 'day')],
    ['甲辰', '丙寅', '戊戌'],
  );
  // The 'before' interval covers the Seoul civil day up to T0+120 s
  // inclusive; 'after' starts at T0-120 s.
  const T0 = findSolarTerm({ year: 2024, month: 2 }).instantMs;
  assert.equal(before.interval.startIso, '2024-02-03T15:00:00.000Z');
  assert.equal(before.interval.endMs, T0 + 120000 + 1);
  assert.equal(after.interval.startMs, T0 - 120000);
  assert.equal(after.interval.endIso, '2024-02-04T15:00:00.000Z');
  assert.deepEqual(limitationCodes(result), [
    'AMBIGUOUS_NATAL_BOUNDARY',
    'SOLAR_TERM_UNCERTAINTY',
    'UNKNOWN_BIRTH_TIME',
  ]);
  const ambiguous = result.limitations.find((l) => l.code === 'AMBIGUOUS_NATAL_BOUNDARY');
  assert.equal(ambiguous.path, 'birth.date');
  assert.equal(ambiguous.details.eventId, '2024-ipchun');
  const unknown = result.limitations.find((l) => l.code === 'UNKNOWN_BIRTH_TIME');
  assert.equal(unknown.path, 'birth.time');
  assert.equal(unknown.details.hourPillar, null);
  assert.equal(unknown.details.countsUnits, 6);
});

// --- rule-table duplicates and malformed tables ----------------------------------------

test('rule-table duplicates and malformed inputs reject with stable codes', () => {
  const rules = JSON.parse(
    readFileSync(join(repoRoot, 'skills', 'saju', 'scripts', 'saju', 'relation-rules.json'), 'utf8'),
  );
  const occ = (id, stem = '甲', branch = '子') => ({ id, stem, branch });
  // Two occurrences sharing one id are never merged or deduplicated.
  assert.throws(
    () => detectRelations([occ('natal.day'), occ('natal.day', '乙', '丑')], rules),
    (e) => e.code === 'DUPLICATE_OCCURRENCE_ID',
  );
  assert.throws(() => detectRelations('not-an-array', rules), (e) => e.code === 'INVALID_OCCURRENCES');
  assert.throws(
    () => detectRelations([{ id: 'x', stem: 'A', branch: '子' }], rules),
    (e) => e.code === 'INVALID_OCCURRENCE',
  );
  // A day-xun reference must be a real sexagenary pair (parity check).
  assert.throws(
    () => detectRelations([{ id: 'natal.day', stem: '甲', branch: '丑' }], rules),
    (e) => e.code === 'INVALID_OCCURRENCE',
  );
  // Missing tables and a missing gongmang xun anchor are INVALID_RULE_TABLE.
  assert.throws(() => detectRelations([occ('a'), occ('b')], {}), (e) => e.code === 'INVALID_RULE_TABLE');
  const broken = JSON.parse(JSON.stringify(rules));
  delete broken.tables.gongmangByDayXun['甲戌'];
  assert.throws(
    () => detectRelations([{ id: 'natal.day', stem: '乙', branch: '亥' }], broken), // 乙亥 is in the 甲戌 xun
    (e) => e.code === 'INVALID_RULE_TABLE',
  );
});

// --- 2050 lunar-metadata cutoff ----------------------------------------------------------

test('2050 cutoff: 2051 solar birth keeps pillars, lunar metadata is a limitation', () => {
  assert.equal(LUNAR_METADATA_LIMITATION, 'LUNAR_METADATA_OUT_OF_RANGE');
  assert.equal(LUNAR_METADATA_MAX_SOLAR, '2050-12-31');
  const result = okResult(runRequest(solarRequest({
    date: '2051-06-15', time: '12:00:00', timezone: 'Asia/Seoul', gender: 'male',
  })));
  assert.equal(result.calendar.solarDate, '2051-06-15');
  assert.equal(result.calendar.lunar, null);
  // Pillars are still derived (hand-derived: day index 7 = 辛未; saju year
  // 2051 = 辛未; June month 甲午; noon hour 甲午 on a 辛 day).
  const c = result.natal.candidates[0];
  assert.deepEqual(
    [pillarGZ(c, 'year'), pillarGZ(c, 'month'), pillarGZ(c, 'day'), pillarGZ(c, 'hour')],
    ['辛未', '甲午', '辛未', '甲午'],
  );
  assert.equal(result.natal.coverageComplete, true);
  const lim = result.limitations.find((l) => l.code === 'LUNAR_METADATA_OUT_OF_RANGE');
  assert.ok(lim, 'LUNAR_METADATA_OUT_OF_RANGE missing');
  assert.equal(lim.path, 'birth.date');
  assert.deepEqual(lim.details, { solarDate: '2051-06-15', maxSolarDate: '2050-12-31' });
});

test('2050 cutoff: a 2051 transit target still gets pillars; the cutoff only limits metadata', () => {
  const result = okResult(runRequest(solarRequest(
    {
      date: '1998-10-27', time: '20:40:00', timezone: 'Asia/Seoul',
      utcOffset: '+09:00', gender: 'male',
    },
    { majorCycles: 0, transits: ['2051-06-15T12:00:00+09:00'] },
  )));
  const tr = result.transits[0];
  assert.equal(tr.local.date, '2051-06-15');
  assert.equal(tr.age.years, 52); // before the 1998-10-27 anniversary
  const pillars = tr.pillarCandidates[0].pillars;
  assert.deepEqual(
    [pillars.annual.ganZhi, pillars.monthly.ganZhi, pillars.daily.ganZhi],
    ['辛未', '甲午', '辛未'],
  );
});

test('2050 cutoff: boundary days and lunar-birth rejection at the coverage edge', () => {
  // Last covered solar day still carries lunar metadata, no limitation.
  const last = okResult(runRequest(solarRequest({
    date: '2050-12-31', time: '12:00:00', timezone: 'Asia/Seoul',
  })));
  assert.deepEqual(last.calendar.lunar, { year: 2050, month: 11, day: 18, leapMonth: false });
  assert.ok(!limitationCodes(last).includes('LUNAR_METADATA_OUT_OF_RANGE'));
  // A lunar birth request beyond the converter's coverage rejects outright.
  const lunar2051 = errResult(runRequest({
    schemaVersion: 1,
    birth: {
      calendar: 'korean_lunar', date: '2051-01-01', leapMonth: false,
      time: '12:00:00', timezone: 'Asia/Seoul',
    },
    queries: { majorCycles: 0, transits: [] },
  }));
  assert.equal(lunar2051.code, 'INVALID_LUNAR_DATE');
  assert.equal(lunar2051.path, 'birth.date');
  // The last convertible lunar day (2050-11-18 -> solar 2050-12-31) succeeds;
  // one day later does not exist.
  const lunarLast = okResult(runRequest({
    schemaVersion: 1,
    birth: {
      calendar: 'korean_lunar', date: '2050-11-18', leapMonth: false,
      time: '12:00:00', timezone: 'Asia/Seoul',
    },
    queries: { majorCycles: 0, transits: [] },
  }));
  assert.equal(lunarLast.calendar.solarDate, '2050-12-31');
  const lunarOver = errResult(runRequest({
    schemaVersion: 1,
    birth: {
      calendar: 'korean_lunar', date: '2050-11-19', leapMonth: false,
      time: '12:00:00', timezone: 'Asia/Seoul',
    },
    queries: { majorCycles: 0, transits: [] },
  }));
  assert.equal(lunarOver.code, 'INVALID_LUNAR_DATE');
  // The lower edge: lunar 1899-12-01 converts to solar 1900-01-01 (accepted);
  // lunar 1899-11-29 converts to 1899-12-31, below the solar floor.
  const lunarFloor = okResult(runRequest({
    schemaVersion: 1,
    birth: {
      calendar: 'korean_lunar', date: '1899-12-01', leapMonth: false,
      time: '12:00:00', timezone: 'Asia/Seoul',
    },
    queries: { majorCycles: 0, transits: [] },
  }));
  assert.equal(lunarFloor.calendar.solarDate, '1900-01-01');
  const lunarBelow = errResult(runRequest({
    schemaVersion: 1,
    birth: {
      calendar: 'korean_lunar', date: '1899-11-29', leapMonth: false,
      time: '12:00:00', timezone: 'Asia/Seoul',
    },
    queries: { majorCycles: 0, transits: [] },
  }));
  assert.equal(lunarBelow.code, 'DATE_OUT_OF_RANGE');
  assert.equal(lunarBelow.path, 'birth.date');
});

// --- transit range endpoints --------------------------------------------------------------

test('transit endpoints: 366 accepted, 367 rejected, range edges in the birth zone', () => {
  const birth = {
    date: '1998-10-27', time: '20:40:00', timezone: 'Asia/Seoul',
    utcOffset: '+09:00', gender: 'male',
  };
  const at366 = okResult(runRequest(solarRequest(birth, {
    majorCycles: 0,
    transits: Array.from({ length: 366 }, () => '2026-09-17T12:00:00+09:00'),
  })));
  assert.equal(at366.transits.length, 366);
  const over = errResult(runRequest(solarRequest(birth, {
    majorCycles: 0,
    transits: Array.from({ length: 367 }, () => '2026-09-17T12:00:00+09:00'),
  })));
  assert.equal(over.code, 'TOO_MANY_TRANSITS');
  assert.equal(over.path, 'queries.transits');

  // The declared local-date range is evaluated in the BIRTH zone:
  // 2100-12-31T15:00:00Z is already 2101-01-01 00:00 in Seoul.
  const hiOk = okResult(runRequest(solarRequest(birth, {
    majorCycles: 0, transits: ['2100-12-31T14:59:59Z'],
  })));
  assert.equal(hiOk.transits[0].local.date, '2100-12-31');
  const hiOver = errResult(runRequest(solarRequest(birth, {
    majorCycles: 0, transits: ['2100-12-31T15:00:00Z'],
  })));
  assert.equal(hiOver.code, 'TRANSIT_OUT_OF_RANGE');
  assert.equal(hiOver.path, 'queries.transits[0]');
  // The lower edge uses Seoul's 1899 LMT offset +08:27:52 (not +09:00):
  // 1899-12-31T15:32:08Z is 1900-01-01 00:00:00 local — the first legal day.
  const loOk = okResult(runRequest(solarRequest(birth, {
    majorCycles: 0, transits: ['1899-12-31T15:32:08Z'],
  })));
  assert.equal(loOk.transits[0].local.date, '1900-01-01');
  assert.equal(loOk.transits[0].local.utcOffset, '+08:27:52');
  const loOver = errResult(runRequest(solarRequest(birth, {
    majorCycles: 0, transits: ['1899-12-31T15:32:07Z'],
  })));
  assert.equal(loOver.code, 'TRANSIT_OUT_OF_RANGE');
});

test('transit endpoints: RFC3339 explicit-offset enforcement', () => {
  const birth = {
    date: '1998-10-27', time: '20:40:00', timezone: 'Asia/Seoul', gender: 'male',
  };
  for (const [value, code] of [
    ['2026-09-17T12:00:00', 'INVALID_TRANSIT'], // no offset: not an instant
    ['2026-09-17T12:00:00-00:00', 'INVALID_TRANSIT'], // RFC3339 unknown-offset convention
    ['2026-09-17 12:00:00Z', 'INVALID_TRANSIT'], // space separator
    ['2026-09-17T24:00:00Z', 'INVALID_TRANSIT'],
    ['2026-06-30T23:59:60Z', 'INVALID_TRANSIT'], // leap second
    ['2026-02-30T00:00:00Z', 'INVALID_TRANSIT'],
    [42, 'INVALID_TRANSIT'],
    [null, 'INVALID_TRANSIT'],
  ]) {
    const err = errResult(runRequest(solarRequest(birth, {
      majorCycles: 0, transits: [value],
    })));
    assert.equal(err.code, code, JSON.stringify(value));
    assert.equal(err.path, 'queries.transits[0]');
  }
});

// --- CLI rejection surface -----------------------------------------------------------------

test('CLI: malformed JSON, unknown schemaVersion and over-limit arrays are typed exit-2', () => {
  for (const [raw, code] of [
    ['{ not json', 'INVALID_JSON'],
    ['', 'INVALID_JSON'],
    ['[1,2,3]', 'INVALID_REQUEST'],
    ['"saju"', 'INVALID_REQUEST'],
    ['null', 'INVALID_REQUEST'],
  ]) {
    const err = errResult(withRequestFile(raw, (file) => runCli(['--input', file])));
    assert.equal(err.code, code, JSON.stringify(raw));
  }
  const v2 = errResult(runRequest({
    schemaVersion: 2,
    birth: {
      calendar: 'solar', date: '1998-10-27', time: '20:40:00', timezone: 'Asia/Seoul',
    },
  }));
  assert.equal(v2.code, 'SCHEMA_VERSION_UNSUPPORTED');
  assert.equal(v2.path, 'schemaVersion');
  const vStr = errResult(runRequest({
    schemaVersion: '1',
    birth: {
      calendar: 'solar', date: '1998-10-27', time: '20:40:00', timezone: 'Asia/Seoul',
    },
  }));
  assert.equal(vStr.code, 'SCHEMA_VERSION_UNSUPPORTED');
  const noVer = errResult(runRequest({
    birth: {
      calendar: 'solar', date: '1998-10-27', time: '20:40:00', timezone: 'Asia/Seoul',
    },
  }));
  assert.equal(noVer.code, 'MISSING_FIELD');
  assert.equal(noVer.path, 'schemaVersion');
  const cycles = errResult(runRequest(solarRequest(
    { date: '1998-10-27', time: '20:40:00', timezone: 'Asia/Seoul' },
    { majorCycles: 13, transits: [] },
  )));
  assert.equal(cycles.code, 'INVALID_VALUE');
  assert.equal(cycles.path, 'queries.majorCycles');
});

test('CLI: injection-looking strings stay data and reject by schema, never execute', () => {
  // Every payload is passed through an argv array and parsed as JSON data;
  // nothing reaches a shell. The sentinel path proves non-execution.
  withRequestFile('{}', (_file, dir) => {
    const sentinel = join(dir, 'PWNED');
    const base = {
      calendar: 'solar', date: '1998-10-27', time: '20:40:00',
      timezone: 'Asia/Seoul', gender: 'male',
    };
    const cases = [
      [{ ...base, timezone: `$(touch ${sentinel})` }, 'INVALID_TIMEZONE', 'birth.timezone'],
      [{ ...base, timezone: '$(rm -rf /)' }, 'INVALID_TIMEZONE', 'birth.timezone'],
      [{ ...base, timezone: '`id`' }, 'INVALID_TIMEZONE', 'birth.timezone'],
      [{ ...base, timezone: 'Asia/Seoul; rm -rf /' }, 'INVALID_TIMEZONE', 'birth.timezone'],
      [{ ...base, date: `1998-10-27"; touch ${sentinel}; "` }, 'INVALID_DATE', 'birth.date'],
      [{ ...base, gender: '$(id)' }, 'INVALID_VALUE', 'birth.gender'],
      [{ ...base, utcOffset: '+09:00;id' }, 'INVALID_UTC_OFFSET', 'birth.utcOffset'],
    ];
    for (const [birth, code, path] of cases) {
      const err = errResult(runRequest({
        schemaVersion: 1, birth, queries: { majorCycles: 0, transits: [] },
      }));
      assert.equal(err.code, code, JSON.stringify(birth));
      assert.equal(err.path, path);
    }
    const transit = errResult(runRequest({
      schemaVersion: 1,
      birth: base,
      queries: { majorCycles: 0, transits: [`$(touch ${sentinel})`] },
    }));
    assert.equal(transit.code, 'INVALID_TRANSIT');
    // An unknown top-level field is rejected, not executed or ignored.
    const field = errResult(runRequest({
      schemaVersion: 1,
      birth: base,
      queries: { majorCycles: 0, transits: [] },
      '$(reboot)': true,
    }));
    assert.equal(field.code, 'UNKNOWN_FIELD');
    assert.ok(!existsSync(sentinel), 'injection payload executed');
  });
});

// --- host-TZ independence --------------------------------------------------------------------

test('host-TZ independence: in-process TZ mutation and spawned TZ env are inert', () => {
  const raw = requestFixture('known');
  const expected = calculate(raw);
  const saved = process.env.TZ;
  try {
    for (const tz of ['UTC', 'Asia/Seoul', 'Pacific/Kiritimati', 'America/New_York']) {
      process.env.TZ = tz;
      assert.deepEqual(calculate(raw), expected, `in-process TZ=${tz} changed the result`);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
  // The spawned CLI is byte-identical under different process timezones.
  const utc = runCli(['--input', join(REQUESTS, 'known.json')], { TZ: 'UTC' });
  const seoul = runCli(['--input', join(REQUESTS, 'known.json')], { TZ: 'Asia/Seoul' });
  assert.equal(utc.status, 0);
  assert.equal(seoul.status, 0);
  assert.equal(utc.stdout, seoul.stdout, 'stdout differs between TZ=UTC and TZ=Asia/Seoul');
  assert.equal(utc.stderr, seoul.stderr);
});

// --- same-pin astrology baseline --------------------------------------------------------------

test('same-pin astrology baseline: natal.mjs numeric output unchanged', () => {
  const run = (args, input) => {
    const res = spawnSync(process.execPath, [LEGACY, ...args, JSON.stringify(input)], {
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(res.status, 0, `natal.mjs exited ${res.status}: ${res.stderr}`);
    assert.equal(res.stderr, '', `unexpected stderr: ${res.stderr}`);
    return JSON.parse(res.stdout);
  };
  // Same anchors as tests/saju/natal-regression.test.mjs: full parsed-object
  // equality against the retained golden baseline.
  assert.deepEqual(run([], baseline.natal.input), baseline.natal.expected);
  const synastry = run(['--synastry'], baseline.synastry.input);
  assert.equal(synastry.score, baseline.synastry.expected.score);
  assert.deepEqual(synastry, baseline.synastry.expected);
});
