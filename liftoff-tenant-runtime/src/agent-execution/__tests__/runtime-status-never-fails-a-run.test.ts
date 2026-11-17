// FITNESS FUNCTION — the agent's runtime status cannot end a run.
//
// `agents.runtime_status` is ONE column per agent, and the platform runs many
// invocations of one agent concurrently on purpose: `runDelegationChild` says
// "a fan-out of eight tasks to one specialist is eight concurrent runs of that
// agent", and every interactive chat turn passes `bypassAgentLock: true`. So a
// run's terminal transition is validated against whatever the last writer left.
// A sibling finishing first writes IDLE; the run still in flight then attempts
// IDLE -> WAITING_FOR_HUMAN, which VALID_RUNTIME_TRANSITIONS rejects, and
// AgentLifecycleService.updateRuntimeStatus throws.
//
// What the throw cost, before this:
//   - from the terminal transition: a `success: true, escalated: true` result
//     was replaced by `engine_error`, and the learning triggers, note
//     promotion, verify-on-stop and the stranded-message drain were skipped.
//   - from createHitlPause: the approval row was already durable and its
//     24-hour expiry task had not been armed yet, so the approval became one
//     that could never expire.
//   - from createClarificationPause: the throw preceded the return that carries
//     `clarificationQuestion`, so the question the agent asked was never
//     delivered and a person owed an answer to something never shown to them.
//
// Nothing gates execution on the column, and the control plane excludes
// `runtime_status_changed` from its activity feed as internal infrastructure.
// So the property is: every write of it in the execution service goes through
// the one helper that swallows a rejected transition.
//
// Asserted against source. The alternative — driving a full executeTask with a
// hostile lifecycle stub — would test one of the thirteen call sites and leave
// the other twelve free to regress.

import { readFileSync } from 'fs';
import { join } from 'path';

const SERVICE = readFileSync(
  join(__dirname, '..', 'service.ts'),
  'utf8',
);

describe('runtime status is best-effort everywhere in the execution service', () => {
  it('routes every write through the helper', () => {
    // Exactly one direct call may remain: the one inside setRuntimeStatus.
    const direct = SERVICE.match(/this\.agentLifecycle\.updateRuntimeStatus\(/g) ?? [];
    expect(direct).toHaveLength(1);

    const helperBody = SERVICE.split('private async setRuntimeStatus(')[1] ?? '';
    expect(helperBody.slice(0, 800)).toContain('this.agentLifecycle.updateRuntimeStatus(');
  });

  it('the helper swallows the rejection rather than propagating it', () => {
    const helperBody = (SERVICE.split('private async setRuntimeStatus(')[1] ?? '').slice(0, 900);
    expect(helperBody).toContain('try {');
    expect(helperBody).toContain('} catch (err) {');
    // A catch that rethrows would satisfy the shape and fail the property.
    expect(helperBody).not.toMatch(/catch[\s\S]{0,400}throw /);
  });

  it('the helper does not call itself', () => {
    // It was written by replacing every `this.agentLifecycle.updateRuntimeStatus(`
    // call site in one pass, which rewrote the helper's own call too and made it
    // infinitely recursive. Type-correct, and it would have hung the first run.
    const helperBody = (SERVICE.split('private async setRuntimeStatus(')[1] ?? '').slice(0, 900);
    expect(helperBody).not.toContain('await this.setRuntimeStatus(');
  });

  it('still writes the terminal states the surfaces expect', () => {
    // The guard must not become "stop setting the status". The values that
    // matter are still written, just not fatally.
    expect(SERVICE).toContain("this.setRuntimeStatus(input.agentId, 'WAITING_FOR_HUMAN')");
    expect(SERVICE).toContain("this.setRuntimeStatus(input.agentId, 'IDLE')");
    expect(SERVICE).toContain("this.setRuntimeStatus(input.agentId, 'RUNNING')");
  });
});
