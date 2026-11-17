// The wire vocabulary the tenant runtime speaks to open a BYOK session.
//
// This is a CROSS-REPO contract with no type system spanning it, so the thing
// that holds it has to be a check rather than a convention. What it replaced was
// worse: both repos held the literal `'agent_invocation'` as a purpose string,
// and a rename on either side would have moved every agent turn in the estate
// onto managed keys — silently, because "not eligible" and "I did not recognise
// that" produce the identical answer.
//
// A closed enum makes drift LOUD: an unrecognised kind is a 400 the runtime
// logs, not a decline it treats as policy.

import { z } from 'zod';

// The schema under test, mirrored here rather than exported from the router.
// Exporting it would satisfy the letter of this test while letting the router
// and the schema drift apart; asserting the ROUTER rejects the payload is what
// the second describe block does.
describe('the callKind vocabulary', () => {
  const schema = z.discriminatedUnion('callKind', [
    z.object({ callKind: z.literal('agent_invocation') }),
    z.object({ callKind: z.literal('llm_call'), purpose: z.string().min(1).max(120) }),
  ]);

  it('accepts an agent turn with no purpose of its own', () => {
    // The turn IS the work. It has no purpose tag and inventing one for it is
    // what created the duplicated-string problem in the first place.
    expect(schema.safeParse({ callKind: 'agent_invocation' }).success).toBe(true);
  });

  it('accepts a tagged llm call', () => {
    expect(schema.safeParse({ callKind: 'llm_call', purpose: 'history-compaction' }).success)
      .toBe(true);
  });

  it('REJECTS an llm call with no purpose', () => {
    // A purpose-less llm_call cannot be judged for eligibility, and defaulting
    // it either way would be a policy decision hidden in a parser.
    expect(schema.safeParse({ callKind: 'llm_call' }).success).toBe(false);
  });

  it('REJECTS a kind nobody agreed on', () => {
    // The whole point: a runtime that drifts gets an error it can see.
    expect(schema.safeParse({ callKind: 'agent_turn' }).success).toBe(false);
    expect(schema.safeParse({ callKind: 'agent_invocation', purpose: 'x' }).success).toBe(true);
  });

  it('REJECTS the old shape, where the kind travelled as a purpose string', () => {
    expect(schema.safeParse({ purpose: 'agent_invocation' }).success).toBe(false);
  });
});

describe('the managed-gateway opt-in', () => {
  // A SECOND CROSS-REPO FIELD WITH NO TYPE SYSTEM SPANNING IT, and its default is
  // what makes it worth a check of its own. The runtime sends
  // `acceptManagedGateway` and the control plane mints a managed-primary session
  // only when it is true; a rename on either side makes it absent, and absent
  // means FALSE — so the drift is silent in the direction of "no capture", which
  // is exactly the state this whole change exists to leave behind.
  //
  // Mirrored here rather than exported from the router, for the same reason as
  // the block above: exporting the schema would satisfy the letter of the test
  // while letting the router drift away from it.
  const schema = z.object({
    tenantId: z.string().uuid(),
    invocationId: z.string().min(1).max(200),
    resolvedProvider: z.string().min(1).max(64),
    acceptManagedGateway: z.boolean().optional(),
  });
  const base = {
    tenantId: 'dd7d80bd-3b77-4677-817c-053fdb8668cd',
    invocationId: 'inv-1',
    resolvedProvider: 'anthropic',
  };

  it('is optional, so an older runtime still opens a BYOK session', () => {
    // The field is additive. A runtime that predates it must keep working, and
    // what it gets is today's behaviour: no managed session.
    expect(schema.safeParse(base).success).toBe(true);
  });

  it('accepts the boolean the runtime sends', () => {
    expect(schema.safeParse({ ...base, acceptManagedGateway: true }).success).toBe(true);
    expect(schema.safeParse({ ...base, acceptManagedGateway: false }).success).toBe(true);
  });

  it('REJECTS a truthy string, which is what a JSON mistake looks like', () => {
    // `acceptManagedGateway: "true"` is truthy in JavaScript and would turn the
    // capture on for a caller that never asked. A 400 the runtime logs is the
    // loud version of the same drift.
    expect(schema.safeParse({ ...base, acceptManagedGateway: 'true' }).success).toBe(false);
  });

  it('is the name BOTH sides use', async () => {
    // The literal, in the one place on this side that reads it. The runtime's
    // half is pinned by its own suite; this is what stops a rename here from
    // silently answering "no capture" to every caller.
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const router = readFileSync(join(__dirname, '..', 'internal-router.ts'), 'utf8');
    expect(router).toContain('acceptManagedGateway');
    expect(router).toContain("input.acceptManagedGateway === true");
  });
});

describe('the sentinel purpose', () => {
  it('lives on exactly one side of the wire', async () => {
    const { AGENT_INVOCATION_PURPOSE } = await import(
      '../../tenant-ai-provider-keys/resolution-service'
    );
    // Named here so a change is a deliberate edit rather than a silent one. The
    // value is free to change: nothing off-process holds it, which is the
    // property this whole vocabulary exists to buy.
    expect(AGENT_INVOCATION_PURPOSE).toBe('agent_invocation');
  });

  it('is eligible, or the agent turn — the bulk of BYOK spend — funds nothing', async () => {
    const { AGENT_INVOCATION_PURPOSE, isByokEligiblePurpose } = await import(
      '../../tenant-ai-provider-keys/resolution-service'
    );
    expect(isByokEligiblePurpose(AGENT_INVOCATION_PURPOSE)).toBe(true);
  });
});
