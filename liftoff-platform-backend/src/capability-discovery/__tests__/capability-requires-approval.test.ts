// capabilityRequiresApproval decides the class marker minted into a capability
// handle (cap_w. vs cap_r.). A write/outbound class marks cap_w., which is what
// makes the runtime's adapter gate PAUSE the call for human approval. If an
// outbound capability is classed read here, the gate never fires and the call
// reaches the executor ungated — an outbound publish with no approval.
//
// externalPublishing (email/Slack/publish) is the case this guards: without it
// in BLOCKED_CATEGORIES, a Slack-send capability mints a read handle and never
// pauses.

const getCachedClassification = jest.fn();
jest.mock('../../mcp/tool-classifier', () => ({
  toolClassifier: { getCachedClassification: (...a: unknown[]) => getCachedClassification(...a) },
}));

import { capabilityRequiresApproval } from '../vendor-execution';

describe('capabilityRequiresApproval — outbound/write classes require approval', () => {
  beforeEach(() => jest.clearAllMocks());

  it('an externalPublishing send (Slack/email) requires approval', async () => {
    getCachedClassification.mockResolvedValue({ categories: ['externalPublishing'] });
    expect(await capabilityRequiresApproval('slack:slack_send_message')).toBe(true);
    // Keyed by connector type + bare fn, not the whole sourceRef.
    expect(getCachedClassification).toHaveBeenCalledWith('slack_send_message', 'slack');
  });

  it.each([
    ['customerCommunication'],
    ['financialActions'],
    ['outbound'],
    ['write'],
    ['destructive'],
  ])('a %s capability requires approval', async (category) => {
    getCachedClassification.mockResolvedValue({ categories: [category] });
    expect(await capabilityRequiresApproval(`x:do_${category}`)).toBe(true);
  });

  it('a read capability (no sensitive category) does not require approval', async () => {
    getCachedClassification.mockResolvedValue({ categories: [] });
    expect(await capabilityRequiresApproval('slack:slack_search_messages')).toBe(false);
  });

  it('an unclassified tool requires approval (fail-safe, matches the executor refusal)', async () => {
    getCachedClassification.mockResolvedValue(null);
    expect(await capabilityRequiresApproval('slack:some_new_tool')).toBe(true);
  });

  it('a lookup error requires approval (fail-safe)', async () => {
    getCachedClassification.mockRejectedValue(new Error('db down'));
    expect(await capabilityRequiresApproval('slack:slack_send_message')).toBe(true);
  });
});
