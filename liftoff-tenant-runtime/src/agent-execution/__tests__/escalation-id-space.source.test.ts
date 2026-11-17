// The escalation notify path must cross the TR→PB boundary in the
// control-plane id space.
//
// ExecutionContext.agentId is a runtime-space id; internal_agents on the
// control plane is keyed by a DIFFERENT id, and the two are linked only through
// internal_agent_runtime_mapping (INV-TR-010 / ADR-039). Both are plain UUID
// strings, so a wrong-space id type-checks, validates, and matches zero rows
// with no error — and the recipient fallback then masks the miss completely.
// Table reads are covered by the resolver's own call sites; an HTTP boundary
// has no such guard, so this test pins the boundary itself: the payload
// carries the id under the NAME the contract requires, fed from the strict
// reverse resolver.
//
// Same idiom as the other *.source tests — the modules pull DB transitively, so
// assert the source.

import { readFileSync } from 'fs';
import { join } from 'path';

const HELPER = readFileSync(
  join(__dirname, '..', 'engine', 'escalation-helper.ts'), 'utf8');
const CLIENT = readFileSync(
  join(__dirname, '..', '..', 'platform-callback', 'client.ts'), 'utf8');

describe('escalation notify crosses the boundary in the control-plane id space', () => {
  it('the payload type declares internalAgentId', () => {
    const typeBlock = CLIENT.slice(
      CLIENT.indexOf('EnqueueEscalationNotificationInput'),
      CLIENT.indexOf('enqueueEscalationNotification('),
    );
    expect(typeBlock).toContain('internalAgentId: string | null');
  });

  it('the helper resolves through internal_agent_runtime_mapping, not a raw context id', () => {
    expect(HELPER).toContain('resolveInternalAgentId');
    expect(HELPER).toMatch(/internalAgentId,?\s*\n/);
  });

  it('the resolver is the strict reverse-direction one', () => {
    // resolveRuntimeAgentId (the lenient, forward-direction helper) falls back
    // to the input id — which for a PB query would reintroduce the exact bug.
    expect(HELPER).not.toContain('resolveRuntimeAgentId');
  });

  it('per ADR-039, an agent reference in a TR→PB payload is named internalAgentId', () => {
    // The guard for the class, scoped to what is mechanically checkable: any
    // payload interface in the platform-callback client that references an
    // agent must use the internalAgentId field name, so the id space is visible
    // at the boundary instead of hidden behind a bare `agentId`. Interfaces
    // that still carry agentId for compatibility must ALSO carry
    // internalAgentId.
    const interfaces = CLIENT.split(/export interface /).slice(1);
    const offenders = interfaces
      .filter(block => /\bagentId\??: string/.test(block))
      .filter(block => !/\binternalAgentId\??: string/.test(block))
      .map(block => block.slice(0, block.indexOf(' ')));
    // Frozen debt: EnqueueNotificationViaCallbackInput's payload.agentId is
    // opaque display metadata — PB's /notifications/enqueue never queries
    // internal_agents with it (recipients arrive pre-resolved as accountIds),
    // so it is ambiguous but not broken. Anything NEW fails.
    const KNOWN = new Set(['EnqueueNotificationViaCallbackInput']);
    expect(offenders.filter(name => !KNOWN.has(name))).toEqual([]);
  });
});
