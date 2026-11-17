// C6 verification: the W1 work-inbox/ack contract injection is
// source-agnostic. A Composio-sourced inbox tool with paired_ack must
// produce the same WorkInboxPair + contract section that a native one
// would. The distill flow MUST NOT branch on definitionSource — that
// would violate the templates-are-text-shortcuts-only rule.

import {
  buildWorkInboxContractSection,
  resolveWorkInboxPairs,
  type WorkInboxPair,
} from '../distill-work-inbox-injection';
import type { ToolCatalog } from '../distill-service';

function composioCatalog(
  entries: Array<{
    name: string;
    workRole?: 'inbox' | 'ack';
    paired_ack?: string;
    acknowledges?: string;
    workItemKind?: string;
    vendorToolName?: string;
  }>,
): ToolCatalog {
  const c: ToolCatalog = new Map();
  for (const e of entries) {
    c.set(e.name, {
      name: e.name,
      description: '',
      workRole: e.workRole,
      paired_ack: e.paired_ack,
      acknowledges: e.acknowledges,
      workItemKind: e.workItemKind,
      definitionSource: 'composio',
      vendorToolName: e.vendorToolName,
    });
  }
  return c;
}

describe('distill work-inbox injection — Composio-sourced tools', () => {
  it('resolves inbox/ack pairs identically when source=composio', () => {
    const c = composioCatalog([
      {
        name: 'gmail-acct-aaa__list_messages',
        workRole: 'inbox',
        paired_ack: 'mark_as_read',
        workItemKind: 'email_message',
        vendorToolName: 'GMAIL_FETCH_EMAILS',
      },
      {
        name: 'gmail-acct-aaa__mark_as_read',
        workRole: 'ack',
        acknowledges: 'list_messages',
        workItemKind: 'email_message',
        vendorToolName: 'GMAIL_MODIFY_THREAD_LABELS',
      },
    ]);
    expect(resolveWorkInboxPairs(c)).toEqual<WorkInboxPair[]>([
      {
        inboxTool: 'gmail-acct-aaa__list_messages',
        ackTool: 'gmail-acct-aaa__mark_as_read',
        workItemKind: 'email_message',
        connectorAlias: 'gmail-acct-aaa',
      },
    ]);
  });

  it('contract section names the per-account-aliased Composio stable names (not vendor slugs)', () => {
    const c = composioCatalog([
      {
        name: 'slack-acct-bbb__list_threads',
        workRole: 'inbox',
        paired_ack: 'mark_thread_read',
        workItemKind: 'slack_thread',
        vendorToolName: 'SLACK_FETCH_CONVERSATION_REPLIES',
      },
      {
        name: 'slack-acct-bbb__mark_thread_read',
        workRole: 'ack',
        acknowledges: 'list_threads',
        workItemKind: 'slack_thread',
        vendorToolName: 'SLACK_MARK_AS_READ',
      },
    ]);
    const pairs = resolveWorkInboxPairs(c);
    const section = buildWorkInboxContractSection(pairs);
    expect(section).toContain('slack-acct-bbb__list_threads');
    expect(section).toContain('slack-acct-bbb__mark_thread_read');
    // Vendor slugs MUST NOT leak into the agent prompt — agents call the
    // stable name, not the vendor's raw tool name.
    expect(section).not.toContain('SLACK_FETCH_CONVERSATION_REPLIES');
    expect(section).not.toContain('SLACK_MARK_AS_READ');
  });

  it('mixed native + composio catalog: both contribute pairs without branching on source', () => {
    const c: ToolCatalog = new Map();
    c.set('gmail-acct-aaa__list_messages', {
      name: 'gmail-acct-aaa__list_messages',
      description: '',
      workRole: 'inbox',
      paired_ack: 'mark_as_read',
      workItemKind: 'email_message',
      definitionSource: 'composio',
      vendorToolName: 'GMAIL_FETCH_EMAILS',
    });
    c.set('gmail-acct-aaa__mark_as_read', {
      name: 'gmail-acct-aaa__mark_as_read',
      description: '',
      workRole: 'ack',
      acknowledges: 'list_messages',
      workItemKind: 'email_message',
      definitionSource: 'composio',
      vendorToolName: 'GMAIL_MODIFY_THREAD_LABELS',
    });
    c.set('linear-acct-ccc__list_issues', {
      name: 'linear-acct-ccc__list_issues',
      description: '',
      workRole: 'inbox',
      paired_ack: 'update_issue',
      workItemKind: 'issue',
      definitionSource: 'native',
    });
    c.set('linear-acct-ccc__update_issue', {
      name: 'linear-acct-ccc__update_issue',
      description: '',
      workRole: 'ack',
      acknowledges: 'list_issues',
      workItemKind: 'issue',
      definitionSource: 'native',
    });
    const pairs = resolveWorkInboxPairs(c);
    expect(pairs).toHaveLength(2);
    expect(pairs.map(p => p.connectorAlias).sort()).toEqual([
      'gmail-acct-aaa', 'linear-acct-ccc',
    ]);
    expect(pairs.find(p => p.connectorAlias === 'gmail-acct-aaa')?.workItemKind).toBe('email_message');
    expect(pairs.find(p => p.connectorAlias === 'linear-acct-ccc')?.workItemKind).toBe('issue');
  });
});
