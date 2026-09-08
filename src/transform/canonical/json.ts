/**
 * Canonical JSON Serializer
 *
 * Produces a deterministic JSON string with:
 * - Lexicographically sorted object keys at every depth
 * - Preserved array item order
 * - No redundant whitespace around ':' or ','
 * - Empty objects serialized as "{}"
 * - Omission of undefined properties from objects
 *
 * This exact determinism is required for upstream prompt prefix-caching
 * (Claude, GPT, DeepSeek).
 */
export function canonicalJsonString(val: unknown): string {
  if (val === null) {
    return 'null';
  }

  const t = typeof val;
  if (t === 'boolean' || t === 'number') {
    return String(val);
  }

  if (t === 'string') {
    return JSON.stringify(val);
  }

  if (Array.isArray(val)) {
    const items = val.map((item) => canonicalJsonString(item));
    return `[${items.join(',')}]`;
  }

  if (t === 'object') {
    const obj = val as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();

    if (keys.length === 0) {
      return '{}';
    }

    const entries = keys.map(
      (k) => `${JSON.stringify(k)}:${canonicalJsonString(obj[k])}`
    );
    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(val);
}
