// A tool the catalog cannot resolve still gates, and now says so.
//
// Failing closed on a tool nobody classified is correct and unchanged. But a
// call the catalog cannot RESOLVE is a different thing: it is the catalog and
// the caller disagreeing about a name, which tool-name-resolution.ts calls a
// defect its callers "must surface loudly rather than treat as no policy
// applies". The only thing it surfaced was an approval card, so a naming
// mismatch and a genuinely unknown tool were indistinguishable — in the logs,
// and to the person being asked to approve.
//
// That person cannot act on it either way. The request names an action no
// oversight control governs, so nothing on the settings page would have
// prevented it and nothing changes after approving. Read-only tools have
// reached people this way more than once, each time through a lookup miss
// rather than a policy.
//
// This asserts the signal exists and that the gating behaviour did not move.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

const block = SRC.slice(
  SRC.indexOf('if (isInternalCollaborationTool('),
  SRC.indexOf('// In-place reply: a non-destructive, non-outbound write'),
);

describe('the unresolved-tool signal', () => {
  it('fires only when the catalog returned nothing', () => {
    expect(block).toContain('if (!tool) {');
  });

  it('is an error, not an info line', () => {
    // It reports a defect. An info line would be filtered out of exactly the
    // searches an operator runs when chasing spurious approvals.
    expect(block).toContain('log.error(');
  });

  it('carries a stable event and metric name to search on', () => {
    expect(block).toContain("event: 'hitl_gate_unresolved_tool'");
    expect(block).toContain("metric: 'hitl.gate.unresolved_tool'");
  });

  it('carries the tool name and the catalog size', () => {
    // The two facts that separate "catalog was empty" from "catalog was full
    // and the name did not match" — different defects with different fixes.
    expect(block).toContain('tool_name: call.name');
    expect(block).toContain('catalog_size: tools?.length ?? 0');
  });

  it('names the tenant and agent, so it is attributable', () => {
    expect(block).toContain('tenant_id: tenantId');
    expect(block).toContain('agent_id: agentId');
  });

  it('says the approval maps to no oversight control', () => {
    // The sentence an operator needs: this is not a policy decision, so looking
    // for the setting that caused it is a dead end.
    expect(block).toMatch(/no oversight control governs/);
    expect(block).toMatch(/naming mismatch/);
  });
});

describe('the behaviour it reports has not changed', () => {
  it('an unresolved tool still counts as effectful', () => {
    // Fail-closed stays. The signal explains the gate; it does not remove it.
    const afterSignal = block.slice(block.indexOf('if (!tool) {'));
    expect(afterSignal).toContain('return true;');
  });

  it('the read-only and outbound carve-outs still run BEFORE it', () => {
    // A resolvable read must never reach the unresolved branch.
    const readOnlyAt = SRC.indexOf('if (toolIsReadOnly(');
    const unresolvedAt = SRC.indexOf('if (!tool) {');
    expect(readOnlyAt).toBeGreaterThan(-1);
    expect(unresolvedAt).toBeGreaterThan(readOnlyAt);
  });
});
