// citation-warning unit tests
//
// The missing-citation soft-warning was extracted out of chat-sdk-hooks (the old
// buildChatSdkHooks + collectedToolCalls surface was removed) into the pure
// evaluateCitationWarning() in citation-warning.ts. This suite tests it directly.
//
// Current gate (see citation-warning.ts): the customer-support-representative
// template + an outbound-mail action + a body containing no URL →
// { errorCode: 'MISSING_CITATION_URL' } (a soft warning; outcome stays success).

import { evaluateCitationWarning } from '../citation-warning';

const SUPPORT = 'customer-support-representative';

describe('evaluateCitationWarning', () => {
  it('flags an outbound support reply that contains no URL', () => {
    const r = evaluateCitationWarning({
      actionType: 'send_email',
      toolInput: { body: 'Thanks for reaching out — your account is now upgraded.' },
      agentTemplateId: SUPPORT,
    });
    expect(r.errorCode).toBe('MISSING_CITATION_URL');
    expect(r.outputSummary).toMatch(/no URL/i);
  });

  it('does NOT flag when the body contains a URL', () => {
    const r = evaluateCitationWarning({
      actionType: 'send_email',
      toolInput: { body: 'See https://help.example.com/billing for the steps.' },
      agentTemplateId: SUPPORT,
    });
    expect(r.errorCode).toBeUndefined();
  });

  it('does NOT flag a non-support agent template', () => {
    const r = evaluateCitationWarning({
      actionType: 'send_email',
      toolInput: { body: 'plain reply, no link' },
      agentTemplateId: 'sales-development-representative',
    });
    expect(r.errorCode).toBeUndefined();
  });

  it('does NOT flag when the agent has no template (null)', () => {
    const r = evaluateCitationWarning({
      actionType: 'send_email',
      toolInput: { body: 'plain reply, no link' },
      agentTemplateId: null,
    });
    expect(r.errorCode).toBeUndefined();
  });

  it('does NOT flag a non-mail action even without a URL', () => {
    const r = evaluateCitationWarning({
      actionType: 'create_calendar_event',
      toolInput: { body: 'no url in here' },
      agentTemplateId: SUPPORT,
    });
    expect(r.errorCode).toBeUndefined();
  });

  it.each([
    'send_email', 'reply_email', 'forward_email', 'create_draft', 'create_reply_draft',
  ])('flags outbound-mail action %s with a URL-less body', (actionType) => {
    const r = evaluateCitationWarning({
      actionType,
      toolInput: { body: 'here is your answer with no supporting link' },
      agentTemplateId: SUPPORT,
    });
    expect(r.errorCode).toBe('MISSING_CITATION_URL');
  });

  it('treats a missing body as URL-less (flags)', () => {
    const r = evaluateCitationWarning({ actionType: 'send_email', toolInput: {}, agentTemplateId: SUPPORT });
    expect(r.errorCode).toBe('MISSING_CITATION_URL');
  });
});
