// An agent posts to Slack as the Liftoff app. Never as a person.
//
// connector-service keeps `authed_user.access_token` as the Slack connector
// credential and hands the xoxb BOT token to the workspace install. So a
// connector send is chat.postMessage with a USER token, which Slack renders as
// that person's name and face.
//
// The symptom: an agent's reviews arrive under a person's name, while the same
// agent's digest — routed through the workspace bot — arrives as the app.
// Three things made the distiller pick the wrong one, and all three are fixed
// here:
//
//   1. Both tool sets sat in one catalog, near-identical by name
//      (`slack_send_message` vs `slack-d77db9a0__send_message`), with nothing
//      saying one was a person and one was the app.
//   2. The synthetic entry that GROUPS and LABELS the app tools was skipped
//      whenever a Slack connector was bound — exactly backwards, since that is
//      the case where the distinction matters. The app tools appeared as what
//      the code itself called "unaliased orphans" beside a tidy "Slack" group.
//   3. The prompt note asserted "the only Slack identity is the per-agent app",
//      which ADR-040 had already retired and which was plainly false for an
//      agent holding a second, better-presented Slack identity.
//
// It is not specific to one role: any agent with Slack bound got the
// user-token tool preferentially.
import { isSlackConnectorSendTool } from '../slack-connector-send-tools';
import { AGENT_SLACK_DISTILL_PROMPT_NOTE } from '../agent-slack-distill-tools';

describe('isSlackConnectorSendTool', () => {
  it('withholds a connector send_message tool', () => {
    expect(isSlackConnectorSendTool('slack-d77db9a0__send_message')).toBe(true);
  });

  it('withholds every write verb', () => {
    for (const v of ['send_message', 'post_message', 'send_dm', 'reply_in_thread',
      'update_message', 'delete_message', 'add_reaction', 'upload_file']) {
      expect(isSlackConnectorSendTool(`slack-abc12345__${v}`)).toBe(true);
    }
  });

  it('keeps connector READS — they were never the problem', () => {
    for (const v of ['list_channels', 'get_thread', 'get_user_info',
      'list_messages', 'search_messages']) {
      expect(isSlackConnectorSendTool(`slack-abc12345__${v}`)).toBe(false);
    }
  });

  it('NEVER withholds the platform app tools it exists to promote', () => {
    // The whole point. Matching on the verb alone would have suppressed these
    // and left the agent with no way to post at all.
    for (const t of ['slack_send_message', 'slack_reply_in_thread', 'slack_send_dm',
      'slack_update_message', 'slack_delete_message', 'slack_add_reaction']) {
      expect(isSlackConnectorSendTool(t)).toBe(false);
    }
  });

  it('ignores unrelated connectors that happen to send', () => {
    expect(isSlackConnectorSendTool('gmail-abc12345__send_message')).toBe(false);
    expect(isSlackConnectorSendTool('teams-abc12345__send_message')).toBe(false);
  });

  it('is not fooled by a name that merely starts with slack', () => {
    expect(isSlackConnectorSendTool('slackbot_send_message')).toBe(false);
    expect(isSlackConnectorSendTool('slack-d77db9a0')).toBe(false);
    expect(isSlackConnectorSendTool('')).toBe(false);
  });
});

describe('the distill prompt note', () => {
  it('no longer claims the retired per-agent app is the only identity', () => {
    // ADR-040 removed per-agent Slack apps. Asserting they are the only Slack
    // identity, to a model holding a second one, is how this went wrong.
    expect(AGENT_SLACK_DISTILL_PROMPT_NOTE).not.toContain('only Slack identity');
    expect(AGENT_SLACK_DISTILL_PROMPT_NOTE).not.toContain('per-agent Slack app');
  });

  it('says sending is slack_* only, and says why', () => {
    expect(AGENT_SLACK_DISTILL_PROMPT_NOTE).toContain('Liftoff Slack app');
    expect(AGENT_SLACK_DISTILL_PROMPT_NOTE).toContain('Sending is slack_* only');
    expect(AGENT_SLACK_DISTILL_PROMPT_NOTE).toContain('identity of the person who connected Slack');
  });

  it('tells the model the platform adds the name prefix', () => {
    // The convention is enforced in the tool, not left to the model — so the
    // note must stop it double-prefixing.
    expect(AGENT_SLACK_DISTILL_PROMPT_NOTE).toContain('do not add a name prefix yourself');
  });

  it('still points reads at the connector rather than banning it wholesale', () => {
    expect(AGENT_SLACK_DISTILL_PROMPT_NOTE).toContain('READING');
  });
});
