// Numerical tolerance helpers for contract-level comparisons between
// the legacy in-platform-backend path and the extracted service. Keeps
// the equivalence test asserting meaningful equality rather than
// byte-identity.

/** Compare two currency amounts, both in int64 cents (represented as bigint). */
export function currencyEqualsToCents(a: bigint, b: bigint): boolean {
  return a === b;
}

/**
 * Compare two percentage values expressed as basis points (bps),
 * tolerating one bps of drift (0.01 %).
 */
export function percentageEqualsWithinBps(a: number, b: number, toleranceBps = 1): boolean {
  return Math.abs(a - b) <= toleranceBps;
}

/**
 * Parse any ISO-8601 timestamp into a stable UTC epoch-ms number.
 * Useful for comparing timestamps that may round-trip through different
 * serializers (Date, string, protobuf Timestamp). Throws on unparseable
 * input rather than returning NaN.
 */
export function normalizeTimestampToUtcMs(value: string | number | Date): number {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) throw new Error('normalizeTimestampToUtcMs: invalid Date');
    return ms;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('normalizeTimestampToUtcMs: non-finite number');
    return value;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`normalizeTimestampToUtcMs: unparseable string "${value}"`);
  }
  return parsed;
}

/**
 * Compare two timestamps after UTC-normalization, tolerating clock-
 * skew / serializer rounding up to the supplied delta (default: 1 ms).
 */
export function timestampEqualsWithinMs(
  a: string | number | Date,
  b: string | number | Date,
  toleranceMs = 1,
): boolean {
  const ma = normalizeTimestampToUtcMs(a);
  const mb = normalizeTimestampToUtcMs(b);
  return Math.abs(ma - mb) <= toleranceMs;
}

/**
 * Compare two floating-point token costs (micros = 10^-6 USD).
 * Asserts equality within `toleranceMicros` to absorb rounding between
 * vendor SDK responses and Stripe's own rounding.
 */
export function tokenCostEqualsWithinMicros(
  a: bigint,
  b: bigint,
  toleranceMicros = 0n,
): boolean {
  const diff = a > b ? a - b : b - a;
  return diff <= toleranceMicros;
}

/**
 * Structural deep-equal, with field-aware tolerances. Use for the
 * historical-replay comparator in billing, where formats differ
 * slightly between the old and new path.
 */
export interface FieldTolerance {
  /** Dot-path from root (`items.0.amountCents`). */
  path: string;
  kind: 'currency' | 'percentage-bps' | 'timestamp-ms' | 'cost-micros';
  tolerance?: number | bigint;
}

export interface StructuralDiffResult {
  equal: boolean;
  mismatches: Array<{ path: string; leftValue: unknown; rightValue: unknown; reason: string }>;
}

export function structuralDiff(
  left: unknown,
  right: unknown,
  tolerances: FieldTolerance[] = [],
): StructuralDiffResult {
  const mismatches: StructuralDiffResult['mismatches'] = [];
  const toleranceMap = new Map(tolerances.map((t) => [t.path, t]));

  function walk(l: unknown, r: unknown, path: string) {
    const tolerance = toleranceMap.get(path);
    if (tolerance) {
      if (!applyTolerance(l, r, tolerance)) {
        mismatches.push({ path, leftValue: l, rightValue: r, reason: `${tolerance.kind} drift` });
      }
      return;
    }
    if (Array.isArray(l) && Array.isArray(r)) {
      if (l.length !== r.length) {
        mismatches.push({ path, leftValue: l, rightValue: r, reason: 'array length' });
        return;
      }
      for (let i = 0; i < l.length; i++) walk(l[i], r[i], `${path}.${i}`);
      return;
    }
    if (isPlainObject(l) && isPlainObject(r)) {
      const keys = new Set([...Object.keys(l), ...Object.keys(r)]);
      for (const k of keys) walk(l[k], r[k], path ? `${path}.${k}` : k);
      return;
    }
    if (l !== r) {
      mismatches.push({ path, leftValue: l, rightValue: r, reason: 'value mismatch' });
    }
  }

  walk(left, right, '');
  return { equal: mismatches.length === 0, mismatches };
}

function applyTolerance(l: unknown, r: unknown, t: FieldTolerance): boolean {
  switch (t.kind) {
    case 'currency':
      return currencyEqualsToCents(asBigint(l), asBigint(r));
    case 'percentage-bps':
      return percentageEqualsWithinBps(asNumber(l), asNumber(r), Number(t.tolerance ?? 1));
    case 'timestamp-ms':
      return timestampEqualsWithinMs(
        l as string | number | Date,
        r as string | number | Date,
        Number(t.tolerance ?? 1),
      );
    case 'cost-micros':
      return tokenCostEqualsWithinMicros(asBigint(l), asBigint(r), BigInt(t.tolerance ?? 0));
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asBigint(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string') return BigInt(v);
  throw new Error(`asBigint: cannot coerce ${typeof v}`);
}

function asNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  throw new Error(`asNumber: cannot coerce ${typeof v}`);
}
