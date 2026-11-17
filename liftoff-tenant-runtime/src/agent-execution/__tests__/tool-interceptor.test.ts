// Tool interceptor regression tests.
//
// A support agent could send outbound emails autonomously despite the
// tenant's oversight policy being set to `communication: 'draft'`
// ("Draft first" in the UI). Two independent bugs in the interceptor
// allowed it:
//
//   1. The category check only recognised the Slack catalog's
//      vocabulary (`externalPublishing` / `customerCommunication`).
//      connector-functions-registry (Gmail/Outlook/HubSpot/Salesforce,
//      216 tools total) uses `'outbound'`. Result: every Gmail
//      `reply_email`, `send_email`, `forward_email` etc. slipped past
//      the draft-first interceptor.
//
//   2. The registry's draftVariants are hardcoded with the legacy
//      single-alias prefix (`google-mail__create_draft`). After
//      migration 252 per-account aliases like `google-mail-14a82d9e`,
//      a literal swap to the legacy name produces a tool that doesn't
//      exist in the agent's catalog — every dispatch would 404 or
//      route to nothing.
//
// Both fixes are guarded below.

import { maybeConvertToDraft } from '../tool-interceptor';
import { HitlGateError, OversightSettings, ModelTool, ToolCallRequest } from '../../hitl-enforcement/types';

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

function makeToolCall(name: string, input: Record<string, unknown> = {}): ToolCallRequest {
  return { id: 'tc-1', name, input };
}

describe('maybeConvertToDraft', () => {
  it('passes through unchanged when oversight settings are absent', () => {
    const call = makeToolCall('google-mail-14a82d9e__reply_email');
    const result = maybeConvertToDraft(call, undefined, []);
    expect(result).toEqual(call);
  });

  it('passes through unchanged when the tool is not outbound', () => {
    const call = makeToolCall('google-mail-14a82d9e__list_messages');
    const tools: ModelTool[] = [{
      name: 'google-mail-14a82d9e__list_messages',
      categories: ['read'],
    } as ModelTool];
    const result = maybeConvertToDraft(call, baseOversight({ communication: 'draft' }), tools);
    expect(result).toEqual(call);
  });

  describe('category-recognition (the registry vs slack-catalog vocabulary bug)', () => {
    // Connector-service's connector-functions-registry tags every
    // outbound vendor tool with categories ['write','outbound']. The
    // pre-fix interceptor checked only for slack's vocabulary
    // ['externalPublishing','customerCommunication']. Every Gmail
    // send_email/reply_email/forward_email/etc. slipped through.

    it('recognises the connector-service vocabulary "outbound"', () => {
      // Before the fix this category was not recognised — call would
      // pass through unchanged in draft mode and the agent would
      // autonomously send the email.
      const call = makeToolCall('google-mail-14a82d9e__reply_email');
      const tools: ModelTool[] = [{
        name: 'google-mail-14a82d9e__reply_email',
        categories: ['write', 'outbound'],
        draftVariant: 'google-mail__create_draft',
      } as ModelTool];
      const result = maybeConvertToDraft(
        call,
        baseOversight({ communication: 'draft' }),
        tools,
      );
      expect(result.name).toBe('google-mail-14a82d9e__create_draft');
    });

    it('still recognises the slack-catalog vocabulary "externalPublishing"', () => {
      const call = makeToolCall('slack-d77db9a0__send_message');
      const tools: ModelTool[] = [{
        name: 'slack-d77db9a0__send_message',
        categories: ['externalPublishing', 'customerCommunication'],
        draftVariant: 'slack__schedule_message',
      } as ModelTool];
      const result = maybeConvertToDraft(
        call,
        baseOversight({ communication: 'draft' }),
        tools,
      );
      expect(result.name).toBe('slack-d77db9a0__schedule_message');
    });
  });

  describe('per-account alias composition (post-migration-252 draftVariant bug)', () => {
    // The registry's draftVariant carries the legacy single-alias prefix
    // (`google-mail__create_draft`). With per-account aliases like
    // `google-mail-14a82d9e`, the literal name doesn't exist in the
    // catalog. The interceptor must derive the alias from the actual
    // caller's tool name and compose <currentAlias>__<draftFunction>.

    it('rewrites with the caller\'s alias, not the registry\'s legacy alias', () => {
      const call = makeToolCall('google-mail-14a82d9e__reply_email');
      const tools: ModelTool[] = [{
        name: 'google-mail-14a82d9e__reply_email',
        categories: ['write', 'outbound'],
        draftVariant: 'google-mail__create_draft', // legacy single-alias prefix
      } as ModelTool];
      const result = maybeConvertToDraft(
        call,
        baseOversight({ communication: 'draft' }),
        tools,
      );
      // CRITICAL: NOT 'google-mail__create_draft' — that tool doesn't
      // exist post-migration 252. The per-account alias `14a82d9e`
      // must carry through.
      expect(result.name).toBe('google-mail-14a82d9e__create_draft');
    });

    it('works correctly for multi-account agents (two Gmails, different aliases)', () => {
      // The fix has to be the right thing for legitimate multi-account
      // configurations: a support agent bound to BOTH support@ Gmail and sales@
      // Gmail. A reply on the support inbox must be drafted in the
      // SAME inbox, not silently routed through sales.
      const supportCall = makeToolCall('google-mail-eaec0c30__reply_email');
      const salesCall = makeToolCall('google-mail-14a82d9e__reply_email');
      const tools: ModelTool[] = [
        { name: 'google-mail-eaec0c30__reply_email', categories: ['outbound'], draftVariant: 'google-mail__create_draft' } as ModelTool,
        { name: 'google-mail-14a82d9e__reply_email', categories: ['outbound'], draftVariant: 'google-mail__create_draft' } as ModelTool,
      ];
      const supportResult = maybeConvertToDraft(supportCall, baseOversight({ communication: 'draft' }), tools);
      const salesResult = maybeConvertToDraft(salesCall, baseOversight({ communication: 'draft' }), tools);
      expect(supportResult.name).toBe('google-mail-eaec0c30__create_draft');
      expect(salesResult.name).toBe('google-mail-14a82d9e__create_draft');
    });

    it('handles registry draftVariants that drop the legacy prefix too', () => {
      // Cleaner future format: draftVariant is just the function name.
      // The interceptor must compose correctly whether the registry
      // value is '<alias>__create_draft' or just 'create_draft'.
      const call = makeToolCall('google-mail-14a82d9e__reply_email');
      const tools: ModelTool[] = [{
        name: 'google-mail-14a82d9e__reply_email',
        categories: ['outbound'],
        draftVariant: 'create_draft', // function-only form
      } as ModelTool];
      const result = maybeConvertToDraft(call, baseOversight({ communication: 'draft' }), tools);
      expect(result.name).toBe('google-mail-14a82d9e__create_draft');
    });
  });

  describe('communication mode semantics', () => {
    const buildOutboundCall = () => makeToolCall('google-mail-14a82d9e__reply_email');
    const buildOutboundTools = (): ModelTool[] => ([{
      name: 'google-mail-14a82d9e__reply_email',
      categories: ['write', 'outbound'],
      draftVariant: 'google-mail__create_draft',
    } as ModelTool]);

    it('draft: always rewrites outbound tools', () => {
      const result = maybeConvertToDraft(
        buildOutboundCall(),
        baseOversight({ communication: 'draft' }),
        buildOutboundTools(),
      );
      expect(result.name).toBe('google-mail-14a82d9e__create_draft');
    });

    it('auto: passes outbound tools through unchanged', () => {
      const call = buildOutboundCall();
      const result = maybeConvertToDraft(
        call,
        baseOversight({ communication: 'auto' }),
        buildOutboundTools(),
      );
      expect(result).toEqual(call);
    });

    it('review: an outbound email pauses under the External publishing toggle, and passes when it is off', () => {
      // A Gmail send carries only the generic `outbound` category in its
      // registry entry; the toggle whose scope is external email is
      // externalPublishing, so that is the one it falls under.
      const on = baseOversight({ communication: 'review', sensitiveWork: { externalPublishing: true } as never });
      expect(() => maybeConvertToDraft(buildOutboundCall(), on, buildOutboundTools())).toThrow(HitlGateError);

      const off = baseOversight({
        communication: 'review',
        sensitiveWork: { externalPublishing: false, customerCommunication: true } as never,
      });
      expect(maybeConvertToDraft(buildOutboundCall(), off, buildOutboundTools())).toEqual(buildOutboundCall());
    });

    // Review means a person approves the SEND itself. Substituting a draft
    // would hand them a different action from the one they were asked about,
    // so a sensitive outbound call pauses under Review whether or not a draft
    // form exists. Draft substitution belongs to Draft-first alone.
    it('review: pauses a sensitive outbound call for approval, even when a draft form exists', () => {
      const call = makeToolCall('slack-d77db9a0__send_message');
      const tools: ModelTool[] = [{
        name: 'slack-d77db9a0__send_message',
        categories: ['externalPublishing', 'customerCommunication'],
        draftVariant: 'slack__schedule_message',
      } as ModelTool];
      expect(() => maybeConvertToDraft(call, baseOversight({ communication: 'review' }), tools))
        .toThrow(HitlGateError);
      try {
        maybeConvertToDraft(call, baseOversight({ communication: 'review' }), tools);
      } catch (err) {
        expect((err as HitlGateError).reason).toBe('sensitive_work');
      }
    });

    it('review: a native send carrying only `outbound` pauses when External publishing is on', () => {
      const call = makeToolCall('google-mail-0105297e__send_email');
      const tools: ModelTool[] = [{
        name: 'google-mail-0105297e__send_email',
        categories: ['write', 'outbound'],
        draftVariant: 'google-mail__create_draft',
      } as ModelTool];
      const on = baseOversight({ communication: 'review', sensitiveWork: { externalPublishing: true } as never });
      expect(() => maybeConvertToDraft(call, on, tools)).toThrow(HitlGateError);
      try {
        maybeConvertToDraft(call, on, tools);
      } catch (err) {
        expect((err as HitlGateError).matchedCategory).toBe('externalPublishing');
      }
      const off = baseOversight({ communication: 'review', sensitiveWork: { externalPublishing: false, customerCommunication: true } as never });
      expect(maybeConvertToDraft(call, off, tools).name).toBe('google-mail-0105297e__send_email');
    });

    it('draft: still rewrites the same call to its draft form', () => {
      const call = makeToolCall('slack-d77db9a0__send_message');
      const tools: ModelTool[] = [{
        name: 'slack-d77db9a0__send_message',
        categories: ['externalPublishing', 'customerCommunication'],
        draftVariant: 'slack__schedule_message',
      } as ModelTool];
      const result = maybeConvertToDraft(call, baseOversight({ communication: 'draft' }), tools);
      expect(result.name).toBe('slack-d77db9a0__schedule_message');
    });
  });

  describe('fallback safety', () => {
    it('gates instead of producing an unroutable name when the tool has no draftVariant', () => {
      const call = makeToolCall('google-mail-14a82d9e__reply_email');
      const tools: ModelTool[] = [{
        name: 'google-mail-14a82d9e__reply_email',
        categories: ['outbound'],
        // no draftVariant
      } as ModelTool];
      expect(() =>
        maybeConvertToDraft(call, baseOversight({ communication: 'draft' }), tools),
      ).toThrow(HitlGateError);
    });

    it('gates when the caller\'s tool name has no alias prefix (cannot compose)', () => {
      // Edge case: a standard tool somehow tagged outbound. Without an
      // alias prefix we can't compose a draft name — gate.
      const call = makeToolCall('memory_save'); // no `__`
      const tools: ModelTool[] = [{
        name: 'memory_save',
        categories: ['outbound'],
        draftVariant: 'whatever__draft_fn',
      } as ModelTool];
      expect(() =>
        maybeConvertToDraft(call, baseOversight({ communication: 'draft' }), tools),
      ).toThrow(HitlGateError);
    });
  });
});
