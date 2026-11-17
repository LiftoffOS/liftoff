// An agent never needs permission to wait.
//
// A wake tool suspends THIS run and resumes it on a trigger. It reaches no
// system, writes no record and tells nobody anything; what the run does after
// it wakes is gated then, under the trust the wake carries forward. Holding
// the wait itself protects nothing — and could not be honoured: the approved
// dispatch runs standard and connector tools, and a wake tool is neither, so
// the approval fails, the model asks to wait again, and every approval buys
// one more copy of the same question.

import { isSelfWakeTool } from '../tool-name-resolution';

describe('the waits that can never gate', () => {
  it.each([
    'sleep_until', 'wake_on_event', 'wake_on_job', 'wake_on_poll', 'wake_on_any', 'wake_on_all', 'cancel_wake',
  ])('%s, bare', (name) => {
    expect(isSelfWakeTool(name)).toBe(true);
  });

  it.each([
    'mcp__liftoff-tool-gateway__sleep_until',
    'mcp__liftoff-tool-gateway__wake_on_event',
  ])('%s, as the SDK calls it', (name) => {
    expect(isSelfWakeTool(name)).toBe(true);
  });
});

describe('what it must not exempt', () => {
  it.each([
    'google-mail-0105297e__send_email',
    'schedule_followup',
    'spawn_task_graph',
    'delegate_task',
    'shell_exec',
  ])('%s still reaches the gate', (name) => {
    expect(isSelfWakeTool(name)).toBe(false);
  });

  it('does not exempt a connector tool that merely ends with the name', () => {
    expect(isSelfWakeTool('calendar-a1b2__sleep_until')).toBe(false);
    expect(isSelfWakeTool('sleep_until_v2')).toBe(false);
  });
});
