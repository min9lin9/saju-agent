// distribution.test.mjs — end-to-end proof for the INSTALLED distribution.
//
// Unlike install.test.mjs (which checks installer status tokens and one
// destination run), this suite treats the installed tree as the product:
// the real installer (`OPENCLAW_WORKSPACE=<mkdtemp> bash install.sh`,
// non-TTY stdin so the star helper prints STAR_CONSENT_REQUIRED and never
// reaches gh) produces the destination, then the COPIED CLIs — never the
// repo's — are exercised against every request fixture and both natal.mjs
// modes. Installed output is compared byte-for-byte against the repo CLI's
// own output and field-for-field against the task-1 anchors
// (tests/fixtures/saju/manifest.json expectations and
// tests/fixtures/saju/astrology-baseline.json).
//
// Coverage:
//   install+parity — installer READY; installed file set equals the source
//     skill tree minus node_modules (no test/evidence leakage); node_modules
//     holds exactly the two locked deps with declared licenses; every
//     request fixture gives byte-identical stdout/stderr/status vs the repo
//     CLI plus manifest-anchored facts; natal.mjs and --synastry match the
//     golden baseline exactly.
//   failure path   — in a DISPOSABLE COPY of the installed tree, removing a
//     rule file exits nonzero with empty stdout and a typed error on stderr
//     (fs ENOENT carries a string .code → exit 2); corrupting it with
//     invalid JSON exits nonzero the same way (untyped SyntaxError →
//     INTERNAL_ERROR → exit 1). No fallback output is ever emitted. The
//     pristine install is re-run afterwards to prove the copy was isolated.
//
// Determinism: no sleeps, no polling, no ambient clock; every wait is a
// bounded spawnSync process-exit wait. Every temp dir is removed in
// try/finally with a logged cleanup receipt. The user's real OpenClaw
// workspace is never touched — OPENCLAW_WORKSPACE is always a mkdtemp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const INSTALLER = join(repoRoot, 'install.sh');
const SRC_SKILL = join(repoRoot, 'skills', 'saju');
const REPO_SCRIPTS = join(SRC_SKILL, 'scripts');
const REQUESTS = join(repoRoot, 'tests', 'fixtures', 'saju', 'requests');
const MANIFEST = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'saju', 'manifest.json'), 'utf8'),
);
const BASELINE = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'saju', 'astrology-baseline.json'), 'utf8'),
);

const which = (name) => {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
};
const BASH = which('bash') ?? '/usr/bin/bash';

const FIXTURE_NAMES = [
  'known', 'unknown-time', 'lunar-leap', 'missing-gender', 'transits',
  'invalid-date', 'out-of-range', 'dst-gap', 'dst-fold',
];

const cleanup = (t, dir) => {
  rmSync(dir, { recursive: true, force: true });
  t.diagnostic(`cleanup receipt: removed ${dir} (exists=${existsSync(dir)})`);
};

// Runs the real installer into ws with non-TTY stdin: the star helper takes
// its non-interactive branch (STAR_CONSENT_REQUIRED, exit 0) and gh is never
// invoked — the token is only printed on the branch that exits before gh.
const runInstaller = (ws) => {
  const install = spawnSync(BASH, [INSTALLER], {
    encoding: 'utf8',
    env: { ...process.env, OPENCLAW_WORKSPACE: ws },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(install.error, undefined, `spawn error: ${install.error}`);
  assert.equal(
    install.status, 0,
    `install.sh exit ${install.status}\nstdout:\n${install.stdout}\nstderr:\n${install.stderr}`,
  );
  return install.stdout + install.stderr;
};

// Runs a CLI under scriptsDir; returns the raw spawnSync result.
const run = (scriptsDir, file, args) => spawnSync(
  process.execPath,
  [join(scriptsDir, file), ...args],
  { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 },
);

const runSaju = (scriptsDir, fixture) =>
  run(scriptsDir, 'saju.mjs', ['--input', join(REQUESTS, `${fixture}.json`)]);

// Relative file list under dir, excluding node_modules — the unit of the
// installed-tree vs source-tree comparison.
const treeFiles = (root) => {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(root, full));
    }
  };
  walk(root);
  return out.sort();
};

// Parses a rejected run: nonzero exit, empty stdout, one stderr JSON object
// {error:{code,path,message}} — the failure contract, never fallback text.
const errResult = (proc) => {
  assert.equal(proc.error, undefined, `spawn error: ${proc.error}`);
  assert.notEqual(proc.status, 0, `expected nonzero exit; stdout: ${proc.stdout}`);
  assert.equal(proc.stdout, '', 'stdout must be empty on failure — no fallback output');
  const parsed = JSON.parse(proc.stderr);
  assert.equal(typeof parsed.error, 'object');
  assert.equal(typeof parsed.error.code, 'string');
  assert.ok('path' in parsed.error);
  assert.equal(typeof parsed.error.message, 'string');
  return { status: proc.status, error: parsed.error };
};

test('installed distribution: file/license coverage plus byte-parity with repo CLI and golden anchors', (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'saju-dist-ws-'));
  try {
    const out = runInstaller(ws);
    assert.match(out, /files copied/);
    assert.match(out, /feature saju-cli:\s+READY/);
    assert.match(out, /feature natal:\s+READY/);
    assert.match(out, /STATUS: READY/);
    // Non-TTY stdin: the star helper emitted its consent-required token
    // exactly once and exited before any gh invocation.
    const starLines = out.split('\n').filter((l) => l.includes('STAR_'));
    assert.deepEqual(
      starLines,
      ['STAR_CONSENT_REQUIRED https://github.com/min9lin9/saju-agent'],
      'star helper must emit STAR_CONSENT_REQUIRED exactly once',
    );

    const destSkill = join(ws, 'skills', 'saju');
    const destScripts = join(destSkill, 'scripts');

    // --- module coverage: installed tree == source skill tree minus
    // node_modules. Set equality proves both directions: every shipped file
    // (scripts, package.json, package-lock.json, SKILL.md, references,
    // profiles.example.json) arrived, and nothing else — no repo test or
    // evidence leakage — was added.
    assert.deepEqual(treeFiles(destSkill), treeFiles(SRC_SKILL));
    for (const leaked of ['test', 'tests', 'fixtures', '.omo', 'evidence']) {
      assert.ok(
        !existsSync(join(destSkill, leaked)),
        `destination must not contain ${leaked}`,
      );
    }

    // --- dependency + license coverage: npm ci installed exactly the two
    // locked deps at their locked versions, each carrying a declared license.
    const lock = JSON.parse(readFileSync(join(destScripts, 'package-lock.json'), 'utf8'));
    for (const [pkg, version] of [
      ['astronomy-engine', '2.1.19'],
      ['korean-lunar-calendar', '0.4.0'],
    ]) {
      const depPkg = JSON.parse(
        readFileSync(join(destScripts, 'node_modules', pkg, 'package.json'), 'utf8'),
      );
      assert.equal(depPkg.version, version, `installed ${pkg} version`);
      assert.equal(
        depPkg.version,
        lock.packages[`node_modules/${pkg}`].version,
        `${pkg} must match the committed lockfile`,
      );
      assert.equal(depPkg.license, 'MIT', `${pkg} ships a declared license`);
      assert.equal(lock.packages[`node_modules/${pkg}`].license, 'MIT');
    }
    assert.ok(
      existsSync(join(destScripts, 'node_modules', 'korean-lunar-calendar', 'LICENSE')),
      'korean-lunar-calendar LICENSE file must be installed',
    );

    // --- CLI parity: every request fixture run against the INSTALLED
    // saju.mjs must match the repo CLI byte-for-byte (stdout, stderr, exit
    // status) — same runtime, same locked deps, same rule tables.
    for (const name of FIXTURE_NAMES) {
      const installed = runSaju(destScripts, name);
      const repo = runSaju(REPO_SCRIPTS, name);
      assert.equal(installed.error, undefined, `spawn error (${name}): ${installed.error}`);
      assert.equal(
        installed.status, repo.status,
        `${name}: installed exit ${installed.status} vs repo ${repo.status}; stderr: ${installed.stderr}`,
      );
      assert.equal(installed.stdout, repo.stdout, `${name}: stdout must be byte-identical`);
      assert.equal(installed.stderr, repo.stderr, `${name}: stderr must be byte-identical`);
    }

    // --- manifest anchors on the INSTALLED output (task-1 regression facts).
    const expectFor = (name) => MANIFEST.fixtures.requests[name].expect;

    const known = JSON.parse(runSaju(destScripts, 'known').stdout);
    assert.equal(known.schemaVersion, 1);
    assert.equal(known.rulesetId, 'kr-civil-midnight-v1');
    assert.equal(known.calendar.solarDate, expectFor('known').derivedFacts.solarDate);
    assert.equal(
      known.natal.candidates[0].pillars.day.ganZhi,
      expectFor('known').derivedFacts.dayGanZhi,
    );
    assert.equal(known.majorCycles.count, expectFor('known').majorCyclesRequested);
    assert.equal(known.transits.length, expectFor('known').transitsRequested);
    assert.equal(known.provenance.packages['astronomy-engine'].resolved, '2.1.19');
    assert.equal(known.provenance.packages['korean-lunar-calendar'].resolved, '0.4.0');

    const lunar = JSON.parse(runSaju(destScripts, 'lunar-leap').stdout);
    assert.equal(
      lunar.calendar.solarDate,
      expectFor('lunar-leap').derivedFacts.convertedSolarDate,
    );
    assert.equal(
      lunar.natal.candidates[0].pillars.day.ganZhi,
      expectFor('lunar-leap').derivedFacts.dayGanZhi,
    );

    const unknownTime = JSON.parse(runSaju(destScripts, 'unknown-time').stdout);
    for (const cand of unknownTime.natal.candidates) {
      assert.equal(cand.pillars.hour, null, 'hour pillar stays null, never inferred');
    }
    assert.equal(unknownTime.calendar.resolvedInstant, null);
    assert.ok(
      unknownTime.limitations.some((l) => l.code === 'UNKNOWN_BIRTH_TIME'),
      'UNKNOWN_BIRTH_TIME limitation required',
    );
    assert.equal(unknownTime.majorCycles.count, expectFor('unknown-time').majorCyclesRequested);

    const transits = JSON.parse(runSaju(destScripts, 'transits').stdout);
    assert.equal(transits.transits.length, expectFor('transits').transitsRequested);
    assert.deepEqual(
      transits.transits.map((tr) => tr.input),
      ['2026-09-17T12:00:00+09:00', '2027-01-01T00:00:00Z', '2026-09-17T12:00:00+09:00'],
      'transit order and duplicates retained',
    );

    const missingGender = JSON.parse(runSaju(destScripts, 'missing-gender').stdout);
    assert.ok(
      missingGender.limitations.some((l) => l.code === 'MISSING_MAJOR_DIRECTION'),
      'MISSING_MAJOR_DIRECTION limitation required',
    );
    assert.equal(missingGender.majorCycles.available, false);

    // Error fixtures: typed exit 2, empty stdout, manifest-anchored codes.
    for (const [name, code] of [
      ['invalid-date', 'INVALID_DATE'],
      ['out-of-range', 'DATE_OUT_OF_RANGE'],
      ['dst-gap', 'NONEXISTENT_LOCAL_TIME'],
      ['dst-fold', 'AMBIGUOUS_LOCAL_TIME'],
    ]) {
      const res = errResult(runSaju(destScripts, name));
      assert.equal(res.status, 2, `${name}: typed errors exit 2`);
      assert.equal(res.error.code, code, `${name} error code`);
      assert.equal(res.error.path, expectFor(name).path, `${name} error path`);
    }

    // --- natal.mjs + synastry: the INSTALLED astrology CLI reproduces the
    // golden baseline exactly and matches the repo CLI byte-for-byte.
    const natalInstalled = run(destScripts, 'natal.mjs', [JSON.stringify(BASELINE.natal.input)]);
    const natalRepo = run(REPO_SCRIPTS, 'natal.mjs', [JSON.stringify(BASELINE.natal.input)]);
    assert.equal(natalInstalled.error, undefined, `spawn error: ${natalInstalled.error}`);
    assert.equal(natalInstalled.status, 0, `natal exit ${natalInstalled.status}: ${natalInstalled.stderr}`);
    assert.equal(natalInstalled.stdout, natalRepo.stdout, 'natal stdout must be byte-identical');
    assert.deepEqual(JSON.parse(natalInstalled.stdout), BASELINE.natal.expected);

    const synInstalled = run(destScripts, 'natal.mjs', ['--synastry', JSON.stringify(BASELINE.synastry.input)]);
    const synRepo = run(REPO_SCRIPTS, 'natal.mjs', ['--synastry', JSON.stringify(BASELINE.synastry.input)]);
    assert.equal(synInstalled.error, undefined, `spawn error: ${synInstalled.error}`);
    assert.equal(synInstalled.status, 0, `synastry exit ${synInstalled.status}: ${synInstalled.stderr}`);
    assert.equal(synInstalled.stdout, synRepo.stdout, 'synastry stdout must be byte-identical');
    assert.deepEqual(JSON.parse(synInstalled.stdout), BASELINE.synastry.expected);
  } finally {
    cleanup(t, ws);
  }
});

test('failure path: missing or corrupt rule file in a disposable copy fails hard, never falls back', (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'saju-dist-ws-'));
  const disposable = mkdtempSync(join(tmpdir(), 'saju-dist-copy-'));
  try {
    const out = runInstaller(ws);
    assert.match(out, /STATUS: READY/);

    const destScripts = join(ws, 'skills', 'saju', 'scripts');
    // Disposable copy of the INSTALLED tree (including node_modules) — the
    // corruption below never touches the pristine install.
    cpSync(join(ws, 'skills', 'saju'), join(disposable, 'saju'), { recursive: true });
    const copyScripts = join(disposable, 'saju', 'scripts');

    // Sanity: the copy works before corruption.
    const sane = runSaju(copyScripts, 'known');
    assert.equal(sane.status, 0, `copied CLI sanity run failed: ${sane.stderr}`);

    // Missing rules.json → fs ENOENT carries a string .code → typed error,
    // exit 2, empty stdout. (The CLI maps any error with a string .code to
    // exit 2; only untyped failures exit 1.)
    rmSync(join(copyScripts, 'saju', 'rules.json'));
    const missingRules = errResult(runSaju(copyScripts, 'known'));
    assert.equal(missingRules.status, 2);
    assert.equal(missingRules.error.code, 'ENOENT');

    // Missing relation-rules.json → same contract. rules.json is restored
    // first so this case actually exercises relation-rules (it loads second).
    copyFileSync(join(destScripts, 'saju', 'rules.json'), join(copyScripts, 'saju', 'rules.json'));
    rmSync(join(copyScripts, 'saju', 'relation-rules.json'));
    const missingRel = errResult(runSaju(copyScripts, 'known'));
    assert.equal(missingRel.status, 2);
    assert.equal(missingRel.error.code, 'ENOENT');

    // Corrupt rules.json (invalid JSON) → untyped SyntaxError →
    // INTERNAL_ERROR, exit 1, empty stdout. relation-rules.json is restored
    // first so this case exercises rules.json, not the still-missing file.
    copyFileSync(
      join(destScripts, 'saju', 'relation-rules.json'),
      join(copyScripts, 'saju', 'relation-rules.json'),
    );
    writeFileSync(join(copyScripts, 'saju', 'rules.json'), '{ not json\n');
    const corruptRules = errResult(runSaju(copyScripts, 'known'));
    assert.equal(corruptRules.status, 1);
    assert.equal(corruptRules.error.code, 'INTERNAL_ERROR');

    // Corrupt relation-rules.json → same contract. rules.json is restored
    // first so this case actually reaches the relation-rules load.
    copyFileSync(join(destScripts, 'saju', 'rules.json'), join(copyScripts, 'saju', 'rules.json'));
    writeFileSync(join(copyScripts, 'saju', 'relation-rules.json'), 'not json\n');
    const corruptRel = errResult(runSaju(copyScripts, 'known'));
    assert.equal(corruptRel.status, 1);
    assert.equal(corruptRel.error.code, 'INTERNAL_ERROR');

    // The pristine install is unaffected by the disposable copy's corruption.
    const pristine = runSaju(destScripts, 'known');
    assert.equal(pristine.status, 0, `pristine install broke: ${pristine.stderr}`);
    assert.equal(JSON.parse(pristine.stdout).schemaVersion, 1);
  } finally {
    cleanup(t, ws);
    cleanup(t, disposable);
  }
});
