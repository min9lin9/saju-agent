// Occurrence-level relation and named special-rule detection tests.
//
// Covers every stipulated table in .omo/plans/deterministic-saju.md:
// stem combinations/clashes, branch 六合/三合/方合 (with the arched_triad
// rule), clashes/breaks/harms, directed punishment edges + complete triples +
// undirected pair + self-punishment, wonjin, gwimun and day-xun gongmang.
// Relations are nonexclusive, occurrences are never mutated, no benefit or
// transformation is inferred (transformationStatus is always not_evaluated),
// and output order is invariant under input permutation for fixed IDs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectRelations, loadRelationRules } from '../../skills/saju/scripts/saju/relations.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const fixtureRules = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'saju', 'rules.json'), 'utf8'),
);
const tables = loadRelationRules().tables;

const YANG_BRANCHES = new Set('子寅辰午申戌');
const YANG_STEMS = new Set('甲丙戊庚壬');
// Branch-fixture occurrences carry a parity-valid stem that forms no stem
// relation (甲/乙 never combine or clash), so branch rules are isolated.
const branchOcc = (id, branch) => ({ id, stem: YANG_BRANCHES.has(branch) ? '甲' : '乙', branch });
// Stem-fixture occurrences carry a parity-valid branch that forms no branch
// relation (子/巳 share no pair, subset or punishment rule), isolating stems.
const stemOcc = (id, stem) => ({ id, stem, branch: YANG_STEMS.has(stem) ? '子' : '巳' });
const dayOcc = (id, stem, branch) => ({ id, stem, branch });

const byRule = (records, ruleId) => records.filter((r) => r.ruleId === ruleId);
const only = (records, ruleId) => {
  assert.equal(records.length, 1, JSON.stringify(records));
  assert.equal(records[0].ruleId, ruleId);
  return records[0];
};

const ALLOWED_KEYS = new Set([
  'ruleId', 'occurrenceIds', 'completion', 'element', 'subtype',
  'from', 'to', 'referenceOccurrenceId', 'voidBranches', 'transformationStatus',
]);
const assertCleanRecord = (r) => {
  for (const k of Object.keys(r)) assert.ok(ALLOWED_KEYS.has(k), `unexpected field ${k}`);
  assert.equal(r.transformationStatus, 'not_evaluated');
  assert.deepEqual(r.occurrenceIds, [...r.occurrenceIds].sort());
};

test('runtime rule tables match the independently authored fixture tables', () => {
  const ft = fixtureRules.tables;
  assert.deepEqual(tables.stemCombinations, ft.stemCombinations);
  assert.deepEqual(tables.stemClashes, ft.stemClashes);
  assert.deepEqual(tables.branchCombinations.liuhe, ft.branchCombinations.liuhe);
  assert.deepEqual(tables.branchCombinations.sanhe, ft.branchCombinations.sanhe);
  assert.deepEqual(tables.branchCombinations.fanghe, ft.branchCombinations.fanghe);
  assert.deepEqual(tables.branchClashes, ft.branchClashes);
  assert.deepEqual(tables.branchBreaks, ft.branchBreaks);
  assert.deepEqual(tables.branchHarms, ft.branchHarms);
  assert.deepEqual(tables.punishments.directedCycles, ft.punishments.directedCycles);
  assert.deepEqual(tables.punishments.undirected, ft.punishments.undirected);
  assert.deepEqual(tables.punishments.selfPunishmentBranches, ft.punishments.selfPunishmentBranches);
  assert.deepEqual(tables.wonjin, ft.wonjin);
  assert.deepEqual(tables.gwimun, ft.gwimun);
  assert.deepEqual(tables.gongmangByDayXun, ft.gongmangByDayXun);
});

test('stem combinations: every table pair detected with element, complete, not_evaluated', () => {
  assert.equal(tables.stemCombinations.length, 5);
  for (const { pair: [a, b], element } of tables.stemCombinations) {
    const r = only(detectRelations([stemOcc('x', a), stemOcc('y', b)]), 'stem_combination');
    assert.deepEqual(r.occurrenceIds, ['x', 'y']);
    assert.equal(r.completion, 'complete');
    assert.equal(r.element, element);
    assertCleanRecord(r);
  }
});

test('stem combinations: order-independent, clash pair is a complement negative', () => {
  const r = only(detectRelations([stemOcc('x', '己'), stemOcc('y', '甲')]), 'stem_combination');
  assert.equal(r.element, '土');
  // 甲丙 is neither combination nor clash: zero records.
  assert.deepEqual(detectRelations([stemOcc('x', '甲'), stemOcc('y', '丙')]), []);
  // 甲庚 is a clash, never a combination.
  const clash = detectRelations([stemOcc('x', '甲'), stemOcc('y', '庚')]);
  assert.deepEqual(byRule(clash, 'stem_combination'), []);
});

test('stem clashes: every table pair detected; non-pair negative', () => {
  assert.equal(tables.stemClashes.length, 4);
  for (const [a, b] of tables.stemClashes) {
    const r = only(detectRelations([stemOcc('x', a), stemOcc('y', b)]), 'stem_clash');
    assert.deepEqual(r.occurrenceIds, ['x', 'y']);
    assert.equal(r.completion, 'complete');
    assert.equal('element' in r, false);
    assertCleanRecord(r);
  }
  // 乙丁 is neither clash nor combination.
  assert.deepEqual(detectRelations([stemOcc('x', '乙'), stemOcc('y', '丁')]), []);
});

test('liuhe: every table pair detected with element; clean pairs yield exactly one record', () => {
  const liuhe = tables.branchCombinations.liuhe;
  assert.equal(liuhe.length, 6);
  for (const { pair: [a, b], element } of liuhe) {
    const recs = detectRelations([branchOcc('x', a), branchOcc('y', b)]);
    const found = byRule(recs, 'branch_liuhe');
    assert.equal(found.length, 1, `${a}${b}`);
    assert.deepEqual(found[0].occurrenceIds, ['x', 'y']);
    assert.equal(found[0].element, element);
    assert.equal(found[0].completion, 'complete');
    assertCleanRecord(found[0]);
  }
  // 卯戌 and 辰酉 participate in no other rule: exactly one record total.
  for (const [a, b] of [['卯', '戌'], ['辰', '酉']]) {
    const recs = detectRelations([branchOcc('x', a), branchOcc('y', b)]);
    assert.equal(recs.length, 1, `${a}${b}`);
  }
  // Complement negative: 子寅 is in no table.
  assert.deepEqual(detectRelations([branchOcc('x', '子'), branchOcc('y', '寅')]), []);
});

test('sanhe: every triple complete; two-member subsets partial with cardinal/arched rule', () => {
  const sanhe = tables.branchCombinations.sanhe;
  assert.equal(sanhe.length, 4);
  for (const { triple, element } of sanhe) {
    const [b1, b2, b3] = triple;
    const recs = detectRelations([branchOcc('o1', b1), branchOcc('o2', b2), branchOcc('o3', b3)]);
    const found = byRule(recs, 'branch_sanhe');
    const complete = found.filter((r) => r.completion === 'complete');
    const partial = found.filter((r) => r.completion === 'partial');
    // Nonexclusive: the complete triple and all three two-member subsets coexist.
    assert.equal(complete.length, 1, triple.join(''));
    assert.deepEqual(complete[0].occurrenceIds, ['o1', 'o2', 'o3']);
    assert.equal(complete[0].element, element);
    assert.equal(partial.length, 3, triple.join(''));
    for (const r of found) assertCleanRecord(r);
    // The cardinal branch is the middle member of the stipulated triple.
    const cardinal = b2;
    for (const r of partial) {
      const branches = r.occurrenceIds.map((id) => ({ o1: b1, o2: b2, o3: b3 })[id]);
      assert.equal(r.subtype, branches.includes(cardinal) ? 'half' : 'arched_triad');
    }
  }
});

test('sanhe partials: half vs arched_triad, never complete', () => {
  // 申子 (cardinal 子 present) -> half; 申辰 (no cardinal) -> arched_triad.
  const half = only(detectRelations([branchOcc('a', '申'), branchOcc('b', '子')]), 'branch_sanhe');
  assert.equal(half.completion, 'partial');
  assert.equal(half.subtype, 'half');
  assert.equal(half.element, '水');
  const arched = only(detectRelations([branchOcc('a', '申'), branchOcc('b', '辰')]), 'branch_sanhe');
  assert.equal(arched.completion, 'partial');
  assert.equal(arched.subtype, 'arched_triad');
  // Two occurrences of the same triple branch are not a subset pair.
  assert.deepEqual(detectRelations([branchOcc('a', '申'), branchOcc('b', '申')]), []);
  // 申午 belongs to no pair table and no triple subset.
  assert.deepEqual(detectRelations([branchOcc('a', '申'), branchOcc('b', '午')]), []);
});

test('fanghe: every triple complete; any two-member subset is partial without subtype', () => {
  const fanghe = tables.branchCombinations.fanghe;
  assert.equal(fanghe.length, 4);
  for (const { triple, element } of fanghe) {
    const [b1, b2, b3] = triple;
    const recs = detectRelations([branchOcc('o1', b1), branchOcc('o2', b2), branchOcc('o3', b3)]);
    const found = byRule(recs, 'branch_fanghe');
    assert.equal(found.filter((r) => r.completion === 'complete').length, 1, triple.join(''));
    assert.equal(found.filter((r) => r.completion === 'partial').length, 3, triple.join(''));
    assert.equal(found[0].element, element);
    for (const r of found) {
      assert.equal('subtype' in r, false, 'fanghe partials carry no half/arched subtype');
      assertCleanRecord(r);
    }
  }
  // A lone two-member subset (no cardinal requirement for 方合).
  const r = only(
    detectRelations([branchOcc('a', '巳'), branchOcc('b', '未')]),
    'branch_fanghe',
  );
  assert.equal(r.completion, 'partial');
  assert.equal(r.element, '火');
});

test('branch clashes: every table pair detected; 子午 is only a clash', () => {
  assert.equal(tables.branchClashes.length, 6);
  for (const [a, b] of tables.branchClashes) {
    const found = byRule(detectRelations([branchOcc('x', a), branchOcc('y', b)]), 'branch_clash');
    assert.equal(found.length, 1, `${a}${b}`);
    assert.deepEqual(found[0].occurrenceIds, ['x', 'y']);
    assertCleanRecord(found[0]);
  }
  const recs = detectRelations([branchOcc('x', '子'), branchOcc('y', '午')]);
  assert.deepEqual(recs.map((r) => r.ruleId), ['branch_clash']);
});

test('branch breaks: every table pair detected; 卯午 is only a break', () => {
  assert.equal(tables.branchBreaks.length, 6);
  for (const [a, b] of tables.branchBreaks) {
    const found = byRule(detectRelations([branchOcc('x', a), branchOcc('y', b)]), 'branch_break');
    assert.equal(found.length, 1, `${a}${b}`);
    assertCleanRecord(found[0]);
  }
  const recs = detectRelations([branchOcc('x', '卯'), branchOcc('y', '午')]);
  assert.deepEqual(recs.map((r) => r.ruleId), ['branch_break']);
});

test('branch harms: every table pair detected; 申亥 is only a harm', () => {
  assert.equal(tables.branchHarms.length, 6);
  for (const [a, b] of tables.branchHarms) {
    const found = byRule(detectRelations([branchOcc('x', a), branchOcc('y', b)]), 'branch_harm');
    assert.equal(found.length, 1, `${a}${b}`);
    assertCleanRecord(found[0]);
  }
  const recs = detectRelations([branchOcc('x', '申'), branchOcc('y', '亥')]);
  assert.deepEqual(recs.map((r) => r.ruleId), ['branch_harm']);
});

test('punishments: every directed edge of both cycles with from/to orientation', () => {
  for (const cycle of tables.punishments.directedCycles) {
    for (let i = 0; i < cycle.length; i += 1) {
      const from = cycle[i];
      const to = cycle[(i + 1) % cycle.length];
      const recs = detectRelations([branchOcc('x', from), branchOcc('y', to)]);
      const edges = byRule(recs, 'punishment').filter((r) => r.subtype === 'directed_edge');
      assert.equal(edges.length, 1, `${from}->${to}`);
      assert.equal(edges[0].from, 'x');
      assert.equal(edges[0].to, 'y');
      assert.deepEqual(edges[0].occurrenceIds, ['x', 'y']);
      assertCleanRecord(edges[0]);
    }
  }
  // Orientation follows the rule, not input order: 巳 then 寅 still yields 寅->巳.
  const recs = detectRelations([branchOcc('x', '巳'), branchOcc('y', '寅')]);
  const edge = byRule(recs, 'punishment').find((r) => r.subtype === 'directed_edge');
  assert.equal(edge.from, 'y');
  assert.equal(edge.to, 'x');
  // 巳丑 belongs to no directed cycle and no other punishment rule.
  assert.deepEqual(
    byRule(detectRelations([branchOcc('x', '巳'), branchOcc('y', '丑')]), 'punishment'),
    [],
  );
});

test('punishments: complete triple recorded independently of present edges', () => {
  for (const cycle of tables.punishments.directedCycles) {
    const recs = detectRelations(cycle.map((b, i) => branchOcc(`o${i}`, b)));
    const p = byRule(recs, 'punishment');
    assert.equal(p.filter((r) => r.subtype === 'directed_edge').length, 3, cycle.join(''));
    const triples = p.filter((r) => r.subtype === 'triple');
    assert.equal(triples.length, 1, cycle.join(''));
    assert.deepEqual(triples[0].occurrenceIds, ['o0', 'o1', 'o2']);
    assert.equal(triples[0].completion, 'complete');
  }
  // Two members of a cycle: edge only, no triple record.
  const recs = detectRelations([branchOcc('a', '丑'), branchOcc('b', '戌')]);
  const p = byRule(recs, 'punishment');
  assert.equal(p.length, 1);
  assert.equal(p[0].subtype, 'directed_edge');
});

test('punishments: undirected 子卯 pair and self-punishment distinct-occurrence rule', () => {
  const u = only(detectRelations([branchOcc('a', '子'), branchOcc('b', '卯')]), 'punishment');
  assert.equal(u.subtype, 'undirected_pair');
  assertCleanRecord(u);
  // Lone occurrence never self-punishes; two distinct occurrences do.
  for (const branch of tables.punishments.selfPunishmentBranches) {
    assert.deepEqual(detectRelations([branchOcc('a', branch)]), [], `lone ${branch}`);
    const recs = detectRelations([branchOcc('a', branch), branchOcc('b', branch)]);
    const self = byRule(recs, 'punishment').filter((r) => r.subtype === 'self');
    assert.equal(self.length, 1, branch);
    assert.deepEqual(self[0].occurrenceIds, ['a', 'b']);
  }
  // Three 辰 occurrences yield C(3,2) self-punishment records.
  const three = detectRelations([branchOcc('a', '辰'), branchOcc('b', '辰'), branchOcc('c', '辰')]);
  assert.equal(byRule(three, 'punishment').filter((r) => r.subtype === 'self').length, 3);
  // Duplicated non-self branch is not a punishment.
  assert.deepEqual(detectRelations([branchOcc('a', '寅'), branchOcc('b', '寅')]), []);
});

test('wonjin: every table pair detected; 寅酉 is wonjin only, not gwimun', () => {
  assert.equal(tables.wonjin.length, 6);
  for (const [a, b] of tables.wonjin) {
    const found = byRule(detectRelations([branchOcc('x', a), branchOcc('y', b)]), 'wonjin');
    assert.equal(found.length, 1, `${a}${b}`);
    assertCleanRecord(found[0]);
  }
  const recs = detectRelations([branchOcc('x', '寅'), branchOcc('y', '酉')]);
  assert.deepEqual(recs.map((r) => r.ruleId), ['wonjin']);
});

test('gwimun: every table pair detected; 寅未 is gwimun only, not wonjin', () => {
  assert.equal(tables.gwimun.length, 6);
  for (const [a, b] of tables.gwimun) {
    const found = byRule(detectRelations([branchOcc('x', a), branchOcc('y', b)]), 'gwimun');
    assert.equal(found.length, 1, `${a}${b}`);
    assertCleanRecord(found[0]);
  }
  const recs = detectRelations([branchOcc('x', '寅'), branchOcc('y', '未')]);
  assert.deepEqual(recs.map((r) => r.ruleId), ['gwimun']);
});

test('gongmang: every day-xun anchor emits its void pair', () => {
  const expected = tables.gongmangByDayXun;
  const anchors = ['甲子', '甲戌', '甲申', '甲午', '甲辰', '甲寅'];
  assert.deepEqual(Object.keys(expected).sort(), anchors.slice().sort());
  for (const gz of anchors) {
    const g = only(detectRelations([dayOcc('natal.day', gz[0], gz[1])]), 'gongmang');
    assert.equal(g.referenceOccurrenceId, 'natal.day');
    assert.deepEqual(g.voidBranches, expected[gz]);
    assert.deepEqual(g.occurrenceIds, []);
    assert.equal(g.completion, 'complete');
    assertCleanRecord(g);
  }
  // A non-甲 day stem resolves through its xun: 丁卯 sits in the 甲子 xun.
  const g = only(detectRelations([dayOcc('natal.day', '丁', '卯')]), 'gongmang');
  assert.deepEqual(g.voidBranches, ['戌', '亥']);
});

test('gongmang: matched occurrence IDs, no day reference, invalid day pillar', () => {
  const recs = detectRelations([
    dayOcc('natal.day', '甲', '子'),
    branchOcc('y', '戌'),
    branchOcc('h', '亥'),
    branchOcc('m', '寅'),
  ]);
  const g = only(byRule(recs, 'gongmang'), 'gongmang');
  assert.deepEqual(g.occurrenceIds, ['h', 'y']);
  assert.deepEqual(g.voidBranches, ['戌', '亥']);
  // No day-reference occurrence -> no gongmang record at all.
  assert.deepEqual(
    byRule(detectRelations([branchOcc('a', '戌'), branchOcc('b', '亥')]), 'gongmang'),
    [],
  );
  // A day-reference occurrence must be a valid sexagenary pair.
  assert.throws(
    () => detectRelations([{ id: 'natal.day', stem: '甲', branch: '丑' }]),
    (e) => e.code === 'INVALID_OCCURRENCE',
  );
  // Multiple day references (boundary candidates) each emit their own record;
  // one candidate's branch can be another's void target.
  const multi = detectRelations([
    dayOcc('cand.0.day', '甲', '子'),
    dayOcc('cand.1.day', '甲', '戌'),
  ]);
  const gm = byRule(multi, 'gongmang');
  assert.equal(gm.length, 2);
  const forCand0 = gm.find((r) => r.referenceOccurrenceId === 'cand.0.day');
  const forCand1 = gm.find((r) => r.referenceOccurrenceId === 'cand.1.day');
  assert.deepEqual(forCand0.voidBranches, ['戌', '亥']);
  assert.deepEqual(forCand0.occurrenceIds, ['cand.1.day']);
  assert.deepEqual(forCand1.voidBranches, ['申', '酉']);
  assert.deepEqual(forCand1.occurrenceIds, []);
});

test('nonexclusive overlaps: 寅亥, 丑午, 卯申, 巳申 carry every applicable rule', () => {
  assert.deepEqual(
    detectRelations([branchOcc('a', '寅'), branchOcc('b', '亥')]).map((r) => r.ruleId).sort(),
    ['branch_break', 'branch_liuhe'],
  );
  assert.deepEqual(
    detectRelations([branchOcc('a', '丑'), branchOcc('b', '午')]).map((r) => r.ruleId).sort(),
    ['branch_harm', 'gwimun', 'wonjin'],
  );
  assert.deepEqual(
    detectRelations([branchOcc('a', '卯'), branchOcc('b', '申')]).map((r) => r.ruleId).sort(),
    ['gwimun', 'wonjin'],
  );
  const shin = detectRelations([branchOcc('a', '巳'), branchOcc('b', '申')]);
  assert.deepEqual(shin.map((r) => r.ruleId).sort(), ['branch_break', 'branch_liuhe', 'punishment']);
  assert.equal(shin.find((r) => r.ruleId === 'punishment').subtype, 'directed_edge');
});

test('same-glyph occurrences are not deduplicated', () => {
  const recs = detectRelations([branchOcc('a', '子'), branchOcc('b', '子'), branchOcc('c', '丑')]);
  const l = byRule(recs, 'branch_liuhe');
  assert.equal(l.length, 2);
  assert.deepEqual(l.map((r) => r.occurrenceIds), [['a', 'c'], ['b', 'c']]);
});

test('output is invariant under input permutation with fixed occurrence IDs', () => {
  const occs = [
    dayOcc('natal.day', '甲', '子'),
    { id: 'natal.year', stem: '庚', branch: '申' },
    { id: 'natal.month', stem: '丙', branch: '辰' },
    { id: 'natal.hour', stem: '辛', branch: '酉' },
    { id: 'major.1', stem: '己', branch: '亥' },
    { id: 'annual.2026', stem: '丙', branch: '午' },
  ];
  const base = detectRelations(occs);
  assert.ok(base.length > 10, 'fixture should exercise many rules');
  assert.deepEqual(detectRelations([...occs].reverse()), base);
  const shuffled = [occs[3], occs[0], occs[5], occs[1], occs[4], occs[2]];
  assert.deepEqual(detectRelations(shuffled), base);
  // Records are sorted by ruleId then occurrenceIds.
  for (let i = 1; i < base.length; i += 1) {
    const prev = base[i - 1];
    const cur = base[i];
    const cmp = prev.ruleId === cur.ruleId
      ? prev.occurrenceIds.join('').localeCompare(cur.occurrenceIds.join(''))
      : prev.ruleId.localeCompare(cur.ruleId);
    assert.ok(cmp <= 0, `${prev.ruleId} before ${cur.ruleId}`);
  }
  for (const r of base) assertCleanRecord(r);
});

test('input occurrences are never mutated', () => {
  const occs = Object.freeze([
    Object.freeze(branchOcc('a', '寅')),
    Object.freeze(branchOcc('b', '亥')),
  ]);
  const recs = detectRelations(occs);
  assert.equal(recs.length, 2);
  assert.deepEqual(occs[0], { id: 'a', stem: '甲', branch: '寅' });
});

test('validation: duplicate IDs, invalid glyphs, non-array, missing rule tables', () => {
  assert.throws(
    () => detectRelations([branchOcc('a', '子'), branchOcc('a', '丑')]),
    (e) => e.code === 'DUPLICATE_OCCURRENCE_ID',
  );
  assert.throws(
    () => detectRelations([{ id: 'a', stem: 'X', branch: '子' }]),
    (e) => e.code === 'INVALID_OCCURRENCE',
  );
  assert.throws(
    () => detectRelations([{ id: 'a', stem: '甲', branch: 'X' }]),
    (e) => e.code === 'INVALID_OCCURRENCE',
  );
  assert.throws(
    () => detectRelations([{ id: 'a' }]),
    (e) => e.code === 'INVALID_OCCURRENCE',
  );
  assert.throws(
    () => detectRelations('nope'),
    (e) => e.code === 'INVALID_OCCURRENCES',
  );
  assert.throws(
    () => detectRelations([], { tables: { stemCombinations: [] } }),
    (e) => e.code === 'INVALID_RULE_TABLE',
  );
  assert.deepEqual(detectRelations([]), []);
});

test('detection is rule-table driven, not hardcoded', () => {
  const custom = loadRelationRules();
  custom.tables.stemCombinations = custom.tables.stemCombinations.filter(
    (e) => e.pair.join('') !== '甲己',
  );
  assert.deepEqual(
    byRule(detectRelations([stemOcc('x', '甲'), stemOcc('y', '己')], custom), 'stem_combination'),
    [],
  );
  // Explicit rules argument equals the default-loaded tables.
  assert.deepEqual(
    detectRelations([branchOcc('a', '寅'), branchOcc('b', '亥')], loadRelationRules()),
    detectRelations([branchOcc('a', '寅'), branchOcc('b', '亥')]),
  );
});
