// An agent never needs permission to write in its own notebook.
//
// `record_step_output` hands a step's result to the next step.
// `report_task_outcome` records the agent's own verdict on the run. Neither
// leaves the process: no connector, no network, no file, no message. There is
// nothing for a person to approve, and an approval card for one is
// unanswerable — you cannot meaningfully consent to an agent remembering its
// own intermediate result.
//
// If the catalog list the gate consults goes stale and `record_step_output` is
// not in it, the miss reads as "unknown tool", unknown fails closed, and the
// run stalls on an approval to write down a step result. Stale caches are
// handled separately. This makes the outcome impossible rather than unlikely: failing
// closed on a genuinely unknown tool is correct, and should not have to be
// lucky about lookups for this class.

import { isInProcessBookkeepingTool } from '../tool-name-resolution';

describe('the tools that can never gate', () => {
  it.each([
    'record_step_output',
    'report_task_outcome',
    // A line in the agent's own audit trail — the step the templates ask for
    // right after a review is posted. Gating it raises approval cards just to
    // record that permitted work had been done.
    'audit_log',
  ])('%s, bare', (name) => {
    expect(isInProcessBookkeepingTool(name)).toBe(true);
  });

  it.each([
    'mcp__liftoff-tool-gateway__record_step_output',
    'mcp__liftoff-tool-gateway__report_task_outcome',
  ])('%s, as the SDK calls it', (name) => {
    // The SDK calls the prefixed name and the catalog stores the bare one.
    // That mismatch is how a catalog lookup misses, so both forms must match.
    expect(isInProcessBookkeepingTool(name)).toBe(true);
  });
});

describe('what it must not exempt', () => {
  it.each([
    'google-mail-0105297e__reply_to_thread',
    'google-mail-0105297e__send_email',
    'mcp__liftoff-tool-gateway__google-mail-0105297e__send_email',
    'slack_send_message',
    'shell_exec',
    'file_write',
  ])('%s still reaches the gate', (name) => {
    expect(isInProcessBookkeepingTool(name)).toBe(false);
  });

  it('does not match on a substring', () => {
    // A connector operation that merely CONTAINS the name is a different tool.
    expect(isInProcessBookkeepingTool('crm__record_step_output_history')).toBe(false);
    expect(isInProcessBookkeepingTool('record_step_output_v2')).toBe(false);
  });

  it('does not exempt a connector tool that merely ends with the name', () => {
    // `alias__record_step_output` would be somebody else's tool reaching
    // somebody else's system. Exempting it from approval by coincidence of
    // naming is the kind of over-broad match found years later.
    expect(isInProcessBookkeepingTool('salesforce-a1b2__record_step_output')).toBe(false);
  });

  it('is not fooled by an empty or malformed name', () => {
    expect(isInProcessBookkeepingTool('')).toBe(false);
    expect(isInProcessBookkeepingTool('mcp__record_step_output')).toBe(false);
  });
});

describe('the gate consults it before any catalog lookup', () => {
  // The whole point is that it cannot be defeated by a stale or incomplete
  // catalog. If this moved below resolveCatalogTool it would still work today
  // and fail again the next time the catalog drifted.
  const SRC = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'service.ts'), 'utf8',
  ) as string;

  it('runs ahead of the catalog lookup', () => {
    // The gate resolves through resolveGateTool (resolveCatalogTool plus the
    // meta-tool operation step); the guard must still sit ahead of it.
    const guard = SRC.indexOf('if (isInProcessBookkeepingTool(call.name)) return false;');
    const lookup = SRC.indexOf('const tool = resolveGateTool(call, tools);');
    expect(guard).toBeGreaterThan(-1);
    expect(lookup).toBeGreaterThan(guard);
  });
});

describe('pseudo-connector prefixes resolve to the catalog name', () => {
  // Our own dispatch layer composes `agent_slack__slack_send_message` from a
  // bare catalog name, because the family resolver needs a connector segment to
  // pick a handler. There is no `agent_slack` integration. The catalog holds
  // `slack_send_message`, so the prefixed name matched nothing, the gate read
  // that as an unknown tool, and unknown fails closed.
  //
  // Without this, posting a support escalation to a Slack channel raises an
  // approval card. Slack posts are categorised `internalCollaboration` and are
  // exempt — but the exemption reads the resolved tool's categories, and
  // nothing resolves.
  const { normalizeToolName } = require('../tool-name-resolution');

  it.each([
    ['agent_slack__slack_send_message', 'slack_send_message'],
    ['agent_teams__teams_send_message', 'teams_send_message'],
    ['execution_environment__shell_exec', 'shell_exec'],
  ])('%s resolves to %s', (called, bare) => {
    expect(normalizeToolName(called)).toBe(bare);
  });

  it('strips the pseudo prefix inside the SDK form too', () => {
    expect(normalizeToolName('mcp__liftoff-tool-gateway__agent_slack__slack_send_message'))
      .toBe('slack_send_message');
  });

  it('leaves a REAL connector tool alone', () => {
    // `google-mail-0105297e__send_email` is registered under its full aliased
    // name. A general "take the last segment" rule would collapse every
    // connector's send_email onto one entry; this list is explicit for that
    // reason.
    expect(normalizeToolName('google-mail-0105297e__send_email'))
      .toBe('google-mail-0105297e__send_email');
    expect(normalizeToolName('mcp__liftoff-tool-gateway__google-mail-0105297e__send_email'))
      .toBe('google-mail-0105297e__send_email');
  });
});
