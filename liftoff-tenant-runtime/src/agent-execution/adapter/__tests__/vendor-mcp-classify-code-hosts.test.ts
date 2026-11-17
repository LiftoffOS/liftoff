// A comment on a code host is not customer communication.
//
// The verb sets in vendor-mcp-classify read a tool's NAME and nothing else, so
// `add_comment_to_pending_review` classified as `customerCommunication` for the
// single reason that the name contains "comment". Nothing about the vendor, the
// agent, or what was being written to was consulted.
//
// That is not cosmetic: `customerCommunication` is in OUTBOUND_CATEGORIES
// (oversight-decision.ts), so every code-review annotation was routed through
// the Communication oversight policy — the policy for messages leaving the
// workspace toward a customer.
//
// in-place-reply.ts already recorded the same objection while working around
// it: "`add_issue_comment` is tagged customerCommunication — which a
// pull-request comment plainly is not."
//
// The fix uses the `serverId` argument the signature has carried unused since
// it was written, with a header comment saying it exists for exactly this.

import { classifyVendorMcpTool, vendorTypeFromServerId } from '../vendor-mcp-classify';

describe('vendorTypeFromServerId', () => {
  it('strips the 8-hex suffix mcp-server.ts appends', () => {
    expect(vendorTypeFromServerId('github-dd4c4689')).toBe('github');
    expect(vendorTypeFromServerId('gitlab-1924102e')).toBe('gitlab');
  });

  it('keeps a type that itself contains dashes', () => {
    // The suffix is stripped, not the first segment taken — otherwise
    // google-mail would resolve to "google".
    expect(vendorTypeFromServerId('google-mail-0105297e')).toBe('google-mail');
  });

  it('returns a bare type unchanged', () => {
    expect(vendorTypeFromServerId('github')).toBe('github');
  });

  it('does not mistake a non-hex trailing segment for the suffix', () => {
    expect(vendorTypeFromServerId('some-vendor-zzzzzzzz')).toBe('some-vendor-zzzzzzzz');
  });
});

describe('code hosts: a comment is a repository write', () => {
  const CODE_HOST_COMMENTS = [
    ['github-dd4c4689', 'add_comment_to_pending_review'],
    ['github-dd4c4689', 'add_issue_comment'],
    ['github-dd4c4689', 'add_reply_to_pull_request_comment'],
    ['gitlab-1924102e', 'create_merge_request_note'],
  ] as const;

  it.each(CODE_HOST_COMMENTS)('%s / %s is dataChanges, not customerCommunication', (server, tool) => {
    const { categories } = classifyVendorMcpTool(server, tool);
    expect(categories).toContain('dataChanges');
    expect(categories).not.toContain('customerCommunication');
  });

  it('never drops the category entirely', () => {
    // A comment tool with no write verb in its name would classify to [] if the
    // communication branch merely stopped emitting. Unclassified reads to the
    // gate as an unknown effectful write and gates anyway — a wrong label
    // traded for no label.
    const { categories } = classifyVendorMcpTool('github-dd4c4689', 'comment_on_issue');
    expect(categories).toContain('dataChanges');
    expect(categories.length).toBeGreaterThan(0);
  });

  it('leaves destructive classification untouched', () => {
    // The narrowing is only about who a comment reaches. Deleting is still
    // deleting.
    const { categories, destructive } = classifyVendorMcpTool('github-dd4c4689', 'delete_file');
    expect(destructive).toBe(true);
    expect(categories).toContain('destructive');
    expect(categories).toContain('dataChanges');
  });
});

describe('everywhere else is unchanged', () => {
  const REAL_CUSTOMER_CONTACT = [
    ['google-mail-0105297e', 'reply_to_thread'],
    ['google-mail-0105297e', 'send_email'],
    ['slack-d77db9a0', 'send_message'],
    // Every connector in the catalog's `customer_support` category. These are
    // the tools that genuinely reach a customer, and they must keep the label.
    ['zendesk-11111111', 'create_ticket_comment'],
    ['freshdesk-22222222', 'reply_to_ticket'],
    ['intercom-d9883e1f', 'reply_to_conversation'],
    ['zoho-desk-33333333', 'send_ticket_reply'],
  ] as const;

  it.each(REAL_CUSTOMER_CONTACT)('%s / %s is still customerCommunication', (server, tool) => {
    const { categories } = classifyVendorMcpTool(server, tool);
    expect(categories).toContain('customerCommunication');
  });

  it('ZENDESK is why this is scoped by vendor and not by verb', () => {
    // Zendesk calls a ticket reply a COMMENT — the runtime has a
    // `formatZendeskComments` helper for exactly that vocabulary. So the same
    // verb that means "annotate a diff" on GitHub means "write to the customer"
    // here.
    //
    // Anyone tempted to fix the mislabel by dropping `comment` from
    // COMMUNICATION_VERBS, or by matching on the verb instead of the host,
    // silently stops governing replies to customers as customer communication.
    // That is a strictly worse defect than the one being fixed, and it would
    // not be visible until someone audited a support agent's oversight.
    const zendesk = classifyVendorMcpTool('zendesk-11111111', 'add_comment');
    expect(zendesk.categories).toContain('customerCommunication');

    const github = classifyVendorMcpTool('github-dd4c4689', 'add_comment');
    expect(github.categories).not.toContain('customerCommunication');
    expect(github.categories).toContain('dataChanges');
  });

  it('an unknown vendor keeps the conservative default', () => {
    // Narrowing applies only to hosts explicitly listed. A vendor nobody has
    // reasoned about keeps the label that assumes it reaches a person.
    const { categories } = classifyVendorMcpTool('mystery-aabbccdd', 'send_message');
    expect(categories).toContain('customerCommunication');
  });

  it('still classifies a read as nothing at all', () => {
    const { categories } = classifyVendorMcpTool('github-dd4c4689', 'get_pull_request');
    expect(categories).toEqual([]);
  });
});
