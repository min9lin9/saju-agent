// install.test.mjs — installed-copy integration for install.sh.
//
// Spawns the real installer (`OPENCLAW_WORKSPACE=<mkdtemp> bash install.sh`)
// via spawnSync with an argv array — never shell string concatenation — and
// asserts only machine-consumed values: exit codes, status/feature tokens in
// installer output, files present/absent at the destination, and the parsed
// JSON of the destination's own CLIs.
//
// Coverage:
//   happy    — isolated temp workspace; installer copies files, runs npm ci,
//              verifies both local features; the DESTINATION's saju.mjs then
//              runs tests/fixtures/saju/requests/known.json (exit 0, contract
//              sections) and natal.mjs runs the astrology baseline input.
//   degraded — PATH without node/npm: provider-only notice is emitted and
//              local readiness is reported UNAVAILABLE, never claimed READY;
//              node_modules must not appear (tar exclusion, no npm ci).
//   preserve — unrelated destination files (profiles.json, stray notes)
//              survive the overlay install.
//
// Determinism: no sleeps, no polling, no ambient clock; every wait is a
// bounded spawnSync process-exit wait. Every temp workspace is removed in
// try/finally with a logged cleanup receipt. No fake npm-success stub: the
// happy path runs the host's real npm ci against the real lockfile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const INSTALLER = join(repoRoot, 'install.sh');
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

const TOP_LEVEL_ORDER = [
  'schemaVersion', 'rulesetId', 'provenance', 'input', 'calendar',
  'natal', 'majorCycles', 'transits', 'limitations',
];

const cleanup = (t, dir) => {
  rmSync(dir, { recursive: true, force: true });
  t.diagnostic(`cleanup receipt: removed ${dir} (exists=${existsSync(dir)})`);
};

test('happy path: installer verifies features; destination CLIs run real fixtures', (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'saju-install-ws-'));
  try {
    // Unrelated destination content that must survive the overlay install.
    const profileFile = join(ws, 'saju', 'profiles.json');
    mkdirSync(dirname(profileFile), { recursive: true });
    writeFileSync(profileFile, '{"people":[]}\n');
    const strayFile = join(ws, 'skills', 'saju', 'user-note.txt');
    mkdirSync(dirname(strayFile), { recursive: true });
    writeFileSync(strayFile, 'keep me\n');

    const install = spawnSync(BASH, [INSTALLER], {
      encoding: 'utf8',
      env: { ...process.env, OPENCLAW_WORKSPACE: ws },
      timeout: 300000,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(install.error, undefined, `spawn error: ${install.error}`);
    assert.equal(
      install.status, 0,
      `install.sh exit ${install.status}\nstdout:\n${install.stdout}\nstderr:\n${install.stderr}`,
    );
    const out = install.stdout;
    // files-copied is reported separately from features-available
    assert.match(out, /files copied/);
    assert.match(out, /feature saju-cli:\s+READY/);
    assert.match(out, /feature natal:\s+READY/);
    assert.match(out, /STATUS: READY/);

    const destScripts = join(ws, 'skills', 'saju', 'scripts');
    // npm ci produced a real node_modules at the destination
    for (const pkg of ['astronomy-engine', 'korean-lunar-calendar']) {
      assert.ok(
        existsSync(join(destScripts, 'node_modules', pkg, 'package.json')),
        `destination node_modules/${pkg} missing — npm ci did not run`,
      );
    }

    // unrelated destination files preserved by the overlay
    assert.equal(readFileSync(profileFile, 'utf8'), '{"people":[]}\n');
    assert.equal(readFileSync(strayFile, 'utf8'), 'keep me\n');

    // The DESTINATION's saju CLI runs the contract fixture.
    const cli = spawnSync(
      process.execPath,
      [join(destScripts, 'saju.mjs'), '--input', join(REQUESTS, 'known.json')],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 },
    );
    assert.equal(cli.error, undefined, `spawn error: ${cli.error}`);
    assert.equal(cli.status, 0, `saju CLI exit ${cli.status}: ${cli.stderr}`);
    const result = JSON.parse(cli.stdout);
    assert.deepEqual(Object.keys(result), TOP_LEVEL_ORDER);
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.rulesetId, 'kr-civil-midnight-v1');
    assert.equal(
      result.natal.candidates[0].pillars.day.ganZhi,
      MANIFEST.fixtures.requests.known.expect.derivedFacts.dayGanZhi,
    );
    assert.equal(result.provenance.packages['astronomy-engine'].resolved, '2.1.19');
    assert.equal(result.provenance.packages['korean-lunar-calendar'].resolved, '0.4.0');

    // The DESTINATION's natal CLI runs the astrology baseline input.
    const natal = spawnSync(
      process.execPath,
      [join(destScripts, 'natal.mjs'), JSON.stringify(BASELINE.natal.input)],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 },
    );
    assert.equal(natal.error, undefined, `spawn error: ${natal.error}`);
    assert.equal(natal.status, 0, `natal exit ${natal.status}: ${natal.stderr}`);
    const chart = JSON.parse(natal.stdout);
    assert.equal(chart.standard, 'ASTROLOGER_V3_TROPICAL_WHOLE_SIGN');
    assert.equal(chart.utcDate, BASELINE.natal.expected.utcDate);
    assert.equal(chart.planets.length, 10);
  } finally {
    cleanup(t, ws);
  }
});

test('degraded path: no node/npm — provider-only notice, local readiness never claimed', (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'saju-install-ws-'));
  const binDir = mkdtempSync(join(tmpdir(), 'saju-install-bin-'));
  try {
    // Isolated PATH: every tool install.sh needs EXCEPT node/npm/openclaw.
    // curl is present so the documented shell-only Shinhan path stays
    // available — that is the degraded mode under test.
    for (const tool of [
      'bash', 'sh', 'cat', 'mkdir', 'tar', 'find', 'sed', 'rm', 'mktemp',
      'dirname', 'curl', 'grep',
    ]) {
      const src = which(tool);
      assert.ok(src, `test requires host tool: ${tool}`);
      symlinkSync(src, join(binDir, tool));
    }

    const install = spawnSync(join(binDir, 'bash'), [INSTALLER], {
      encoding: 'utf8',
      env: { PATH: binDir, HOME: ws, OPENCLAW_WORKSPACE: ws },
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(install.error, undefined, `spawn error: ${install.error}`);
    const out = install.stdout + install.stderr;

    // Files are still copied — that is not the same as features working.
    assert.match(out, /files copied/);
    assert.ok(existsSync(join(ws, 'skills', 'saju', 'scripts', 'saju.mjs')));
    assert.ok(existsSync(join(ws, 'skills', 'saju', 'SKILL.md')));

    // Provider-only notice: the shell-only Shinhan path is the one thing
    // available, and the installer says so explicitly.
    assert.match(out, /STATUS: PROVIDER-ONLY/);
    assert.match(out, /feature provider:\s+AVAILABLE/);

    // Local readiness is reported false — never claimed.
    assert.match(out, /feature saju-cli:\s+UNAVAILABLE/);
    assert.match(out, /feature natal:\s+UNAVAILABLE/);
    assert.doesNotMatch(out, /feature saju-cli:\s+READY/);
    assert.doesNotMatch(out, /feature natal:\s+READY/);
    assert.doesNotMatch(out, /STATUS: READY/);

    // Install itself succeeded (files + provider path); no fake success.
    assert.equal(
      install.status, 0,
      `install.sh exit ${install.status}\noutput:\n${out}`,
    );

    // node_modules must NOT be present: the tar exclusion kept the source's
    // copy out and npm ci never ran — nothing may fake its presence.
    assert.ok(
      !existsSync(join(ws, 'skills', 'saju', 'scripts', 'node_modules')),
      'node_modules must not be copied into the destination',
    );
  } finally {
    cleanup(t, ws);
    cleanup(t, binDir);
  }
});
