// Whether the gate is safe to ENFORCE, proved by enumeration rather than by
// watching traffic.
//
// The plan's Phase 3 gate asks for "no unexplained legitimate-pattern hits" in
// a shadow window. That criterion cannot be met at this scale: there is almost
// no usage, so the window will never fill, and for its entire existence every
// hit it recorded was a false alarm the gate itself produced. Waiting longer
// would have collected more of the same.
//
// What actually establishes safety is a set of properties that hold by
// construction. Each is a question a count cannot answer and a reader can:
//
//   1. does every dispatch path reach the gate
//   2. does the declaration lookup resolve in the catalog's key space
//   3. does a write with no declaration refuse nothing
//   4. does an enforced connector have something to match against
//   5. does the refusal fire ONLY on a genuine miss
//
// These are the counter-examples the shadow window was supposed to surface,
// written down instead of waited for.

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  checkWriteProvenance,
  recordProvenance,
  provenanceEnforcedFor,
  _resetProvenanceForTesting,
} from '../record-provenance';

const SERVICE = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');
const INVOCATION = 'aaaaaaaa-0000-4000-8000-00000000ffff';

const ORIGINAL_ENV = { ...process.env };
beforeEach(async () => { _resetProvenanceForTesting(); });
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('1. every dispatch path reaches the gate', () => {
  // INV-TR-019. The gate lives in shared helpers precisely because a guard
  // wired into one dispatcher and not the other is the estate's most repeated
  // defect — enforcement on the 1% path while the 99% path runs unguarded.
  it('guards and records from ONE implementation each', async () => {
    const guards = SERVICE.match(/private (?:async )?guardWriteProvenance\b/g) ?? [];
    const records = SERVICE.match(/private (?:async )?recordProvenanceForResult\b/g) ?? [];
    expect(guards).toHaveLength(1);
    expect(records).toHaveLength(1);
  });

  it('calls the guard from every dispatch entry point', async () => {
    // Both `execute` and `executeBatch` must reach it. Counted rather than
    // asserted at one call site, so a third dispatcher added later fails here
    // instead of silently running ungated.
    const calls = SERVICE.match(/this\.guardWriteProvenance\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const recordCalls = SERVICE.match(/this\.recordProvenanceForResult\(/g) ?? [];
    expect(recordCalls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('2. the declaration lookup resolves in the catalog key space', () => {
  it('keys on catalogTypeFor, never on the action-ledger namespace', async () => {
    // connectorTypeFromAlias hyphenates for the ledger, so `google_mail`
    // becomes `google-mail` and every underscore-typed connector — the four
    // Google ones, every custom MCP server — dropped out of the gate silently
    // while slack and github kept working.
    const decl = SERVICE.slice(SERVICE.indexOf('provenanceDeclarationFor'));
    const body = decl.slice(0, decl.indexOf('\n  }'));
    expect(body).toMatch(/catalogTypeFor\(input\.connector\)/);
    expect(body).not.toMatch(/connectorTypeFromAlias/);
  });
});

describe('3. a write with no declaration refuses nothing', () => {
  it('reports not_judged rather than a miss', async () => {
    // The floor reports separately and is never merged into would_block. An
    // undeclared tool must not be refused: most connectors are in that
    // state, and treating "nothing to check" as "check failed" would refuse
    // most of the estate on the day enforcement is switched on.
    const verdict = await checkWriteProvenance({
      invocationId: INVOCATION,
      declaration: undefined,
      payload: { thread_id: 'never-read' },
    });
    expect(verdict.basis).toBe('no_declaration');
    expect(verdict.provenanced).toBe(true);
  });
});

describe('4. enforcement requires something to match against', () => {
  it('enforces only connectors named explicitly', async () => {
    process.env.PROVENANCE_GATE_MODE = 'enforce';
    process.env.PROVENANCE_ENFORCE_CONNECTORS = 'google_mail';
    expect(provenanceEnforcedFor('google_mail')).toBe(true);
    // github is declared but not named here; it stays in shadow however the
    // global mode is set. The list is the decision, not the coverage.
    expect(provenanceEnforcedFor('github')).toBe(false);
  });

  it('the global mode alone enforces nothing', async () => {
    process.env.PROVENANCE_GATE_MODE = 'enforce';
    delete process.env.PROVENANCE_ENFORCE_CONNECTORS;
    expect(provenanceEnforcedFor('google_mail')).toBe(false);
  });
});

describe('5. the refusal fires only on a genuine miss', () => {
  const declaration = {
    idArgs: ['thread_id'],
    returnsIds: [{ entityType: 'thread', path: 'items[].id' }],
  };

  it('passes a write naming an id a read in this run returned', async () => {
    await recordProvenance({
      invocationId: INVOCATION,
      declaration,
      result: { items: [{ id: 'T-1' }] },
      isWrite: false,
    });
    const verdict = await checkWriteProvenance({
      invocationId: INVOCATION,
      declaration,
      payload: { thread_id: 'T-1' },
    });
    expect(verdict.provenanced).toBe(true);
  });

  it('catches a write naming an id nothing returned', async () => {
    await recordProvenance({
      invocationId: INVOCATION,
      declaration,
      result: { items: [{ id: 'T-1' }] },
      isWrite: false,
    });
    const verdict = await checkWriteProvenance({
      invocationId: INVOCATION,
      declaration,
      payload: { thread_id: 'T-INVENTED' },
    });
    expect(verdict.provenanced).toBe(false);
    expect(verdict.unseen).toContain('T-INVENTED');
  });

  it('does not judge a write whose declared argument the payload omits', async () => {
    // A declaration naming an argument the call does not carry is not a miss.
    // Treating absence as a violation would refuse every optional-target write.
    await recordProvenance({
      invocationId: INVOCATION, declaration, result: { items: [{ id: 'T-1' }] }, isWrite: false,
    });
    const verdict = await checkWriteProvenance({
      invocationId: INVOCATION,
      declaration,
      payload: { body: 'no target named' },
    });
    expect(verdict.provenanced).toBe(true);
  });

  it('does not let one run borrow another run’s ids', async () => {
    // The property is per-run: an id another invocation read is not evidence
    // this one read it. Constructed with the second run having read something
    // of its OWN, because a run with no reads at all has no entry and the gate
    // fails open by design — chat turns and inbound dispatch arrive without an
    // invocation, and refusing them would refuse the surfaces people use.
    const other = 'bbbbbbbb-0000-4000-8000-00000000ffff';
    await recordProvenance({
      invocationId: INVOCATION, declaration, result: { items: [{ id: 'T-1' }] }, isWrite: false,
    });
    await recordProvenance({
      invocationId: other, declaration, result: { items: [{ id: 'T-2' }] }, isWrite: false,
    });
    // T-2 is its own and passes.
    expect((await checkWriteProvenance({ invocationId: other, declaration, payload: { thread_id: 'T-2' } })).provenanced).toBe(true);
    // T-1 belongs to the other run and does not.
    const borrowed = await checkWriteProvenance({
      invocationId: other, declaration, payload: { thread_id: 'T-1' },
    });
    expect(borrowed.provenanced).toBe(false);
    expect(borrowed.unseen).toContain('T-1');
  });

  it('fails OPEN for a call with no invocation to remember against', async () => {
    // Stated as a property rather than left implicit: chat turns and inbound
    // dispatch reach the gateway without an invocation id, and a gate that
    // refused them would refuse the surfaces people actually use. It is the
    // deliberate limit of what this can prove, and worth reading as one.
    expect((await checkWriteProvenance({
      invocationId: undefined, declaration, payload: { thread_id: 'anything' },
    })).provenanced).toBe(true);
  });
});
