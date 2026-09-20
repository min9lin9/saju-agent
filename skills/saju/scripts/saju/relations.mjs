// Nonexclusive saju relation and named special-rule detection.
//
// Input is a list of named pillar occurrences [{id, stem, branch}] - for
// example natal.year/month/day/hour or transit major/annual/monthly/daily
// occurrences. Detection is driven entirely by relation-rules.json (the
// declared kr-civil-midnight-v1 policy tables), never by calendar code, and
// never mutates, merges or deduplicates occurrences: two distinct occurrences
// carrying the same glyph are two distinct participants.
//
// Every emitted record has:
//   ruleId               machine rule identifier
//   occurrenceIds        participating occurrence IDs, sorted lexicographically
//   completion           'complete' | 'partial'
//   transformationStatus always 'not_evaluated' - no 합화/benefit inference
// Optional fields per rule:
//   element              associated element (combinations and triples)
//   subtype              'half' | 'arched_triad' (三合 partials),
//                        'directed_edge' | 'triple' | 'undirected_pair' | 'self'
//                        (punishments)
//   from, to             directed punishment edge orientation (rule direction,
//                        not input order)
//   referenceOccurrenceId, voidBranches   day-xun gongmang records
//
// Output order is deterministic: records sort by ruleId, then occurrenceIds,
// then a canonical serialization tiebreak, so the result is invariant under
// input permutation for fixed occurrence IDs.
//
// Errors carry a machine-readable .code:
//   INVALID_OCCURRENCES / INVALID_OCCURRENCE / DUPLICATE_OCCURRENCE_ID /
//   INVALID_RULE_TABLE
import { readFileSync } from 'node:fs';

export const RELATION_RULES_URL = new URL('./relation-rules.json', import.meta.url);

const STEM_SET = new Set('甲乙丙丁戊己庚辛壬癸');
const BRANCH_SET = new Set('子丑寅卯辰巳午未申酉戌亥');
const BRANCH_INDEX = new Map([...'子丑寅卯辰巳午未申酉戌亥'].map((b, i) => [b, i]));
const STEM_INDEX = new Map([...'甲乙丙丁戊己庚辛壬癸'].map((s, i) => [s, i]));

const fail = (code, message) => {
  const err = new Error(message);
  err.code = code;
  throw err;
};

export function loadRelationRules(url = RELATION_RULES_URL) {
  return JSON.parse(readFileSync(url, 'utf8'));
}

// The default table is immutable after load; cache it so per-candidate
// detectRelations calls do not re-read the file. Explicit `rules` arguments
// bypass the cache entirely.
let defaultRelationRules;
const defaultRules = () => (defaultRelationRules ??= loadRelationRules());

// An occurrence is a day-xun reference when its ID is 'day' or ends in '.day'
// (e.g. natal.day, candidate.0.day). Other suffixes such as daily transit
// pillars are not day-xun references.
const isDayReference = (id) => id === 'day' || id.endsWith('.day');

// Sexagenary index of a stem/branch pair, or -1 when the pair cannot exist in
// the 60-pillar cycle (parity mismatch).
const sexagenaryIndex = (stem, branch) => {
  const s = STEM_INDEX.get(stem);
  const b = BRANCH_INDEX.get(branch);
  for (let i = s; i < 60; i += 10) if (i % 12 === b) return i;
  return -1;
};

const validateOccurrences = (occurrences) => {
  if (!Array.isArray(occurrences)) {
    fail('INVALID_OCCURRENCES', 'occurrences must be an array');
  }
  const seen = new Set();
  for (const occ of occurrences) {
    if (
      occ === null
      || typeof occ !== 'object'
      || typeof occ.id !== 'string'
      || occ.id === ''
      || typeof occ.stem !== 'string'
      || typeof occ.branch !== 'string'
      || !STEM_SET.has(occ.stem)
      || !BRANCH_SET.has(occ.branch)
    ) {
      fail('INVALID_OCCURRENCE', `invalid occurrence: ${JSON.stringify(occ)}`);
    }
    if (seen.has(occ.id)) {
      fail('DUPLICATE_OCCURRENCE_ID', `duplicate occurrence id: ${occ.id}`);
    }
    seen.add(occ.id);
    if (isDayReference(occ.id) && sexagenaryIndex(occ.stem, occ.branch) < 0) {
      fail(
        'INVALID_OCCURRENCE',
        `day-reference occurrence ${occ.id} is not a valid sexagenary pair: ${occ.stem}${occ.branch}`,
      );
    }
  }
};

const validateRuleTables = (rules) => {
  const t = rules && typeof rules === 'object' ? rules.tables : undefined;
  const ok = t !== null
    && typeof t === 'object'
    && Array.isArray(t.stemCombinations)
    && Array.isArray(t.stemClashes)
    && t.branchCombinations !== null
    && typeof t.branchCombinations === 'object'
    && Array.isArray(t.branchCombinations.liuhe)
    && Array.isArray(t.branchCombinations.sanhe)
    && Array.isArray(t.branchCombinations.fanghe)
    && Array.isArray(t.branchClashes)
    && Array.isArray(t.branchBreaks)
    && Array.isArray(t.branchHarms)
    && t.punishments !== null
    && typeof t.punishments === 'object'
    && Array.isArray(t.punishments.directedCycles)
    && Array.isArray(t.punishments.undirected)
    && Array.isArray(t.punishments.selfPunishmentBranches)
    && Array.isArray(t.wonjin)
    && Array.isArray(t.gwimun)
    && t.gongmangByDayXun !== null
    && typeof t.gongmangByDayXun === 'object';
  if (!ok) fail('INVALID_RULE_TABLE', 'rules.tables is missing required relation tables');
  return t;
};

// All unordered pairs of occurrences whose glyph equals `glyph`, grouped by
// the index map produced by groupBy. Returns [occA, occB] tuples.
const sameGlyphPairs = (grouped, glyph) => {
  const list = grouped.get(glyph) ?? [];
  const pairs = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) pairs.push([list[i], list[j]]);
  }
  return pairs;
};

const crossGlyphPairs = (grouped, g1, g2) => {
  const pairs = [];
  for (const a of grouped.get(g1) ?? []) {
    for (const b of grouped.get(g2) ?? []) pairs.push([a, b]);
  }
  return pairs;
};

const sortedIds = (occs) => occs.map((o) => o.id).sort();

const record = (ruleId, occs, completion, extra = {}) => ({
  ruleId,
  occurrenceIds: sortedIds(occs),
  completion,
  ...extra,
  transformationStatus: 'not_evaluated',
});

export function detectRelations(occurrences, rules = defaultRules()) {
  validateOccurrences(occurrences);
  const t = validateRuleTables(rules);

  const byStem = new Map();
  const byBranch = new Map();
  for (const occ of occurrences) {
    if (!byStem.has(occ.stem)) byStem.set(occ.stem, []);
    byStem.get(occ.stem).push(occ);
    if (!byBranch.has(occ.branch)) byBranch.set(occ.branch, []);
    byBranch.get(occ.branch).push(occ);
  }

  const records = [];

  // Unordered pair tables keyed on stems or branches.
  const pairTables = [
    ['stem_combination', t.stemCombinations, byStem, true],
    ['stem_clash', t.stemClashes, byStem, false],
    ['branch_liuhe', t.branchCombinations.liuhe, byBranch, true],
    ['branch_clash', t.branchClashes, byBranch, false],
    ['branch_break', t.branchBreaks, byBranch, false],
    ['branch_harm', t.branchHarms, byBranch, false],
    ['wonjin', t.wonjin, byBranch, false],
    ['gwimun', t.gwimun, byBranch, false],
  ];
  for (const [ruleId, entries, grouped, hasElement] of pairTables) {
    for (const entry of entries) {
      const [g1, g2] = entry.pair ?? entry;
      const extra = hasElement ? { element: entry.element } : {};
      for (const pair of crossGlyphPairs(grouped, g1, g2)) {
        records.push(record(ruleId, pair, 'complete', extra));
      }
    }
  }

  // Triple tables (三合/方合): complete triples plus every two-member subset
  // as a distinct partial record. A 三合 partial requires the triple's middle
  // cardinal branch; without it the subtype is arched_triad, never 半合.
  const tripleTables = [
    ['branch_sanhe', t.branchCombinations.sanhe, true],
    ['branch_fanghe', t.branchCombinations.fanghe, false],
  ];
  for (const [ruleId, entries, isSanhe] of tripleTables) {
    for (const entry of entries) {
      const [b1, b2, b3] = entry.triple;
      for (const o1 of byBranch.get(b1) ?? []) {
        for (const o2 of byBranch.get(b2) ?? []) {
          for (const o3 of byBranch.get(b3) ?? []) {
            records.push(record(ruleId, [o1, o2, o3], 'complete', { element: entry.element }));
          }
        }
      }
      const memberPairs = [[b1, b2], [b1, b3], [b2, b3]];
      for (const [x, y] of memberPairs) {
        for (const pair of crossGlyphPairs(byBranch, x, y)) {
          const extra = { element: entry.element };
          if (isSanhe) extra.subtype = x === b2 || y === b2 ? 'half' : 'arched_triad';
          records.push(record(ruleId, pair, 'partial', extra));
        }
      }
    }
  }

  // Punishments: directed cycle edges, the complete triple independently of
  // present edges, the undirected 子卯 pair, and self-punishment requiring two
  // distinct occurrences of 辰/午/酉/亥.
  for (const cycle of t.punishments.directedCycles) {
    for (let i = 0; i < cycle.length; i += 1) {
      const from = cycle[i];
      const to = cycle[(i + 1) % cycle.length];
      for (const a of byBranch.get(from) ?? []) {
        for (const b of byBranch.get(to) ?? []) {
          records.push(record('punishment', [a, b], 'complete', {
            subtype: 'directed_edge',
            from: a.id,
            to: b.id,
          }));
        }
      }
    }
    const [c1, c2, c3] = cycle;
    for (const o1 of byBranch.get(c1) ?? []) {
      for (const o2 of byBranch.get(c2) ?? []) {
        for (const o3 of byBranch.get(c3) ?? []) {
          records.push(record('punishment', [o1, o2, o3], 'complete', { subtype: 'triple' }));
        }
      }
    }
  }
  for (const [g1, g2] of t.punishments.undirected) {
    for (const pair of crossGlyphPairs(byBranch, g1, g2)) {
      records.push(record('punishment', pair, 'complete', { subtype: 'undirected_pair' }));
    }
  }
  for (const branch of t.punishments.selfPunishmentBranches) {
    for (const pair of sameGlyphPairs(byBranch, branch)) {
      records.push(record('punishment', pair, 'complete', { subtype: 'self' }));
    }
  }

  // Day-xun gongmang: each day-reference occurrence anchors a ten-pillar xun;
  // the record carries the void pair plus every occurrence whose branch is
  // void under that xun (possibly none, possibly another reference).
  for (const occ of occurrences) {
    if (!isDayReference(occ.id)) continue;
    const index = sexagenaryIndex(occ.stem, occ.branch);
    const anchorIndex = index - (index % 10);
    const anchor = `甲${[...BRANCH_INDEX.keys()][anchorIndex % 12]}`;
    const voidBranches = t.gongmangByDayXun[anchor];
    if (!Array.isArray(voidBranches)) {
      fail('INVALID_RULE_TABLE', `gongmangByDayXun has no entry for xun anchor ${anchor}`);
    }
    const matched = occurrences.filter((o) => voidBranches.includes(o.branch));
    records.push(record('gongmang', matched, 'complete', {
      referenceOccurrenceId: occ.id,
      voidBranches: [...voidBranches],
    }));
  }

  records.sort((a, b) => {
    if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
    const ka = a.occurrenceIds.join('');
    const kb = b.occurrenceIds.join('');
    if (ka !== kb) return ka < kb ? -1 : 1;
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
  return records;
}
