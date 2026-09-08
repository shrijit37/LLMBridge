import { describe, it, expect } from 'vitest';
import { canonicalJsonString } from '../src/transform/canonical/index.js';

describe('Canonical JSON Serializer', () => {
  it('serializes primitives correctly', () => {
    expect(canonicalJsonString(null)).toBe('null');
    expect(canonicalJsonString(true)).toBe('true');
    expect(canonicalJsonString(false)).toBe('false');
    expect(canonicalJsonString(42)).toBe('42');
    expect(canonicalJsonString('hello')).toBe('"hello"');
  });

  it('serializes empty objects and arrays', () => {
    expect(canonicalJsonString({})).toBe('{}');
    expect(canonicalJsonString([])).toBe('[]');
  });

  it('recursively sorts keys lexicographically', () => {
    const input = {
      z: 1,
      a: {
        d: 4,
        b: 2,
        c: { f: 6, e: 5 },
      },
      m: [3, 2, 1],
    };

    const result = canonicalJsonString(input);
    expect(result).toBe('{"a":{"b":2,"c":{"e":5,"f":6},"d":4},"m":[3,2,1],"z":1}');
  });

  it('omits undefined properties while preserving null and false', () => {
    const input = {
      b: undefined,
      a: null,
      c: false,
    };
    expect(canonicalJsonString(input)).toBe('{"a":null,"c":false}');
  });
});
