/**
 * A chat turn is never refused because the agent is doing background work.
 *
 * The per-agent execution lock (`agent_execution_locks`) exists so two
 * AUTONOMOUS runs of one agent cannot overlap. Chat used to take that lock too,
 * so a person's message landed on `agent_already_running` whenever a scheduled
 * tick happened to be running — and was answered with "This team member is
 * already working on something."
 *
 * That makes an agent unusable in proportion to how much background work it
 * does: an agent on a five-minute cron whose runs take a few minutes holds its
 * own lock for most of every five minutes. Pausing and resuming the agent
 * appears to "fix" it, because pausing also pauses the Cloud Scheduler job and
 * skips the next tick — which points at the wrong bug.
 *
 * The handler cannot be imported here (it pulls DB + SDK transitively), so this
 * asserts the structure directly, in the same spirit as the other
 * `*.source.test.ts` contracts in this directory.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const HANDLER = readFileSync(join(__dirname, '..', 'chat-turn-handler.ts'), 'utf8');
const ENGINE = readFileSync(
  join(__dirname, '..', '..', 'agent-execution', 'service.ts'),
  'utf8',
);

describe('chat does not queue behind a background run', () => {
  it('the chat path bypasses the per-agent execution lock unconditionally', () => {
    expect(HANDLER).toMatch(/bypassAgentLock:\s*true/);
  });

  it('the bypass is not conditioned on trace mode (or anything else)', () => {
    // The old form. `traceMode` covered only the synthetic harness turns, which
    // left every real conversation queuing behind cron ticks.
    expect(HANDLER).not.toMatch(/bypassAgentLock:\s*traceMode/);
    expect(HANDLER).not.toMatch(/bypassAgentLock:\s*(?!true\b)[A-Za-z_$]/);
  });

  it('the engine still refuses a SECOND autonomous run — the lock is not gone', () => {
    // The fix is "chat is exempt", not "remove the lock". A caller that does not
    // ask to bypass must still lose the race, or concurrent scheduled ticks
    // would double-run the same agent.
    expect(ENGINE).toMatch(/if\s*\(!input\.bypassAgentLock\s*&&\s*!agentLock\)/);
    expect(ENGINE).toMatch(/agent_already_running/);
  });
});
