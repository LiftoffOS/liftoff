// Three defects that compound into one misleading escalation, pinned in source.
//
// A support run gates on a READ, is approved, resumes — and then every Gmail
// call fails with `invalid input syntax for type uuid: "google-mail-<id>"`.
// The agent, seeing its tools fail, escalates to a human claiming the Help
// Center is missing an article that exists, and asks for documentation to be
// written.
//
// Three distinct faults produce that one misleading escalation:
//   1. the HITL-resume context rebuilt WITHOUT bindingsByType, so the connector
//      ALIAS was dispatched as a connector id;
//   2. the gateway's no-map fallback then dispatched that alias as a connector
//      id, deferring the error to Postgres four layers down;
//   3. a step that FAILED handed nothing forward, so the failure-handling step
//      inherited a stale value and reported an absence it had not observed.

import { readFileSync } from 'fs';
import { join } from 'path';

const service = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');
const gateway = readFileSync(join(__dirname, '..', '..', 'tool-gateway', 'service.ts'), 'utf8');

describe('bindings survive every pause, not just the first one found', () => {
  // A test that does:
  //
  //   service.slice(service.indexOf('const rebuiltContext: ExecutionContext = {'), …)
  //   expect(block).toContain('bindingsByType:')
  //
  // is not enough. `indexOf` returns the FIRST match, and there are seven context
  // rebuilds in this file. It lands on `resume-clarification-` and passes —
  // while `resume-hitl-` can still be broken.
  //
  // When the map is not threaded on that path, an approved resume dispatches
  // `resume-hitl-…`, and the reply fails with `invalid input syntax for type
  // uuid` — the alias reaching Postgres. The step then registers no output, so
  // later steps die on unresolved `{{steps.<id>.*}}` references.
  //
  // So this enumerates EVERY ExecutionContext literal that carries
  // `integrations` and asserts each one. A context that can dispatch a
  // connector tool but cannot resolve an alias is the defect; there is no
  // reason for one of them to be exempt, and a new rebuild added later is
  // covered the day it is written.

  /** Every `const x: ExecutionContext = { … }` literal, with its brace-matched body. */
  const contexts = (): Array<{ line: number; label: string; body: string }> => {
    const out: Array<{ line: number; label: string; body: string }> = [];
    const re = /const\s+\w+\s*:\s*ExecutionContext\s*=\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(service)) !== null) {
      const open = service.indexOf('{', m.index);
      let depth = 0;
      let j = open;
      for (; j < service.length; j++) {
        if (service[j] === '{') depth++;
        else if (service[j] === '}' && --depth === 0) break;
      }
      const body = service.slice(open, j);
      const trace = /traceId:\s*[`'"]([^`'"$]*)/.exec(body);
      out.push({
        line: service.slice(0, m.index).split('\n').length,
        label: trace?.[1] ?? 'executeTask',
        body,
      });
    }
    return out;
  };

  it('finds every rebuild, so this cannot silently narrow to one', () => {
    // If a refactor collapses these, the count changes and someone looks.
    expect(contexts().length).toBeGreaterThanOrEqual(7);
  });

  it('gives bindingsByType to every context that carries integrations', () => {
    const dispatching = contexts().filter((c) => c.body.includes('integrations'));
    expect(dispatching.length).toBeGreaterThanOrEqual(7);
    const missing = dispatching
      .filter((c) => !c.body.includes('bindingsByType'))
      .map((c) => `${c.label} (line ${c.line})`);
    expect(missing).toEqual([]);
  });

  it('covers the HITL resume specifically, by name', () => {
    // Named rather than counted: this is the path a first-match search
    // misses.
    const hitl = contexts().find((c) => c.label.startsWith('resume-hitl-'));
    expect(hitl).toBeDefined();
    expect(hitl!.body).toContain('bindingsByType:');
    expect(hitl!.body).toContain('buildBindingsByTypeFor');
  });

  it('rebuilds the map rather than carrying a stale one through the pause', () => {
    // A pause can outlive a reconnect, and a reconnect mints new connector ids,
    // so a map carried across the pause would point at ids that no longer
    // exist. Every REBUILD therefore calls the helper.
    //
    // executeTask is exempt and stays exempt: it is the original construction,
    // not a rebuild, and builds the map inline from the manifests it has just
    // fetched. It is identified by having no traceId literal of its own.
    const rebuilds = contexts().filter((c) => c.label !== 'executeTask');
    expect(rebuilds.length).toBeGreaterThanOrEqual(5);
    for (const c of rebuilds) {
      expect(c.body).toContain('buildBindingsByTypeFor');
    }
    expect(service).toContain('private async buildBindingsByTypeFor');
  });

  it('logs loudly when the map cannot be built', () => {
    const helper = service.slice(
      service.indexOf('private async buildBindingsByTypeFor'),
      service.indexOf('public async resumeFromHitlApproval'),
    );
    expect(helper).toContain('connector calls in this run will be refused');
  });
});

describe('the no-map fallback stays open for legacy callers', () => {
  it('does not reject a non-UUID connector outright', () => {
    // A guard rejecting non-UUIDs here was tried and removed: legacy and
    // non-agent-execution callers legitimately pass a connector TYPE
    // ('salesforce') or a UUID, and the guard refused 30 of their tests. The
    // failure it reached for — an agent-execution run dispatching the ALIAS
    // because its map went missing across a HITL pause — is fixed at the
    // source, in the resume rebuild above.
    const block = gateway.slice(
      gateway.indexOf('if (!input.bindingsByType) {'),
      gateway.indexOf('const binding = input.bindingsByType[input.connector];'),
    );
    expect(block).not.toContain('UUID_RE.test');
    expect(block).toContain('fixed at the source');
  });
});

describe('a failed step hands forward a failure, not a stale value', () => {
  it('sets a structured failure marker on the onFailure route', () => {
    const block = service.slice(
      service.indexOf("anomaly_kind: 'step_failed_to_on_failure'"),
      service.indexOf('currentStepId = step.onFailure;'),
    );
    expect(block).toContain('__stepFailed: true');
    expect(block).toMatch(/stepOutput = failureValue/);
    expect(block).toMatch(/stepOutputs\[step\.stepId\] = failureValue/);
  });

  it('tells the next step that unknown is not empty', () => {
    // The exact confusion to prevent: "I could not look" rendered as "there is
    // nothing there", which is what asked a human to write an existing article.
    const block = service.slice(
      service.indexOf('const failureValue = {'),
      service.indexOf('currentStepId = step.onFailure;'),
    );
    // Asserted separately: the sentence spans a string-concatenation boundary.
    expect(block).toMatch(/result is unknown/i);
    expect(block).toMatch(/NOT empty/i);
    expect(block).toMatch(/Do not report an absence/i);
  });

  it('clears the completeness provenance of the failed step', () => {
    const block = service.slice(
      service.indexOf('const failureValue = {'),
      service.indexOf('currentStepId = step.onFailure;'),
    );
    expect(block).toContain('stepOutputProducedBy = undefined');
  });

  // The other half of the same marker.
  //
  // Telling the next step to "say the step failed and why" is right for its
  // reasoning and wrong for its prose, because the only "why" it has is
  // engineering text — a customer chat turn can be answered, in full, with
  // "The step failed because max turns were exceeded." The marker therefore
  // carries the product's own sentence for the failure class alongside the
  // internal reason, and says which one is for a person.
  it('gives the next step customer-safe wording, not just the internal error', () => {
    const block = service.slice(
      service.indexOf('const failureValue = {'),
      service.indexOf('currentStepId = step.onFailure;'),
    );
    // Existing product copy, not a new string invented at the failure site.
    expect(block).toContain('userFacingReason: failureMessageForUser(classifyFailure(e))');
    expect(block).toMatch(/never quote it/i);
    expect(block).toMatch(/use the wording in `userFacingReason`/);
  });
});
