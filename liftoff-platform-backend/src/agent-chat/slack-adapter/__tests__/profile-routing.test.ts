// Who should answer this Slack message?
//
// The ladder is the feature, so the tests are about ORDER and about the two
// rules that keep the new bottom rung from changing what the bot talks in. An
// ordering bug is invisible in any test that happens to set only one binding,
// which is why every rung is asserted against every rung below it.

import {
  resolveConversationAgent,
  switchIsAllowed,
  type RoutingLookups,
} from '../profile-routing';

const NONE: RoutingLookups = {
  addressedAgentId: null,
  threadAgentId: null,
  channelAgentId: null,
  workspaceDefaultAgentId: null,
};

describe('the specificity ladder', () => {
  it('lets a named agent win over everything', () => {
    // "Code Reviewer: take a look" is someone turning to a particular person
    // mid-conversation. It has to beat the standing arrangement.
    const r = resolveConversationAgent({
      addressedAgentId: 'named', threadAgentId: 't', channelAgentId: 'c', workspaceDefaultAgentId: 'w',
    });
    expect(r.agentId).toBe('named');
    expect(r.rung).toBe('addressed');
  });

  it('prefers the thread binding over the channel', () => {
    const r = resolveConversationAgent({
      ...NONE, threadAgentId: 't', channelAgentId: 'c', workspaceDefaultAgentId: 'w',
    });
    expect(r.agentId).toBe('t');
    expect(r.rung).toBe('thread');
  });

  it('prefers the channel binding over the workspace default', () => {
    const r = resolveConversationAgent({
      ...NONE, channelAgentId: 'c', workspaceDefaultAgentId: 'w',
    });
    expect(r.agentId).toBe('c');
    expect(r.rung).toBe('channel');
  });

  it('falls back to the workspace default last', () => {
    const r = resolveConversationAgent({ ...NONE, workspaceDefaultAgentId: 'w' });
    expect(r.agentId).toBe('w');
    expect(r.rung).toBe('workspace_default');
  });

  it('answers nobody when no rung matches, so the picker still appears', () => {
    const r = resolveConversationAgent(NONE);
    expect(r.agentId).toBeNull();
    expect(r.rung).toBeNull();
  });
});

describe('threadBound', () => {
  it('is true whenever the thread itself is bound', () => {
    expect(resolveConversationAgent({ ...NONE, threadAgentId: 't' }).threadBound).toBe(true);
  });

  it('stays true even when someone else was named in this message', () => {
    // The caller needs this separately from the winning rung: a reply inside a
    // thread the bot owns is one of the things that makes it allowed to speak
    // in a channel at all, and naming somebody does not change that.
    expect(resolveConversationAgent({
      ...NONE, addressedAgentId: 'named', threadAgentId: 't',
    }).threadBound).toBe(true);
  });

  it('is false for a channel binding, which is not a thread', () => {
    expect(resolveConversationAgent({ ...NONE, channelAgentId: 'c' }).threadBound).toBe(false);
  });

  it('is false for the workspace default', () => {
    // If this leaked true, a workspace default would make the bot treat every
    // channel thread as one it owns, and it would start answering traffic
    // nobody addressed to it.
    expect(resolveConversationAgent({ ...NONE, workspaceDefaultAgentId: 'w' }).threadBound).toBe(false);
  });
});

describe('when "talk to someone else" is honoured', () => {
  it('is refused inside a bound thread', () => {
    // Whoever bound this thread already said who they want; re-prompting them
    // throws that away.
    expect(switchIsAllowed(resolveConversationAgent({ ...NONE, threadAgentId: 't' }))).toBe(false);
  });

  it('is refused when this very message named somebody', () => {
    expect(switchIsAllowed(resolveConversationAgent({ ...NONE, addressedAgentId: 'named' }))).toBe(false);
  });

  it('is allowed from a channel binding', () => {
    expect(switchIsAllowed(resolveConversationAgent({ ...NONE, channelAgentId: 'c' }))).toBe(true);
  });

  it('is allowed from the workspace default', () => {
    // That rung is not a choice anyone made about this conversation, so asking
    // discards nothing.
    expect(switchIsAllowed(resolveConversationAgent({ ...NONE, workspaceDefaultAgentId: 'w' }))).toBe(true);
  });

  it('is allowed when nothing matched at all', () => {
    expect(switchIsAllowed(resolveConversationAgent(NONE))).toBe(true);
  });
});

describe('whether answering creates a binding', () => {
  const read = (p: string): string =>
    require('fs').readFileSync(require('path').join(__dirname, '..', p), 'utf8') as string;

  it('never binds a conversation it merely answered', () => {
    // Binding on the way past would quietly convert "start here when nothing
    // else says otherwise" into "this conversation belongs to them", and the
    // person never chose that — they would find channels bound to an agent they
    // never picked. Asserted on the HANDLER, because that is where a future
    // bind would appear; a helper restating the rule would be a control that
    // looks like it is doing something while the guarantee lives elsewhere.
    expect(read('workspace-event-handler.ts')).not.toMatch(/bindAgent\(/);
  });

  it('still binds where somebody chose explicitly', () => {
    // The picker is a person saying who they want. That SHOULD stick.
    expect(read('interactivity-router.ts')).toMatch(/bindAgent\(/);
  });
});

describe('the wiring', () => {
  const read = (p: string): string =>
    require('fs').readFileSync(require('path').join(__dirname, '..', p), 'utf8') as string;

  it('routes the event handler through the ladder rather than its own two lines', () => {
    const src = read('workspace-event-handler.ts');
    expect(src).toMatch(/resolveConversationAgent\(/);
    expect(src).toMatch(/switchIsAllowed\(/);
  });

  it('reads the workspace default only when the rungs above it came up empty', () => {
    // Eagerly looking it up would put a database round trip on every message
    // in every connected workspace, for a value almost none of them use.
    const src = read('workspace-event-handler.ts');
    expect(src).toMatch(/\(addressed \|\| threadAgentId \|\| channelAgentId\)\s*\n?\s*\?\s*null/);
  });

  it('still refuses to speak in a channel it was not addressed in', () => {
    // The guard runs on threadBound, which the workspace default never sets —
    // so a default changes WHO answers, never WHETHER the bot speaks.
    const src = read('workspace-event-handler.ts');
    expect(src).toMatch(/scope !== 'dm' && !isAppMention && !addressed && !threadBound/);
  });

  it('leaves the default unset unless somebody chose it', () => {
    const migration = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', '..', '..', 'migrations', '323_slack_workspace_default_agent.sql'),
      'utf8',
    ) as string;
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS default_agent_id/);
    // Deleting a team member must not take the workspace install with it.
    expect(migration).toMatch(/ON DELETE SET NULL/);
  });
});


describe('the suggested rung (Phase 9)', () => {
  const empty = { addressedAgentId: null, threadAgentId: null, channelAgentId: null, workspaceDefaultAgentId: null };

  it('sits after the workspace default and before the picker', () => {
    expect(resolveConversationAgent({ ...empty, workspaceDefaultAgentId: 'd', suggestedAgentId: 's' }))
      .toEqual({ agentId: 'd', rung: 'workspace_default', threadBound: false });
    expect(resolveConversationAgent({ ...empty, suggestedAgentId: 's' }))
      .toEqual({ agentId: 's', rung: 'suggested', threadBound: false });
    expect(resolveConversationAgent({ ...empty, suggestedAgentId: null }))
      .toEqual({ agentId: null, rung: null, threadBound: false });
  });

  it('is consulted only when the four rungs are empty: any recorded choice wins', () => {
    for (const lookups of [
      { ...empty, addressedAgentId: 'a', suggestedAgentId: 's' },
      { ...empty, threadAgentId: 't', suggestedAgentId: 's' },
      { ...empty, channelAgentId: 'c', suggestedAgentId: 's' },
    ]) {
      expect(resolveConversationAgent(lookups).rung).not.toBe('suggested');
    }
  });

  it('never binds: threadBound stays false and a switch from it is allowed', () => {
    const d = resolveConversationAgent({ ...empty, suggestedAgentId: 's' });
    expect(d.threadBound).toBe(false);
    expect(switchIsAllowed(d)).toBe(true);
  });
});
