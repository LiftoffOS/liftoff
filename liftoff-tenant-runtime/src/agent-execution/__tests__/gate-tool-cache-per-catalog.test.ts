// The gate's tool list must follow the catalog, not the invocation.
//
// A workflow run does not have one catalog. Each step builds its own, and a step
// that declares `outputField` registers `record_step_output` — a tool no other
// step's catalog contains. Cached once per invocation, the gate's ModelTool[]
// froze as whatever the FIRST gated step happened to see, and every tool
// registered later resolved to undefined.
//
// undefined is not neutral here. `toolIsReadOnly(undefined)` is false, so an
// unresolvable call counts as an effectful write, and on an untrusted-inbound
// run the external_content_write invariant fires.
//
// The failure sequence, on an inbound support email:
//
//   s1 get_thread    → gate runs, cache built from a connector catalog
//   s2 list_messages → same frozen list
//   s3 llm_reason    → mcp__liftoff-tool-gateway__record_step_output
//             gated, reason external_content_write, run paused
//
// The agent asks a human to approve RECORDING A STEP OUTPUT, and never reaches
// the customer reply it was on its way to. `record_step_output` is registered
// `effect: 'read'` precisely to avoid that, and the comment at its registration
// predicts this pause — the classification is never reached, because the tool
// cannot be found to be classified.
//
// Source-level: the cache lives mid-way through runAdapterHitlGate, which needs
// a live gateway, admission service and tenant to enter.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');
const TYPES = readFileSync(join(__dirname, '..', 'types.ts'), 'utf8');

describe('the cache is keyed to the catalog', () => {
  it('rebuilds when the catalog differs, not only when it is unset', () => {
    expect(SRC).toContain('if (!state.cachedModelTools || state.cachedModelToolsSource !== catalog) {');
  });

  it('records which catalog the list was built from', () => {
    expect(SRC).toContain('state.cachedModelToolsSource = catalog;');
    expect(TYPES).toContain('cachedModelToolsSource?: unknown;');
  });

  it('stamps the source before the list, so a throw mid-build cannot leave them disagreeing', () => {
    const assign = SRC.indexOf('state.cachedModelToolsSource = catalog;');
    const build = SRC.indexOf('state.cachedModelTools = [...catalog.tools');
    expect(assign).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(assign);
  });

  it('still caches within a step — identity, not a deep compare', () => {
    // A step builds one catalog object and reuses it for every call it makes, so
    // identity keeps the hit rate that motivated the cache. A deep compare would
    // cost more than the rebuild it avoids.
    expect(SRC).toContain('cachedModelToolsSource !== catalog');
    expect(SRC).not.toContain('JSON.stringify(catalog.tools)');
  });
});

describe('the reasoning is recorded where it was lost', () => {
  const block = SRC.slice(
    SRC.indexOf('// Keyed to the catalog, NOT to the invocation.'),
    SRC.indexOf('if (!state.cachedModelTools || state.cachedModelToolsSource !== catalog) {'),
  );

  it('names the tool and the step type that exposed it', () => {
    expect(block).toContain('record_step_output');
    expect(block).toMatch(/llm_reason/);
  });

  it('explains why a miss gates rather than passes', () => {
    // The trap is that "not found" reads as "unknown", and unknown fails closed.
    expect(block).toMatch(/toolIsReadOnly\(undefined\)/);
    expect(block).toMatch(/effectful external write/i);
  });
});

describe('the in-place comparison gets the normalized identity', () => {
  // `eventData` is the raw vendor payload. event-trigger.ts states why it cannot
  // be compared against: "the raw payload sits a level down under eventData AND
  // spells the same field two ways depending on delivery path" — which is the
  // reason the normalized `message` envelope exists at all.
  //
  // The in-place check reads identifier-shaped fields off the trigger target, so
  // against the raw payload it finds the thread id nested where it does not
  // look, or under a spelling it does not match, and every mail acknowledgement
  // gates anyway.
  //
  // A "Mark email thread <id> as read" call then raises a card even with the
  // carve-out in place, while the same run resolves `{{input.message.threadId}}`
  // correctly — the envelope has the id and only this comparison looks
  // elsewhere.
  // The construction moved into a shared helper, because BOTH checkHitlGate
  // call sites need it and only one built it — the batch path (workflow steps)
  // passed no target at all, so `isInPlaceReply` returned false on its first
  // line and the carve-out was unreachable from the path that actually runs.
  // These assertions follow it rather than the old inline site.
  const block = SRC.slice(
    SRC.indexOf('private buildTriggerTarget('),
    SRC.indexOf('private async executeToolStep('),
  );

  it('spreads the normalized message envelope', () => {
    expect(block).toContain('?.message ?? {}');
  });

  it('spreads it AFTER eventData, so the normalized spelling wins', () => {
    const raw = block.indexOf('?.eventData ?? {}');
    const envelope = block.indexOf('?.message ?? {}');
    expect(raw).toBeGreaterThan(-1);
    expect(envelope).toBeGreaterThan(raw);
  });

  it('still carries the raw payload, so nothing that read it breaks', () => {
    expect(block).toContain('?.eventData ?? {}');
  });

  it('is still built from the run, never from model-supplied params', () => {
    // Unchanged and load-bearing: a model-supplied target would let untrusted
    // content nominate what counts as "in place".
    expect(block).toContain('state.context.trigger.source');
    expect(block).toContain('state.context.inputData');
  });
});
