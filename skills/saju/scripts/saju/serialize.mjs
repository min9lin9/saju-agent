// serialize.mjs — deterministic serialization for the saju result contract.
//
// Two exports:
//   canonicalStringify(value)  stable-stringify-v1: recursive key-sorted
//                              compact JSON. Used for rule-table SHA256
//                              provenance and limitation dedupe keys.
//   serializeResult(result)    the public result document: top-level keys
//                              pinned to the contract order
//                              {schemaVersion, rulesetId, provenance, input,
//                              calendar, natal, majorCycles, transits,
//                              limitations}, nested keys in construction
//                              order, two-space indent, single trailing
//                              newline. Byte-identical for identical input
//                              and provenance: no Date.now, Math.random or
//                              any ambient input exists anywhere in the
//                              pipeline.
//
// A result whose top-level keys do not match the contract exactly is a
// SerializeError — the serializer is the last contract guard, not a
// normalizer that would silently reorder or drop fields.

export class SerializeError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'SerializeError';
    this.code = code;
    this.path = path;
  }
}

export const RESULT_KEY_ORDER = [
  'schemaVersion',
  'rulesetId',
  'provenance',
  'input',
  'calendar',
  'natal',
  'majorCycles',
  'transits',
  'limitations',
];

export const CANONICALIZATION_ID = 'stable-stringify-v1';

// Recursive key-sorted compact JSON. Object keys sort by code unit; arrays
// keep order; numbers serialize via JSON (all values in this pipeline are
// integers or exact-ratio doubles); undefined is normalized to null so a
// missing optional field cannot change a dedupe key or a hash.
export const canonicalStringify = (value) => {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const body = keys
      .map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`)
      .join(',');
    return `{${body}}`;
  }
  throw new SerializeError(
    'UNSERIALIZABLE_VALUE', '$', `cannot canonicalize ${typeof value}`,
  );
};

// Serializes the assembled result object. Top-level keys are emitted in
// RESULT_KEY_ORDER; any missing or extra top-level key is a contract
// violation. Nested objects keep their construction order (every producer
// in this pipeline builds fields in a fixed order).
export const serializeResult = (result) => {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new SerializeError('RESULT_CONTRACT_VIOLATION', '$', 'result must be an object');
  }
  const keys = Object.keys(result);
  const expected = new Set(RESULT_KEY_ORDER);
  for (const key of keys) {
    if (!expected.has(key)) {
      throw new SerializeError(
        'RESULT_CONTRACT_VIOLATION', key, `unexpected top-level field: ${key}`,
      );
    }
  }
  for (const key of RESULT_KEY_ORDER) {
    if (!(key in result)) {
      throw new SerializeError(
        'RESULT_CONTRACT_VIOLATION', key, `missing top-level field: ${key}`,
      );
    }
  }
  const ordered = {};
  for (const key of RESULT_KEY_ORDER) ordered[key] = result[key];
  return `${JSON.stringify(ordered, null, 2)}\n`;
};
