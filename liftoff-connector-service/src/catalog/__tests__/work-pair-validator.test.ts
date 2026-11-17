// Tests for the work-pair validator (W1.2 of the work_inbox/ack plan).
//
// Asserts pure-function semantics: every violation kind fires when its
// triggering shape is present, and a clean registry returns [].

import type { ConnectorFunction } from '../../types';
import { validateWorkPairs } from '../work-pair-validator';

function fn(over: Partial<ConnectorFunction> & { name: string }): ConnectorFunction {
  const { name, ...rest } = over;
  return {
    name,
    description: '',
    inputSchema: { type: 'object', properties: {} },
    categories: [],
    ...rest,
  };
}

describe('validateWorkPairs — clean registries', () => {
  it('returns empty for an empty registry', () => {
    expect(validateWorkPairs({})).toEqual([]);
  });

  it('returns empty when no functions carry work-pair metadata', () => {
    expect(
      validateWorkPairs({
        x: [fn({ name: 'list_a', categories: ['read'] }), fn({ name: 'update_a', categories: ['write'] })],
      }),
    ).toEqual([]);
  });

  it('accepts a valid inbox+ack pair', () => {
    expect(
      validateWorkPairs({
        google_mail: [
          fn({ name: 'list_messages', categories: ['read'], workRole: 'inbox', paired_ack: 'mark_as_read', workItemKind: 'email_message' }),
          fn({ name: 'mark_as_read', categories: ['write'], workRole: 'ack', acknowledges: 'list_messages', workItemKind: 'email_message' }),
        ],
      }),
    ).toEqual([]);
  });
});

describe('validateWorkPairs — inbox-side violations', () => {
  it('flags inbox without paired_ack', () => {
    const v = validateWorkPairs({
      x: [fn({ name: 'list_a', workRole: 'inbox', workItemKind: 'email_message' })],
    });
    expect(v).toEqual([
      expect.objectContaining({ reason: 'inbox_missing_paired_ack', connectorType: 'x', toolName: 'list_a' }),
    ]);
  });

  it('flags inbox without workItemKind', () => {
    const v = validateWorkPairs({
      x: [
        fn({ name: 'list_a', workRole: 'inbox', paired_ack: 'ack_a' }),
        fn({ name: 'ack_a', workRole: 'ack', acknowledges: 'list_a', workItemKind: 'email_message' }),
      ],
    });
    expect(v.map((x) => x.reason)).toContain('inbox_missing_workItemKind');
  });

  it('flags paired_ack pointing at a non-existent function', () => {
    const v = validateWorkPairs({
      x: [fn({ name: 'list_a', workRole: 'inbox', paired_ack: 'nonexistent', workItemKind: 'email_message' })],
    });
    expect(v).toEqual([
      expect.objectContaining({ reason: 'paired_ack_not_found_in_connector' }),
    ]);
  });

  it('flags paired_ack target that has the wrong workRole', () => {
    const v = validateWorkPairs({
      x: [
        fn({ name: 'list_a', workRole: 'inbox', paired_ack: 'update_a', workItemKind: 'email_message' }),
        fn({ name: 'update_a', categories: ['write'] /* no workRole */ }),
      ],
    });
    expect(v).toEqual([
      expect.objectContaining({ reason: 'paired_ack_target_has_wrong_role' }),
    ]);
  });

  it('flags workItemKind mismatch between inbox and its paired ack', () => {
    const v = validateWorkPairs({
      x: [
        fn({ name: 'list_a', workRole: 'inbox', paired_ack: 'ack_a', workItemKind: 'email_message' }),
        fn({ name: 'ack_a', workRole: 'ack', acknowledges: 'list_a', workItemKind: 'support_ticket' }),
      ],
    });
    expect(v.map((x) => x.reason)).toContain('workItemKind_mismatch');
  });
});

describe('validateWorkPairs — ack-side violations', () => {
  it('flags ack without acknowledges', () => {
    const v = validateWorkPairs({
      x: [fn({ name: 'ack_a', workRole: 'ack', workItemKind: 'email_message' })],
    });
    expect(v).toEqual([
      expect.objectContaining({ reason: 'ack_missing_acknowledges' }),
    ]);
  });

  it('flags ack without workItemKind', () => {
    const v = validateWorkPairs({
      x: [
        fn({ name: 'list_a', workRole: 'inbox', paired_ack: 'ack_a', workItemKind: 'email_message' }),
        fn({ name: 'ack_a', workRole: 'ack', acknowledges: 'list_a' }),
      ],
    });
    expect(v.map((x) => x.reason)).toContain('ack_missing_workItemKind');
  });

  it('flags acknowledges pointing at a non-existent function', () => {
    const v = validateWorkPairs({
      x: [fn({ name: 'ack_a', workRole: 'ack', acknowledges: 'nope', workItemKind: 'email_message' })],
    });
    expect(v).toEqual([
      expect.objectContaining({ reason: 'acknowledges_not_found_in_connector' }),
    ]);
  });

  it('flags acknowledges target that is not an inbox', () => {
    const v = validateWorkPairs({
      x: [
        fn({ name: 'ack_a', workRole: 'ack', acknowledges: 'random_thing', workItemKind: 'email_message' }),
        fn({ name: 'random_thing', categories: ['read'] /* no workRole */ }),
      ],
    });
    expect(v).toEqual([
      expect.objectContaining({ reason: 'acknowledges_target_has_wrong_role' }),
    ]);
  });
});

describe('validateWorkPairs — multi-pair connectors', () => {
  it('handles multiple independent pairs in the same connector cleanly', () => {
    expect(
      validateWorkPairs({
        salesforce: [
          fn({ name: 'list_leads', workRole: 'inbox', paired_ack: 'update_lead', workItemKind: 'lead' }),
          fn({ name: 'update_lead', workRole: 'ack', acknowledges: 'list_leads', workItemKind: 'lead' }),
          fn({ name: 'list_tasks', workRole: 'inbox', paired_ack: 'update_task', workItemKind: 'task' }),
          fn({ name: 'update_task', workRole: 'ack', acknowledges: 'list_tasks', workItemKind: 'task' }),
        ],
      }),
    ).toEqual([]);
  });

  it('catches violations on one pair without affecting validation of another', () => {
    const v = validateWorkPairs({
      salesforce: [
        fn({ name: 'list_leads', workRole: 'inbox', paired_ack: 'update_lead', workItemKind: 'lead' }),
        fn({ name: 'update_lead', workRole: 'ack', acknowledges: 'list_leads', workItemKind: 'lead' }),
        fn({ name: 'list_tasks', workRole: 'inbox', paired_ack: 'nowhere', workItemKind: 'task' }),
      ],
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ toolName: 'list_tasks', reason: 'paired_ack_not_found_in_connector' });
  });
});
