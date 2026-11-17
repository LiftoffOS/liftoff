// W2 of the work_inbox/ack convention plan — tests for the helpers that
// the distill flow uses to (a) discover inbox/ack pairs in the bound
// catalog and (b) emit the platform-mandatory contract section.

import {
  DistillationError,
  buildWorkInboxContractSection,
  resolveWorkInboxPairs,
  type WorkInboxPair,
} from '../distill-work-inbox-injection';
import type { ToolCatalog } from '../distill-service';

function catalog(
  entries: Array<{
    name: string;
    workRole?: 'inbox' | 'ack';
    paired_ack?: string;
    acknowledges?: string;
    workItemKind?: string;
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
    });
  }
  return c;
}

describe('resolveWorkInboxPairs', () => {
  it('returns empty when the catalog has no inbox tools', () => {
    const c = catalog([
      { name: 'google-mail-abc__send_email' },
      { name: 'google-mail-abc__get_message' },
    ]);
    expect(resolveWorkInboxPairs(c)).toEqual([]);
  });

  it('pairs inbox with its ack via the per-account alias', () => {
    const c = catalog([
      { name: 'google-mail-14a82d9e__list_messages', workRole: 'inbox', paired_ack: 'update_message', workItemKind: 'email_message' },
      { name: 'google-mail-14a82d9e__update_message', workRole: 'ack', acknowledges: 'list_messages', workItemKind: 'email_message' },
    ]);
    expect(resolveWorkInboxPairs(c)).toEqual<WorkInboxPair[]>([
      {
        inboxTool: 'google-mail-14a82d9e__list_messages',
        ackTool: 'google-mail-14a82d9e__update_message',
        workItemKind: 'email_message',
        connectorAlias: 'google-mail-14a82d9e',
      },
    ]);
  });

  it('handles multi-account agents (same connector, two aliases, two pairs)', () => {
    const c = catalog([
      { name: 'google-mail-AAA__list_messages', workRole: 'inbox', paired_ack: 'update_message', workItemKind: 'email_message' },
      { name: 'google-mail-AAA__update_message', workRole: 'ack', acknowledges: 'list_messages', workItemKind: 'email_message' },
      { name: 'google-mail-BBB__list_messages', workRole: 'inbox', paired_ack: 'update_message', workItemKind: 'email_message' },
      { name: 'google-mail-BBB__update_message', workRole: 'ack', acknowledges: 'list_messages', workItemKind: 'email_message' },
    ]);
    const pairs = resolveWorkInboxPairs(c);
    expect(pairs).toHaveLength(2);
    expect(pairs.map((p) => p.connectorAlias).sort()).toEqual(['google-mail-AAA', 'google-mail-BBB']);
  });

  it('handles multi-connector agents (Gmail + Linear)', () => {
    const c = catalog([
      { name: 'google-mail-AAA__list_messages', workRole: 'inbox', paired_ack: 'update_message', workItemKind: 'email_message' },
      { name: 'google-mail-AAA__update_message', workRole: 'ack', acknowledges: 'list_messages', workItemKind: 'email_message' },
      { name: 'linear-XYZ__list_issues', workRole: 'inbox', paired_ack: 'update_issue', workItemKind: 'issue' },
      { name: 'linear-XYZ__update_issue', workRole: 'ack', acknowledges: 'list_issues', workItemKind: 'issue' },
    ]);
    const pairs = resolveWorkInboxPairs(c);
    expect(pairs).toHaveLength(2);
    const kinds = pairs.map((p) => p.workItemKind).sort();
    expect(kinds).toEqual(['email_message', 'issue']);
  });

  it('throws DistillationError when an inbox tool is bound without its paired ack', () => {
    const c = catalog([
      { name: 'google-mail-14a82d9e__list_messages', workRole: 'inbox', paired_ack: 'update_message', workItemKind: 'email_message' },
      // ack intentionally missing
    ]);
    expect(() => resolveWorkInboxPairs(c)).toThrow(DistillationError);
    try {
      resolveWorkInboxPairs(c);
    } catch (e) {
      const err = e as DistillationError;
      expect(err.code).toBe('work_inbox_missing_ack');
      expect(err.details.inboxTool).toBe('google-mail-14a82d9e__list_messages');
      expect(err.details.expectedAck).toBe('google-mail-14a82d9e__update_message');
      expect(err.details.workItemKind).toBe('email_message');
    }
  });

  it('skips inbox tools that have no alias prefix (cannot compose ack name)', () => {
    const c = catalog([
      { name: 'no_alias_inbox', workRole: 'inbox', paired_ack: 'ack', workItemKind: 'task' },
    ]);
    // No alias prefix → skip defensively rather than crash.
    expect(resolveWorkInboxPairs(c)).toEqual([]);
  });

  it('does not double-count when the same inbox tool appears twice (impossible by Map key uniqueness)', () => {
    // Maps key on tool name; this is a sanity baseline.
    const c = catalog([
      { name: 'google-mail-A__list_messages', workRole: 'inbox', paired_ack: 'update_message', workItemKind: 'email_message' },
      { name: 'google-mail-A__update_message', workRole: 'ack', acknowledges: 'list_messages', workItemKind: 'email_message' },
    ]);
    const pairs = resolveWorkInboxPairs(c);
    expect(pairs).toHaveLength(1);
  });
});

describe('buildWorkInboxContractSection', () => {
  it('returns empty string when there are no pairs', () => {
    expect(buildWorkInboxContractSection([], 3)).toBe('');
  });

  it('emits the contract block with exact tool names and the kind label', () => {
    const text = buildWorkInboxContractSection(
      [
        {
          inboxTool: 'google-mail-14a82d9e__list_messages',
          ackTool: 'google-mail-14a82d9e__update_message',
          workItemKind: 'email_message',
          connectorAlias: 'google-mail-14a82d9e',
        },
      ],
      3,
    );
    expect(text).toContain('WORK-ITEM ACKNOWLEDGEMENT CONTRACT');
    expect(text).toContain('`google-mail-14a82d9e__list_messages`');
    expect(text).toContain('`google-mail-14a82d9e__update_message`');
    expect(text).toContain('email_message');
    expect(text).toContain('do not produce more than 3 distinct outbound resolution attempts');
  });

  it('lists every pair on its own bullet line', () => {
    const text = buildWorkInboxContractSection(
      [
        {
          inboxTool: 'a__list',
          ackTool: 'a__ack',
          workItemKind: 'email_message',
          connectorAlias: 'a',
        },
        {
          inboxTool: 'b__list',
          ackTool: 'b__ack',
          workItemKind: 'issue',
          connectorAlias: 'b',
        },
      ],
      5,
    );
    expect(text).toContain('`a__list`');
    expect(text).toContain('`a__ack`');
    expect(text).toContain('`b__list`');
    expect(text).toContain('`b__ack`');
    expect(text).toContain('do not produce more than 5 distinct outbound resolution attempts');
  });
});
