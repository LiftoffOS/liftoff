// Every path that compiles an instruction carries the whole per-agent policy.
//
// Four call sites in the subscriber create a compiled instruction, across three
// handlers and three different events. They are NOT uniform — the status_changed
// site passes no skills — so "copy the neighbouring call" is not a safe rule, and
// a field added to some of them is a policy the agent has on some days.
//
// This is the failure the workflow_steps comment in subscriber.ts records: a
// column added to one handler and not another left the data NULL downstream
// through a republish that returned 200, with no error anywhere. A comment did
// not prevent the recurrence. This does: a fifth call site, or a fifth field,
// fails here rather than in production.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'subscriber.ts'), 'utf8');
const CALL = 'internalAgentInstructionService.createAndActivateForInternalAgent({';

/** Each call's argument object, from the opening brace to its matching close. */
function callSites(): string[] {
  const sites: string[] = [];
  let from = 0;
  for (;;) {
    const start = SRC.indexOf(CALL, from);
    if (start === -1) break;
    let depth = 0;
    let i = SRC.indexOf('{', start + CALL.length - 1);
    const open = i;
    for (; i < SRC.length; i++) {
      if (SRC[i] === '{') depth++;
      else if (SRC[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    sites.push(SRC.slice(open, i + 1));
    from = i;
  }
  return sites;
}

describe('every instruction-compiling call site carries the per-agent policy', () => {
  const sites = callSites();

  it('finds the call sites at all (guards against a rename silently emptying this suite)', () => {
    // A suite that asserts over zero items passes for the wrong reason.
    expect(sites.length).toBeGreaterThanOrEqual(4);
  });

  it.each(['capabilityTier', 'resultRules'])(
    'passes %s at every call site',
    (field) => {
      const missing = sites
        .map((s, i) => ({ i, s }))
        .filter(({ s }) => !s.includes(`${field}:`))
        .map(({ i }) => i);
      expect(missing).toEqual([]);
    },
  );

  it('reads resultRules off the payload rather than defaulting it locally', () => {
    // A site that quietly substitutes [] would satisfy the check above while
    // dropping the policy — the same shape as the defect this guards.
    for (const site of sites) {
      const match = /resultRules:\s*([^,\n]+)/.exec(site);
      expect(match).not.toBeNull();
      expect(match![1].trim()).toBe('payload.resultRules');
    }
  });
});

describe('the payload types that feed those sites declare the field', () => {
  it('declares resultRules wherever capabilityTier is declared', () => {
    const tierDecls = SRC.split("capabilityTier?: 'connector_only' | 'execution_enabled'").length - 1;
    const ruleDecls = SRC.split('resultRules?: Array<{ toolName: string; requiresComplete: boolean }>').length - 1;
    expect(tierDecls).toBeGreaterThanOrEqual(3);
    expect(ruleDecls).toBe(tierDecls);
  });
});
