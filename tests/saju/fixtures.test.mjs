// Fixture integrity integration for tests/fixtures/saju/.
//
// Asserts the fixture tree is internally consistent and anchored to the
// archived upstream raw responses: manifest sha256 pins, KASI solc anchors,
// Horizons provenance (center/frame/timeScale) with roots re-derived from the
// archived API bodies, request-fixture shapes against the plan contract, and
// the legacy astrology baseline pin. Malformed provenance is exercised only on
// cloned temp copies; the source fixture tree is never mutated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateFixtureTree } from './helpers/validate-fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const fixtureDir = join(repoRoot, 'tests', 'fixtures', 'saju');
const manifest = JSON.parse(readFileSync(join(fixtureDir, 'manifest.json'), 'utf8'));

const problemsOf = (dir) => validateFixtureTree({ fixtureDir: dir, repoRoot });
const codesOf = (dir) => new Set(problemsOf(dir).map((p) => p.code));

const withClonedFixtures = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'saju-fixtures-'));
  try {
    cpSync(fixtureDir, dir, { recursive: true });
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('manifest pins every fixture file and the tree is complete', () => {
  assert.equal(manifest.schemaVersion, 1);
  const declared = new Set(['manifest.json']);
  for (const key of ['calendar', 'solarTerms', 'rules', 'astrologyBaseline']) {
    declared.add(manifest.fixtures[key].file);
  }
  for (const entry of Object.values(manifest.fixtures.requests)) declared.add(entry.file);
  const problems = problemsOf(fixtureDir);
  assert.deepEqual(problems, [], problems.map((p) => `${p.code} ${p.path}: ${p.message}`).join('\n'));
  // No undeclared top-level fixture file may exist (validator reports them).
  for (const file of declared) assert.ok(existsSync(join(fixtureDir, file)), `missing ${file}`);
});

test('all 26 solar-term cases re-derive from archived Horizons bodies', () => {
  const solar = JSON.parse(readFileSync(join(fixtureDir, 'solar-terms.json'), 'utf8'));
  assert.equal(solar.cases.length, 26);
  assert.equal(solar.sources.length, 52);
  const ut = solar.cases.filter((c) => c.timeScale === 'UT');
  const tt = solar.cases.filter((c) => c.timeScale === 'TT');
  assert.equal(ut.length, 12);
  assert.equal(tt.length, 14);
  for (const c of solar.cases) {
    assert.equal(c.toleranceSeconds, 120, c.id);
    assert.ok(c.bracketSeconds > 0 && c.bracketSeconds <= 60, c.id);
  }
  // validateFixtureTree already re-derived every root; assert it found nothing.
  assert.deepEqual(
    problemsOf(fixtureDir).filter((p) => p.path.startsWith('solar-terms')),
    [],
  );
});

test('KASI anchors: 3 cases, raw sha256, requested fields, label quarantine', () => {
  const calendar = JSON.parse(readFileSync(join(fixtureDir, 'calendar.json'), 'utf8'));
  assert.equal(calendar.cases.length, 3);
  assert.equal(calendar.sources.length, 3);
  const byId = new Map(calendar.cases.map((c) => [c.id, c]));
  // Independent day-cycle anchors: 2000-01-07 = 甲子, 1998-10-27 = 丁未,
  // leap lunar 2017-05-01 = solar 2017-06-24 = 壬午.
  assert.equal(byId.get('kasi-solc-2000-01-07').dayGanZhi, '甲子');
  assert.equal(byId.get('kasi-solc-1998-10-27').dayGanZhi, '丁未');
  const leap = byId.get('kasi-solc-2017-06-24');
  assert.equal(leap.dayGanZhi, '壬午');
  assert.equal(leap.lunar.leapMonth, true);
  assert.deepEqual(
    problemsOf(fixtureDir).filter((p) => p.path.startsWith('calendar')),
    [],
  );
});

test('request fixtures match the plan contract and manifest expectations', () => {
  for (const [name, entry] of Object.entries(manifest.fixtures.requests)) {
    const req = JSON.parse(readFileSync(join(fixtureDir, entry.file), 'utf8'));
    assert.equal(req.schemaVersion, 1, name);
    assert.ok(req.birth && typeof req.birth === 'object', name);
    assert.match(req.birth.date, /^\d{4}-\d{2}-\d{2}$/, name);
    assert.ok(typeof req.birth.timezone === 'string' && req.birth.timezone.length > 0, name);
    if (req.birth.calendar === 'korean_lunar') {
      assert.equal(typeof req.birth.leapMonth, 'boolean', name);
    } else {
      assert.equal(req.birth.calendar, 'solar', name);
      assert.ok(!('leapMonth' in req.birth), `${name}: solar forbids leapMonth`);
    }
    const expect = entry.expect;
    if (expect.outcome === 'input-error') assert.equal(expect.exit, 2, name);
    if (expect.outcome === 'success') assert.equal(expect.exit, 0, name);
  }
  assert.deepEqual(
    problemsOf(fixtureDir).filter((p) => p.path.startsWith('requests')),
    [],
  );
});

test('astrology baseline pins the current natal.mjs sha256', () => {
  const baseline = JSON.parse(readFileSync(join(fixtureDir, 'astrology-baseline.json'), 'utf8'));
  assert.equal(
    baseline.source.sha256,
    manifest.fixtures.astrologyBaseline.pinnedScriptSha256,
  );
  assert.deepEqual(
    problemsOf(fixtureDir).filter((p) => p.path.startsWith('astrology-baseline')),
    [],
  );
});

test('cloned fixture with corrupted provenance sha256 is rejected', () => {
  withClonedFixtures((dir) => {
    const solarPath = join(dir, 'solar-terms.json');
    const solar = JSON.parse(readFileSync(solarPath, 'utf8'));
    solar.sources[0].sha256 = '0'.repeat(64);
    writeFileSync(solarPath, JSON.stringify(solar, null, 2));
    const problems = problemsOf(dir);
    assert.ok(
      problems.some((p) => p.code === 'RAW_SHA256_MISMATCH' && p.path.includes(solar.sources[0].id)),
      `expected RAW_SHA256_MISMATCH, got ${JSON.stringify(problems)}`,
    );
  });
});

test('cloned fixture missing a raw source file is rejected', () => {
  withClonedFixtures((dir) => {
    rmSync(join(dir, 'raw', 'kasi', 'solc-2000-01-07.json'));
    const codes = codesOf(dir);
    assert.ok(codes.has('RAW_FILE_MISSING'), `expected RAW_FILE_MISSING, got ${[...codes]}`);
  });
});

test('cloned fixture with wrong Horizons center is rejected', () => {
  withClonedFixtures((dir) => {
    const solarPath = join(dir, 'solar-terms.json');
    const solar = JSON.parse(readFileSync(solarPath, 'utf8'));
    solar.sources[0].center = '500@0'; // J2000 solar-system barycenter: wrong frame
    writeFileSync(solarPath, JSON.stringify(solar, null, 2));
    const problems = problemsOf(dir);
    assert.ok(
      problems.some((p) => p.code === 'PROVENANCE_MISMATCH' && p.message.includes('center')),
      `expected PROVENANCE_MISMATCH for center, got ${JSON.stringify(problems)}`,
    );
  });
});

test('cloned fixture with UT timeScale on a TT case is rejected', () => {
  withClonedFixtures((dir) => {
    const solarPath = join(dir, 'solar-terms.json');
    const solar = JSON.parse(readFileSync(solarPath, 'utf8'));
    const ttCase = solar.cases.find((c) => c.id === 'tt-2000-ipchun');
    ttCase.timeScale = 'UT'; // TT anchors must never be compared as UT
    writeFileSync(solarPath, JSON.stringify(solar, null, 2));
    const codes = codesOf(dir);
    assert.ok(
      codes.has('CASE_FIELD_MISMATCH') || codes.has('PROVENANCE_MISMATCH'),
      `expected timeScale rejection, got ${[...codes]}`,
    );
  });
});

test('cloned KASI case anchored on LUNC_PRCN instead of LUNC_ILJIN is rejected', () => {
  withClonedFixtures((dir) => {
    const calPath = join(dir, 'calendar.json');
    const cal = JSON.parse(readFileSync(calPath, 'utf8'));
    // 2000-01-07 raw has LUNC_PRCN=기묘(己卯): using it as the day pillar is
    // exactly the quarantined-label failure the fixture must catch.
    cal.cases.find((c) => c.id === 'kasi-solc-2000-01-07').dayGanZhi = '己卯';
    writeFileSync(calPath, JSON.stringify(cal, null, 2));
    const problems = problemsOf(dir);
    assert.ok(
      problems.some((p) => p.code === 'ANCHOR_MISMATCH' && p.path.includes('dayGanZhi')),
      `expected ANCHOR_MISMATCH for dayGanZhi, got ${JSON.stringify(problems)}`,
    );
  });
});

test('cloned manifest with a drifted file hash is rejected', () => {
  withClonedFixtures((dir) => {
    const manifestPath = join(dir, 'manifest.json');
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    m.fixtures.calendar.sha256 = 'f'.repeat(64);
    writeFileSync(manifestPath, JSON.stringify(m, null, 2));
    const problems = problemsOf(dir);
    assert.ok(
      problems.some((p) => p.code === 'FILE_SHA256_MISMATCH' && p.path === 'calendar.json'),
      `expected FILE_SHA256_MISMATCH, got ${JSON.stringify(problems)}`,
    );
  });
});
