// Regression characterization of the legacy astrology runtime.
// Spawns the real skills/saju/scripts/natal.mjs CLI and asserts numeric/parsed
// fields against the retained golden baseline (tests/fixtures/saju/astrology-baseline.json).
// The baseline was captured from the unmodified implementation; it is an
// independently anchored snapshot, not derived from a changed implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const script = join(repoRoot, 'skills', 'saju', 'scripts', 'natal.mjs');
const baseline = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'saju', 'astrology-baseline.json'), 'utf8'),
);

const runCli = (args, input) => {
  const res = spawnSync(process.execPath, [script, ...args, JSON.stringify(input)], {
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(res.status, 0, `natal.mjs exited ${res.status}: ${res.stderr}`);
  assert.equal(res.stderr, '', `unexpected stderr: ${res.stderr}`);
  return JSON.parse(res.stdout);
};

test('natal chart numeric fields match golden baseline', () => {
  const actual = runCli([], baseline.natal.input);
  const expected = baseline.natal.expected;

  assert.equal(actual.standard, expected.standard);
  assert.equal(actual.utcDate, expected.utcDate);

  // Angles: exact longitude / sign / degreeInSign
  assert.equal(actual.angles.length, 2);
  for (const [i, angle] of expected.angles.entries()) {
    assert.equal(actual.angles[i].name, angle.name);
    assert.equal(actual.angles[i].longitude, angle.longitude, `${angle.name} longitude`);
    assert.equal(actual.angles[i].sign, angle.sign);
    assert.equal(actual.angles[i].degreeInSign, angle.degreeInSign);
  }

  // Whole-sign houses
  assert.equal(actual.houses.length, 12);
  for (const [i, h] of expected.houses.entries()) {
    assert.equal(actual.houses[i].house, h.house);
    assert.equal(actual.houses[i].sign, h.sign);
    assert.equal(actual.houses[i].startLongitude, h.startLongitude);
  }

  // Planets: longitude, sign, degreeInSign, house
  assert.equal(actual.planets.length, 10);
  for (const [i, p] of expected.planets.entries()) {
    assert.equal(actual.planets[i].body, p.body);
    assert.equal(actual.planets[i].longitude, p.longitude, `${p.body} longitude`);
    assert.equal(actual.planets[i].sign, p.sign);
    assert.equal(actual.planets[i].degreeInSign, p.degreeInSign);
    assert.equal(actual.planets[i].house, p.house);
  }

  // Aspects: type, body pair, orb
  assert.equal(actual.aspects.length, expected.aspects.length);
  for (const [i, a] of expected.aspects.entries()) {
    assert.deepEqual(
      { type: actual.aspects[i].type, bodyA: actual.aspects[i].bodyA, bodyB: actual.aspects[i].bodyB, orb: actual.aspects[i].orb },
      { type: a.type, bodyA: a.bodyA, bodyB: a.bodyB, orb: a.orb },
    );
  }

  // Full parsed-object equality: every machine-consumed field identical.
  assert.deepEqual(actual, expected);
});

test('synastry score and cross aspects match golden baseline', () => {
  const actual = runCli(['--synastry'], baseline.synastry.input);
  const expected = baseline.synastry.expected;

  assert.equal(actual.score, expected.score);
  assert.equal(actual.aspects.length, expected.aspects.length);
  for (const [i, a] of expected.aspects.entries()) {
    assert.deepEqual(
      { type: actual.aspects[i].type, bodyA: actual.aspects[i].bodyA, bodyB: actual.aspects[i].bodyB, orb: actual.aspects[i].orb },
      { type: a.type, bodyA: a.bodyA, bodyB: a.bodyB, orb: a.orb },
    );
  }
  assert.equal(actual.chartA.utcDate, expected.chartA.utcDate);
  assert.equal(actual.chartB.utcDate, expected.chartB.utcDate);
  assert.deepEqual(actual, expected);
});

test('repeated invocation is deterministic', () => {
  const first = runCli([], baseline.natal.input);
  const second = runCli([], baseline.natal.input);
  assert.deepEqual(second, first);
});
