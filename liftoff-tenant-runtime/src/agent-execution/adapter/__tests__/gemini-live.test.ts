// Live Vertex integration smoke test for the GeminiAdapter.
//
// SKIPPED by default. Opt in with:
//   LIVE_VERTEX=true GCP_PROJECT_ID=<project> npx jest gemini-live
//
// Validates the empirically-resolved Vertex `global` endpoint serves a
// Gemini 3 model end-to-end for the configured GCP project — the assumption
// baked into adapter/gemini/index.ts:DEFAULT_LOCATION. If Google shifts the
// region rollout, this fails first and the env-var override path is exercised
// before any tenant agent hits the failure in prod.
//
// Authentication uses Application Default Credentials. On a developer machine:
//   gcloud auth application-default login
// On CI/Cloud Run, the runner SA's identity is picked up automatically.
//
// Cost: a single generateContentStream call with a tiny prompt. Bounded by
// the model's per-call min cost; runs in a few seconds.

import { GeminiAdapter } from '../gemini';
import type { InvocationInput, InvocationEvent } from '../types';
import type { McpToolCatalog } from '../catalog-types';

const live = process.env.LIVE_VERTEX === 'true';
const describeLive = live ? describe : describe.skip;

// Gemini 3 is required — built-in tools coexist with custom functionDeclarations
// only on 3.x. The model id is intentionally pinned to the same one referenced
// in cross-adapter-equivalence.test.ts and the canonical adapter docstring.
const MODEL = process.env.LIVE_VERTEX_MODEL ?? 'gemini-3-pro-preview';

function makeEmptyCatalog(): McpToolCatalog {
  return { servers: [], tools: [] };
}

function makeInput(): InvocationInput {
  return {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Reply with exactly the word OK.' }] },
    ],
    systemPrompt: 'You are a deterministic test responder. Output only what the user asks for.',
    model: MODEL,
    provider: 'google',
    tenantId: 'live-test',
    invocationId: `live-${Date.now()}`,
    maxTurns: 1,
  };
}

async function drain(it: AsyncIterable<InvocationEvent>): Promise<InvocationEvent[]> {
  const out: InvocationEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describeLive('GeminiAdapter — live Vertex smoke (LIVE_VERTEX=true)', () => {
  // Vertex generateContentStream can take several seconds end-to-end.
  jest.setTimeout(60_000);

  it('completes a minimal generateContentStream call against the global endpoint', async () => {
    if (!process.env.GCP_PROJECT_ID && !process.env.GOOGLE_CLOUD_PROJECT) {
      throw new Error('GCP_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) must be set for LIVE_VERTEX run');
    }

    const adapter = new GeminiAdapter();
    adapter.registerToolCatalog(makeEmptyCatalog());
    const events = await drain(adapter.invoke(makeInput(), new AbortController().signal));

    // Contract assertions — the platform-visible behavior every adapter must
    // honor end-to-end:

    // 1. Stream emits at least one assistant_delta (the streaming surface).
    const deltas = events.filter(e => e.type === 'assistant_delta');
    expect(deltas.length).toBeGreaterThan(0);

    // 2. A terminal assistant_message of the concatenation arrives.
    const terminalMsg = events.find(e => e.type === 'assistant_message');
    expect(terminalMsg).toBeDefined();

    // 3. A usage event with positive token counts is published. This proves
    //    the billing-attribution path is live (publishInvocationCompleted
    //    depends on these counts being non-zero on every provider).
    const usage = events.find(e => e.type === 'usage') as Extract<InvocationEvent, { type: 'usage' }> | undefined;
    expect(usage).toBeDefined();
    expect(usage!.usage.inputTokens).toBeGreaterThan(0);
    expect(usage!.usage.outputTokens).toBeGreaterThan(0);

    // 4. Completion event arrives with outcome 'success' — not 'error' from
    //    an abnormal finishReason, not absent.
    const completion = events.at(-1) as Extract<InvocationEvent, { type: 'completion' }>;
    expect(completion.type).toBe('completion');
    expect(completion.outcome).toBe('success');

    // 5. No anomaly events fired (would indicate SAFETY / RECITATION /
    //    MALFORMED_FUNCTION_CALL etc. — symptomatic of a region or model
    //    mismatch we want to catch before it reaches a tenant agent).
    expect(events.some(e => e.type === 'anomaly_detected')).toBe(false);
  });
});
