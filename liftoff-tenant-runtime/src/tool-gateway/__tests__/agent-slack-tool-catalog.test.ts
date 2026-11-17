import {
  AGENT_SLACK_TOOLS,
  SLACK_OUTBOUND_TOOL_NAMES,
} from '../agent-slack-tool-catalog';

describe('AGENT_SLACK_TOOLS categories', () => {
  function findTool(name: string) {
    const t = AGENT_SLACK_TOOLS.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} not in catalog`);
    return t;
  }

  // These previously asserted externalPublishing + customerCommunication. That was
  // the bug, not the spec: Slack is an internal collaboration surface, and the tags
  // contradicted the tools' own descriptions ("one-off posts, alerts, and summaries",
  // "private follow-ups or sensitive escalations"). The consequence was that ticking
  // "customer communication" on /oversight gated an internal CI ping, and
  // communication='draft' — a policy about OUTBOUND messages — blocked Slack with no
  // draft form to fall back to, producing a request nobody could approve.
  it.each([
    'slack_send_message',
    'slack_reply_in_thread',
    'slack_send_dm',
    'slack_update_message',
    'slack_delete_message',
  ])('tags %s as internal collaboration, not customer/external', (name) => {
    expect(findTool(name).categories).toEqual(['internalCollaboration']);
  });

  // The load-bearing property: `internalCollaboration` is not a key in
  // oversight.sensitiveWork, so it can never match an enabled checkbox no matter how
  // the workspace is configured.
  it('uses a category that no sensitive-work checkbox can match', () => {
    const SENSITIVE_WORK_KEYS = [
      'customerCommunication', 'financialActions', 'dataChanges',
      'externalPublishing', 'hiringDecisions',
    ];
    for (const name of ['slack_send_message', 'slack_send_dm']) {
      for (const cat of findTool(name).categories ?? []) {
        expect(SENSITIVE_WORK_KEYS).not.toContain(cat);
      }
    }
  });

  // `slack_add_reaction` MOVED OUT of this list.
  //
  // It was grouped with the reads and asserted to carry no categories. Adding a
  // reaction is a state change on someone else's message, visible to everyone in
  // the channel — a write. It is now stated as one.
  //
  // That gains it no gate. `internalCollaboration` is exempt from the
  // external-content invariant ("a post into the workspace's OWN Slack or Teams
  // is not an external write"), so it is governed by the Communication policy
  // like every other Slack write, exactly as before. What changes is that it is
  // no longer described as a read.
  it.each([
    'slack_list_channels',
    'slack_resolve_channel_by_name',
    'slack_get_thread',
    'slack_get_user_info',
  ])('read-only tool %s carries no write categories', (name) => {
    expect(findTool(name).categories).toBeUndefined();
  });

  // These four are READS, and now say so.
  //
  // Signalling read-ness by omission was the defect: `toolIsReadOnly` trusts
  // `read` only when stated, because "a RESOLVED entry carrying NEITHER signal
  // is a catalog that lost the classification". So every one of them gated as an
  // effectful write on an untrusted-inbound run — a person could be asked to
  // authorise LOOKING UP A CHANNEL ID.
  it.each([
    'slack_list_channels',
    'slack_resolve_channel_by_name',
    'slack_get_thread',
    'slack_get_user_info',
  ])('%s states effect: read', (name) => {
    expect(findTool(name).effect).toBe('read');
  });

  it('slack_add_reaction states that it writes', () => {
    expect(findTool('slack_add_reaction').effect).toBe('write');
    expect(findTool('slack_add_reaction').categories).toEqual(['internalCollaboration']);
  });
});

describe('SLACK_OUTBOUND_TOOL_NAMES', () => {
  it('contains exactly the four outbound tool names', () => {
    expect(SLACK_OUTBOUND_TOOL_NAMES).toEqual(
      new Set([
        'slack_send_message',
        'slack_reply_in_thread',
        'slack_update_message',
        'slack_send_dm',
      ]),
    );
  });

  it.each([
    'slack_send_message',
    'slack_reply_in_thread',
    'slack_update_message',
    'slack_send_dm',
  ])('considers %s outbound', (name) => {
    expect(SLACK_OUTBOUND_TOOL_NAMES.has(name)).toBe(true);
  });

  it.each([
    'slack_add_reaction',
    'slack_list_channels',
    'slack_get_thread',
    'slack_get_user_info',
  ])('does NOT consider %s outbound', (name) => {
    expect(SLACK_OUTBOUND_TOOL_NAMES.has(name)).toBe(false);
  });
});
