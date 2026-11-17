// Unit tests for the cross-service canonical hash contract used by
// sync-state's triggerConfigHash + instructionsHash.
//
// PB's reconciler computes the same sha256(canonicalize(...)) values
// against its source-of-truth columns and compares them to these. Any
// non-canonical serialization (key insertion order, whitespace, undefined
// vs null) breaks drift detection silently — every mismatch would look
// like a legitimate stale_content event and trigger churn. These tests
// pin the invariants.

import { canonicalize } from '../sync-state-router';

describe('canonicalize', () => {
  it('renders null and undefined as the literal string "null"', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(undefined)).toBe('null');
  });

  it('renders primitives via JSON.stringify', () => {
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize('hi')).toBe('"hi"');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(false)).toBe('false');
  });

  it('sorts object keys alphabetically — insertion order is ignored', () => {
    const a = canonicalize({ b: 1, a: 2, c: 3 });
    const b = canonicalize({ a: 2, c: 3, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it('recurses into nested objects with stable key order', () => {
    const a = canonicalize({ outer: { z: 1, a: 2 }, alpha: { y: 3, b: 4 } });
    const b = canonicalize({ alpha: { b: 4, y: 3 }, outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  it('preserves array order (positional, not associative)', () => {
    expect(canonicalize([1, 2, 3])).toBe('[1,2,3]');
    expect(canonicalize([3, 2, 1])).toBe('[3,2,1]');
    // Arrays of objects: each element canonicalizes independently.
    expect(canonicalize([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it('produces identical output for two trigger_config payloads that differ only in key order', () => {
    const fromPb = { type: 'event', eventTopic: 'email.received', companionCrons: [] };
    const fromJsonbReadback = { eventTopic: 'email.received', companionCrons: [], type: 'event' };
    expect(canonicalize(fromPb)).toBe(canonicalize(fromJsonbReadback));
  });

  it('detects content differences (not just shape)', () => {
    const eventConfig = { type: 'event', eventTopic: 'email.received' };
    const cronConfig = { type: 'cron', cronExpr: '*/1 * * * *' };
    expect(canonicalize(eventConfig)).not.toBe(canonicalize(cronConfig));
  });

  it('treats {field: null} differently from {} so the hash catches "field cleared"', () => {
    expect(canonicalize({ a: null })).toBe('{"a":null}');
    expect(canonicalize({})).toBe('{}');
    expect(canonicalize({ a: null })).not.toBe(canonicalize({}));
  });
});
