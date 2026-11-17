// A run's own browser ends with the run.
//
// A run-owned session is opened for the run's lifetime and must not outlive
// it: a browser left open after the run is a paid, slot-holding session with
// nobody driving it. The one block every run passes through — resumed
// segments included — is executeTaskInner's finally, and the close sits
// there. Source-pinned because the property is the placement: the close has
// to be in the block that runs on every outcome, including a throw.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

describe("the run's browser is closed in the block every run passes through", () => {
  const finallyAt = SRC.indexOf('if (agentLock) await releaseAgentLock(execLockPool, agentLock);');
  const closeAt = SRC.indexOf('closeActiveForInvocation(input.tenantId, preGeneratedInvocationId)');

  it('sits in the finally after the agent lock is released', () => {
    expect(finallyAt).toBeGreaterThan(-1);
    expect(closeAt).toBeGreaterThan(finallyAt);
    // Inside the same finally: no method boundary between the two.
    expect(SRC.slice(finallyAt, closeAt)).not.toMatch(/\n {2}(private |public )?async /);
  });

  it('never masks the run\'s own outcome', () => {
    const around = SRC.slice(closeAt - 300, closeAt + 200);
    expect(around).toContain('try {');
    expect(around).toContain('catch { /* cleanup must never mask the run\'s own outcome */ }');
  });

  it('is keyed by the invocation, not the thread: a resumed segment closes its own', () => {
    expect(SRC).toContain('closeActiveForInvocation(input.tenantId, preGeneratedInvocationId)');
  });
});
