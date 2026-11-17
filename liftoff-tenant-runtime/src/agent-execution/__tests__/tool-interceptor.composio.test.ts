// C6 verification: the draft-first interceptor is source-agnostic. A
// Composio-overlaid tool whose ModelTool carries categories=['write',
// 'outbound'] + draftVariant gets rewritten the same way a native
// connector-functions-registry tool does. Locks the contract that the
// cutover (composio dispatch now in-process via tool-gateway/
// composio-dispatcher.ts) did NOT regress draft-first.

import { maybeConvertToDraft } from '../tool-interceptor';
import { HitlGateError, ModelTool, OversightSettings, ToolCallRequest } from '../../hitl-enforcement/types';

function baseOversight(overrides: Partial<OversightSettings> = {}): OversightSettings {
  return {
    tenantId: 't1',
    autonomy: 'balanced',
    escalation: 'important',
    sensitiveWork: {
      customerCommunication: true,
      financialActions: true,
      dataChanges: false,
      externalPublishing: true,
      hiringDecisions: false,
      mergeToMain: false,
    },
    communication: 'auto',
    currentVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function call(name: string): ToolCallRequest {
  return { id: 'tc-1', name, input: { to: 'a@b', body: 'x' } };
}

describe('maybeConvertToDraft — Composio-sourced tools (C6)', () => {
  it('Composio gmail.send_email under communication=draft rewrites to create_draft (per-account alias preserved)', () => {
    // The Composio overlay for gmail.send_email sets:
    //   categoryOverrides: ['write', 'outbound']
    //   draftVariant: 'create_draft'
    // The tool-catalog builder composes the agent-facing alias prefix
    // (gmail-acct-aaa__send_email) and the interceptor must rewrite it
    // to gmail-acct-aaa__create_draft.
    const tools: ModelTool[] = [{
      name: 'gmail-acct-aaa__send_email',
      categories: ['write', 'outbound'],
      draftVariant: 'create_draft',
    } as ModelTool];
    const out = maybeConvertToDraft(
      call('gmail-acct-aaa__send_email'),
      baseOversight({ communication: 'draft' }),
      tools,
    );
    expect(out.name).toBe('gmail-acct-aaa__create_draft');
  });

  it('Composio slack.send_message under communication=draft rewrites to schedule_message', () => {
    const tools: ModelTool[] = [{
      name: 'slack-acct-bbb__send_message',
      categories: ['write', 'outbound'],
      draftVariant: 'schedule_message',
    } as ModelTool];
    const out = maybeConvertToDraft(
      call('slack-acct-bbb__send_message'),
      baseOversight({ communication: 'draft' }),
      tools,
    );
    expect(out.name).toBe('slack-acct-bbb__schedule_message');
  });

  it('Composio outbound tool with NO draftVariant throws HitlGateError(communication_review) — gate, do not pass through', () => {
    // Overlay coverage check enforces draftVariant on outbound tools, but
    // if an overlay forgets to set draftVariant the interceptor must NOT
    // silently let the call through — it must gate.
    const tools: ModelTool[] = [{
      name: 'hubspot-acct-ccc__send_outreach_email',
      categories: ['write', 'outbound'],
      // intentionally no draftVariant
    } as ModelTool];
    expect(() =>
      maybeConvertToDraft(
        call('hubspot-acct-ccc__send_outreach_email'),
        baseOversight({ communication: 'draft' }),
        tools,
      ),
    ).toThrow(HitlGateError);
  });

  it('Composio read-only tool (categories=read) passes through under draft policy', () => {
    const tools: ModelTool[] = [{
      name: 'gmail-acct-aaa__list_messages',
      categories: ['read'],
    } as ModelTool];
    const tc = call('gmail-acct-aaa__list_messages');
    const out = maybeConvertToDraft(tc, baseOversight({ communication: 'draft' }), tools);
    expect(out).toEqual(tc);
  });

  it('Composio outbound + sensitive under communication=review with externalPublishing enabled → pauses for approval (the send, not a draft)', () => {
    const tools: ModelTool[] = [{
      name: 'slack-acct-bbb__send_message',
      categories: ['outbound', 'externalPublishing'],
      draftVariant: 'schedule_message',
    } as ModelTool];
    const run = () => maybeConvertToDraft(
      call('slack-acct-bbb__send_message'),
      baseOversight({
        communication: 'review',
        sensitiveWork: {
          customerCommunication: false,
          financialActions: false,
          dataChanges: false,
          externalPublishing: true,
          hiringDecisions: false,
          mergeToMain: false,
        },
      }),
      tools,
    );
    // Under Review the person approves the send itself; a draft would be a
    // different action from the one they were asked to approve.
    expect(run).toThrow(HitlGateError);
  });
});
