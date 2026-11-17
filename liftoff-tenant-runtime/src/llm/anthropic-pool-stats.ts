// Part 5 §F — in-memory ring buffer recording per-Anthropic-pool 429 rate.
//
// Each entry is one HTTP attempt against an Anthropic purpose-group pool;
// `was429` flags whether the attempt was rate-limited. The Anthropic SDK
// retries 429s internally (maxRetries: 2 by default) — this module only
// observes the rate to drive the soft-throttle in delegation-throttle.ts,
// it does NOT add retry logic.

import type { AnthropicPurposeGroup } from '../infrastructure/secrets';

interface Sample { ts: number; was429: boolean }
const RINGS = new Map<AnthropicPurposeGroup, Sample[]>();
const RING_MAX = 1024;   // ~17 minutes of samples at 1 req/s sustained

/** Recorded by AnthropicProvider.complete() around the SDK call: try/catch,
 *  detect 429 via `err.status === 429`, emit one sample per attempt. The
 *  group is already known at provider-pool-selection time inside
 *  LLMClient.complete(). */
export function recordAnthropicAttempt(group: AnthropicPurposeGroup, was429: boolean): void {
  let ring = RINGS.get(group);
  if (!ring) { ring = []; RINGS.set(group, ring); }
  ring.push({ ts: Date.now(), was429 });
  if (ring.length > RING_MAX) ring.shift();
}

/** Fraction of attempts against `group` that 429'd in the last `windowMs`.
 *  Returns 0 when the ring is empty or all samples are older than the
 *  window. Used by delegation-throttle.computeThrottleDelay. */
export function getAnthropicPool429Rate(group: AnthropicPurposeGroup, windowMs: number): number {
  const ring = RINGS.get(group);
  if (!ring || ring.length === 0) return 0;
  const cutoff = Date.now() - windowMs;
  const inWindow = ring.filter(s => s.ts >= cutoff);
  if (inWindow.length === 0) return 0;
  return inWindow.filter(s => s.was429).length / inWindow.length;
}
