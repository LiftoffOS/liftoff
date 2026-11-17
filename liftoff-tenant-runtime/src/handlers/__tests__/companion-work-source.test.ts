// A companion cron must be able to satisfy the graph it runs.
//
// A companion runs the SAME workflow graph as its agent's primary trigger, and
// a cron fire carries no `input` — the scheduled-invoke handler posts an
// objective and a label, never an inputData payload. So an event-shaped graph,
// whose first step reads `{{input.message.threadId}}`, fails step 1 on every
// companion fire and takes whatever `onFailure` branch the author wrote.
//
// Customer Support Representative's branch escalated and then acknowledged, and
// its acknowledgement was to mark the thread read. So the routine written as a
// safety net was closing tickets it had never opened — every fifteen minutes,
// reporting success, until the run-honesty fixes turned that into an escalation
// loop that auto-paused the agent.
//
// The routine's own objective already describes the right shape: "list unread
// messages … for each unread thread, run the full new-email workflow". A
// workSource makes that literal.

import { readFileSync } from 'fs';
import { join } from 'path';

const handler = readFileSync(join(__dirname, '..', 'scheduled-invoke-handler.ts'), 'utf8');
const audit = readFileSync(join(__dirname, '..', '..', 'jobs', 'workflow-steps-audit.ts'), 'utf8');

describe('the fan-out', () => {
  it('runs the graph once per resolved item', () => {
    expect(handler).toContain('resolveCompanionWorkItems');
    expect(handler).toMatch(/for \(const inputData of inputBatches\)/);
  });

  it('builds input.message with the SAME function the event path uses', () => {
    // One envelope contract, two producers. A second builder would drift from
    // the event path and the graph would only work from one of them.
    expect(handler).toContain('buildEventMessageEnvelope');
    expect(handler).toMatch(/message: buildEventMessageEnvelope\(workSource\.source, item\)/);
  });

  it('leaves every other companion on exactly one run', () => {
    // inputBatches starts as [undefined] so a routine without a workSource
    // executes once with no inputData — byte-for-byte the previous behaviour.
    expect(handler).toMatch(/inputBatches:\s*Array<Record<string, unknown> \| undefined>\s*=\s*\[undefined\]/);
    expect(handler).toMatch(/\.\.\.\(inputData \? \{ inputData \} : \{\}\)/);
  });

  it('caps the fan-out per fire', () => {
    expect(handler).toMatch(/maxItems: workSource\.maxItems \?\? \d+/);
  });
});

describe('a listing that fails is a failed routine, not an empty one', () => {
  it('throws rather than reporting no work', () => {
    // Reporting "nothing to do" when the listing call failed is the
    // fabricated-success shape this whole change exists to remove.
    const block = handler.slice(
      handler.indexOf('const resolved = await agentExecutionService.resolveCompanionWorkItems'),
      handler.indexOf('let result!'),
    );
    expect(block).toMatch(/if \(resolved\.error\)/);
    expect(block).toContain('throw new Error');
  });

  it('states an empty result explicitly instead of running the graph blind', () => {
    const block = handler.slice(
      handler.indexOf('companion work source resolved'),
      handler.indexOf('let result!'),
    );
    expect(block).toMatch(/inputBatches\.length === 0/);
    expect(block).toContain('companionWorkItems: 0');
  });
});

describe('the resolver reports an unreadable shape', () => {
  it('does not collapse a bad items path into "no work"', () => {
    const service = readFileSync(
      join(__dirname, '..', '..', 'agent-execution', 'service.ts'), 'utf8',
    );
    const block = service.slice(
      service.indexOf('public async resolveCompanionWorkItems'),
      service.indexOf('/** Server-side poll check'),
    );
    expect(block).toMatch(/result has no array at/);
    // Dispatched through executeToolCalls so the permission validator, HITL
    // gate and audit trail all apply to the listing call.
    expect(block).toContain('this.executeToolCalls(state, [call])');
  });
});

describe('validation follows the capability', () => {
  it('holds a workSource companion to the EVENT contract, not the cron one', () => {
    // Otherwise the audit would fail a workflow that now runs correctly.
    const block = audit.slice(audit.indexOf('const companions ='), audit.indexOf('return contracts;'));
    expect(block).toContain('workSource');
    expect(block).toMatch(/triggerType: 'event', eventSources: \[src\]/);
  });

  it('still holds a plain companion to the cron contract', () => {
    const block = audit.slice(audit.indexOf('const companions ='), audit.indexOf('return contracts;'));
    expect(block).toMatch(/triggerType: 'cron'/);
  });
});
