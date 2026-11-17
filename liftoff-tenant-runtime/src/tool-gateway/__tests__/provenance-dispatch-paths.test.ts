// Every path that reaches a vendor passes through the provenance seam.
//
// This is the enumerating half of INV-TR-019, in the style of
// adapter/__tests__/usage-invariant.test.ts, and it exists because the thing it
// guards is invisible in review. `ToolGatewayService` has TWO dispatch paths and
// they do not share a bottom: `execute()` runs the serial pipeline, and
// `executeBatch()` has a fast path that goes straight to connector-service and
// never calls `execute()` at all. A guard added to one reads, in a diff, exactly
// like a guard added to the service.
//
// That is not hypothetical here. With the audit wrapper on `execute()` alone,
// `governance_wal` misses every batched call, and batched calls are most of
// them. The same shape, one method over, is what this test is for.
//
// It reads the SOURCE rather than driving the service, deliberately. Driving it
// proves the paths that exist today behave; reading it proves a path added
// tomorrow cannot quietly not behave, which is the property that decays.

import { readFileSync } from 'fs';
import { join } from 'path';

const SERVICE = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

/** The body of a named method on the service class. */
function methodBody(name: string): string {
  // Both spellings: the dispatch methods are async, the guard is not, and a
  // helper that only finds one silently reports the other as missing.
  const start = [`async ${name}(`, `private ${name}(`, `${name}(`]
    .map((form) => SERVICE.indexOf(form))
    .find((i) => i >= 0) ?? -1;
  if (start < 0) throw new Error(`ToolGatewayService.${name} not found — did it move or get renamed?`);
  // Past the PARAMETER list first. `async execute(input: ExecuteInput & {
  // _internalSkipHitl?: boolean })` opens a brace inside its own signature, and
  // taking the first one reads an inline type as the method body — which passes
  // "the guard is missing" for a method that has it.
  let paren = 0;
  let i = SERVICE.indexOf('(', start);
  for (; i < SERVICE.length; i++) {
    if (SERVICE[i] === '(') paren++;
    else if (SERVICE[i] === ')') {
      paren--;
      if (paren === 0) break;
    }
  }
  const open = SERVICE.indexOf('{', i);
  let depth = 0;
  for (let i = open; i < SERVICE.length; i++) {
    if (SERVICE[i] === '{') depth++;
    else if (SERVICE[i] === '}') {
      depth--;
      if (depth === 0) return SERVICE.slice(open, i + 1);
    }
  }
  throw new Error(`could not find the end of ${name}`);
}

// WHAT THIS FILE MISSED, and why it is worth saying here rather than quietly
// widening the list. It enumerated two METHODS on ONE file, and the path that
// carried most of the traffic was in another: the Composio route dispatches
// from `mcp-server.ts` and never enters this class at all, so every assertion
// below passed while it ran unguarded. The second test was weaker still — it
// accepted `recordProvenanceForResult` in `executeBatch` as evidence the fast
// path was covered, and the fast path had exactly that: the recorder, and none
// of the four checks.
//
// A hand-written list of paths decays the same way a hand-written list of
// anything else does. The cross-file half now lives in
// every-dispatch-is-guarded.test.ts; what stays here is the per-method property
// this file was built for.
describe('the write guard is on every dispatch path', () => {
  it.each(['execute', 'executeBatch'])('%s guards writes before dispatch', (method) => {
    const body = methodBody(method);
    // Either the chain itself, or `execute` — which IS the chain — for the
    // fallback slots.
    const guarded =
      body.includes('preDispatchGuards')
      || (method === 'executeBatch' && body.includes('this.execute('));
    expect(guarded).toBe(true);
  });

  it('executeBatch guards its FAST path, not only its fallback slots', async () => {
    // The fast path partitions inputs and sends the eligible ones to
    // connector-service directly. `this.execute(` in this method only covers
    // the FALLBACK slots, so its presence says nothing about the batched ones —
    // and the exclusion list keeps out only the two action types literally
    // named 'update' and 'delete', which leaves every other write eligible.
    const body = methodBody('executeBatch');
    expect(body.indexOf('fastPathEligible')).toBeGreaterThan(-1);
    // The guard must appear on its own, not merely via the fallback's execute.
    expect(body).toContain('preDispatchGuards');
    expect(body).toContain('recordProvenanceForResult');
  });
});

describe('the recorder is on every path a result comes back on', () => {
  it.each(['execute', 'executeBatch'])('%s records what came back', (method) => {
    expect(methodBody(method)).toContain('recordProvenanceForResult');
  });

  it('records on the batch fast path, not only via the serial fallback', async () => {
    // A recorder wired only into execute() would miss every BATCHED read, and
    // poll-then-act — the shape this matters most for — batches its reads. The
    // writes that followed would then all look unprovenanced and the shadow
    // metric would be noise.
    const body = methodBody('executeBatch');
    const viaSerial = body.indexOf('out[idx] = await this.execute(input)');
    const onFastPath = body.lastIndexOf('recordProvenanceForResult');
    expect(onFastPath).toBeGreaterThan(viaSerial);
  });
});

describe('the gate reports before it decides', () => {
  // The unit test for reportProvenance calls it directly, so it passes whether
  // or not anything reaches it. This asserts the PATH, which is where the bug
  // was: `if (verdict.provenanced) return null;` sat ABOVE the report call, so
  // the only event the gate could emit was the failure. A metric with one
  // observable state cannot be read — would_block == 0 means either
  // "everything was provenanced" or "the gate never ran".
  //
  // A live trace finds this and a test does not, because every test of the
  // reporter is a test of the reporter.
  it('calls reportProvenance before any early return on the verdict', async () => {
    const body = methodBody('guardWriteProvenance');
    const report = body.indexOf('reportProvenance(');
    const shortCircuit = body.indexOf('if (verdict.provenanced) return null;');
    expect(report).toBeGreaterThan(-1);
    expect(shortCircuit).toBeGreaterThan(-1);
    expect(report).toBeLessThan(shortCircuit);
  });

  it('reports on every judged write, not only the failing ones', async () => {
    // A guard on the guard: deleting the short-circuit entirely would satisfy
    // the ordering test above while changing what the gate DOES.
    const body = methodBody('guardWriteProvenance');
    expect((body.match(/reportProvenance\(/g) ?? [])).toHaveLength(1);
    expect(body).toContain('if (verdict.provenanced) return null;');
  });
});

describe('the helpers are shared, not duplicated', () => {
  it('there is exactly one guard and one recorder', async () => {
    // Two copies drift. The gate has to be one implementation both paths call,
    // which is what INV-TR-019 means by "the shared helpers".
    const guardDefs = SERVICE.match(/private (?:async )?guardWriteProvenance\(/g) ?? [];
    const recordDefs = SERVICE.match(/private (?:async )?recordProvenanceForResult\(/g) ?? [];
    expect(guardDefs).toHaveLength(1);
    expect(recordDefs).toHaveLength(1);
  });

  it("resolves the declaration in the CATALOG's key space", async () => {
    // `input.connector` arrives as either an instance alias
    // (`google_mail-0105297e`) or a bare type (`google_mail`), and the catalog
    // is keyed on whatever connector-service calls the connector — underscores
    // and all. A lookup in the WRONG key space is not an error: Map.get returns
    // undefined, the gate reads it as "this tool declares nothing", and it
    // silently never fires.
    //
    // This test previously asserted `connectorTypeFromAlias`, which was the
    // wrong helper, and asserting it is what held the bug in place. That
    // function normalises into the ACTION LEDGER's namespace, where target_ref
    // is hyphenated by convention, so it maps `google_mail` to `google-mail` on
    // purpose. Every underscore-typed connector — the four Google ones, custom
    // MCP servers — dropped out of the gate, while `slack` and `github` kept
    // working because they have no underscore to mangle. A test naming the
    // helper rather than the property is a test that ratifies whatever the code
    // does.
    // Asserted as the PROPERTY rather than one call's spelling: the lookup key
    // comes from catalogTypeFor and never from connectorTypeFromAlias. Pinning
    // the literal `getToolSchema(catalogTypeFor(...))` broke the moment the
    // value was hoisted to a local for reuse, which is a refactor the property
    // survives untouched — and a test that fails on formatting teaches people
    // to stop reading it.
    const decl = SERVICE.slice(SERVICE.indexOf('provenanceDeclarationFor'));
    const body = decl.slice(0, decl.indexOf('\n  }'));
    expect(body).toMatch(/catalogTypeFor\(input\.connector\)/);
    expect(body).toMatch(/getToolSchema\(/);
    expect(body).not.toMatch(/connectorTypeFromAlias/);
  });
});
