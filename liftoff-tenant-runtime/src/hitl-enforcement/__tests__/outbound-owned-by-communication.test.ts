// Who owns an outbound message: the Communication policy, not the
// external-content invariant.
//
// `/dashboard/oversight` -> Communication already routes outbound three ways:
//
//   Draft first                    -> only the draft form is registered
//   Review for sensitive cases     -> approval in /dashboard/review on a
//                                     sensitive match   <- the queue, on purpose
//   Send automatically when safe   -> sends
//
// The external-content invariant was gating outbound calls on top of that, and it
// runs BEFORE autonomy is consulted, so a workspace set to send automatically
// still queued every message and raising autonomy did not help.
//
// The result was one review-queue entry per outbound message: an outbox. A queue
// full of routine sends buries the escalations and clarifications that need a
// person, and teaches people to approve without reading. That is the same cost
// the read fix (a read never gates) exists to avoid, arriving by a second route.
//
// Everything NOT outbound still gates: editing a file, merging, changing records
// are covered by no communication policy and have no other control.
//
// This asserts the property that makes the exemption safe: the invariant exempts
// EXACTLY what Communication governs, no more. The two sites share one predicate
// (isOutboundTool) rather than mirroring a category list, because a mirror can
// drift into exempting a call the policy does not pick up, leaving it neither
// gated nor governed. The earlier draft of this fix kept a lower-cased mirror,
// which would have done precisely that: the gateway matches case-sensitively.

import { isOutboundTool, oversightDecisionFor, OUTBOUND_CATEGORIES } from '../../tool-gateway/oversight-decision';
import { toolIsReadOnly } from '../../tool-gateway/tool-effect';

/** The untrusted-inbound filter in hitl-enforcement/service.ts, in the order it
 *  runs: a read never gates, then outbound belongs to Communication, then
 *  everything else gates. Kept in step with the real one by the composition
 *  tests below rather than by resemblance. */
const invariantGates = (tool: { effect?: 'read' | 'write' | 'spawn'; categories?: string[] }) => {
  if (toolIsReadOnly(tool)) return false;
  if (isOutboundTool(tool)) return false;
  return true;
};

describe('the exemption is exactly what Communication governs', () => {
  it('covers the three ways a tool can be outbound', () => {
    // outbound is what connector tools carry; vendor MCP tools use a different
    // vocabulary and never carry it.
    expect(isOutboundTool({ categories: ['outbound'] })).toBe(true);
    expect(isOutboundTool({ categories: ['customerCommunication'] })).toBe(true);
    expect(isOutboundTool({ categories: ['externalPublishing'] })).toBe(true);
    expect([...OUTBOUND_CATEGORIES].sort()).toEqual(
      ['customerCommunication', 'externalPublishing', 'outbound'],
    );
  });

  it('exempts nothing the Communication policy would not recognise', () => {
    // The property that makes this safe. For every category the invariant lets
    // through as outbound, oversightDecisionFor must also treat it as outbound,
    // or the call is neither gated here nor governed there.
    const sendsAutomatically = {
      communication: 'auto' as const,
      sensitiveWork: {},
    } as unknown as Parameters<typeof oversightDecisionFor>[1];

    for (const category of OUTBOUND_CATEGORIES) {
      const fn = { categories: [category] };
      expect(isOutboundTool(fn)).toBe(true);
      // Reached the outbound branch rather than the early `allow` for
      // non-outbound, which is what proves the policy owns it.
      expect(oversightDecisionFor(fn, sendsAutomatically)).not.toBeUndefined();
    }
  });

  it('is case-sensitive, matching the gateway', () => {
    // The earlier draft lower-cased both sides in hitl-enforcement while the
    // gateway matched case-sensitively. A tool tagged CUSTOMERCOMMUNICATION
    // would then have been exempted here and unrecognised there.
    expect(isOutboundTool({ categories: ['CUSTOMERCOMMUNICATION'] })).toBe(false);
    expect(isOutboundTool({ categories: ['customerCommunication'] })).toBe(true);
  });
});

describe('what the invariant still gates on the untrusted-inbound path', () => {
  it('lets a customer email through: Communication decides', () => {
    expect(invariantGates({ effect: 'write', categories: ['dataChanges', 'customerCommunication'] })).toBe(false);
  });

  it('lets a pure read through, whichever signal states it', () => {
    expect(invariantGates({ effect: 'read', categories: [] })).toBe(false);
    // The connector-catalog shape that would otherwise raise an approval for
    // "Retrieve email thread ... from Google Mail".
    expect(invariantGates({ effect: undefined, categories: ['read'] })).toBe(false);
  });

  it('still gates editing a file', () => {
    // No communication policy covers this, so untrusted content steering a file
    // write must still stop.
    expect(invariantGates({ effect: 'write', categories: ['dataChanges'] })).toBe(true);
  });

  it('still gates merging', () => {
    // merge_pull_request is tagged ['dataChanges'] and is not marked
    // destructive, so this is the one that must not slip.
    expect(invariantGates({ effect: undefined, categories: ['dataChanges'] })).toBe(true);
  });

  it('still gates an unclassified vendor write', () => {
    // Neither signal stated: unknown, and unknown gates.
    expect(invariantGates({ effect: undefined, categories: [] })).toBe(true);
  });

  it('gates a write that also claims to read', () => {
    // A write marker wins over a stated read, so a tool carrying both cannot buy
    // its way out of the gate. The markers that count are the side-effect axis —
    // the effect vocabulary (write / destructive / outbound / spawn / admin) plus
    // dataChanges, which the vendor-MCP classifier emits only on a real write/
    // destructive verb. A pure sensitivity tag like financialActions is NOT a
    // marker: it names the domain a call touches, not whether it writes, so it
    // does not gate a read (get_invoice is a read).
    expect(invariantGates({ effect: undefined, categories: ['read', 'write'] })).toBe(true);
    expect(invariantGates({ effect: undefined, categories: ['read', 'destructive'] })).toBe(true);
    // A read in a sensitive domain is still a read — the tag does not gate it.
    expect(invariantGates({ effect: 'read', categories: ['financialActions'] })).toBe(false);
  });

  it('reaches the outbound check rather than being swallowed as a read', () => {
    // Ordering matters and is easy to get backwards. `outbound` is in the
    // non-read set, so an outbound call is never read-only and always arrives at
    // the Communication exemption. If it were treated as a read it would be
    // exempted for the wrong reason, and a future narrowing of the read rule
    // would silently start gating sends again.
    expect(toolIsReadOnly({ effect: undefined, categories: ['outbound'] })).toBe(false);
    expect(invariantGates({ effect: undefined, categories: ['outbound'] })).toBe(false);
  });
});
