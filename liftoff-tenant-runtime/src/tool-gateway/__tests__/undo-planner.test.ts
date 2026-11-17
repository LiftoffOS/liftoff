// Undo planning.
//
// The load-bearing property is the refusal: a plan must not be produced when
// the remote entity has moved on, because restoring the old values would then
// discard whatever moved it. Every "Blocked" case below is a correct outcome,
// not a gap.

const mockGetAuditLog = jest.fn();
jest.mock('../../audit/service', () => ({ getAuditLog: (...a: unknown[]) => mockGetAuditLog(...a) }));

const mockFetchState = jest.fn();
jest.mock('../state-fetcher', () => ({
  stateFetcherRegistry: { fetchState: (...a: unknown[]) => mockFetchState(...a) },
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  buildRestorePayload,
  comparisonFieldsFor,
  entityIdFromArgs,
  planUndo,
  remoteStillMatches,
  splitLedgerAction,
} from '../undo-planner';

const TENANT = '11111111-1111-1111-1111-111111111111';
const AUDIT_ID = '22222222-2222-2222-2222-222222222222';

const resolveHubspot = () => 'hubspot';

/** A successful Salesforce Account update, which the registry gives a
 *  compare-and-set policy with a version token and a field comparison set. */
function salesforceUpdateEntry(over: Record<string, unknown> = {}) {
  return {
    id: AUDIT_ID,
    action: 'crm__update_record',
    outcome: 'success',
    inputArgs: { id: 'acct-1', entityType: 'Account', Name: 'New Name', Industry: 'Tech' },
    preActionSnapshot: { Name: 'Old Name', Industry: 'Retail', SystemModstamp: '2026-08-01T00:00:00Z' },
    postActionSnapshot: { Name: 'New Name', Industry: 'Tech', SystemModstamp: '2026-08-02T00:00:00Z' },
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchState.mockResolvedValue({
    data: { Name: 'New Name', Industry: 'Tech', SystemModstamp: '2026-08-02T00:00:00Z' },
    fetchedAt: new Date(),
    versionToken: '2026-08-02T00:00:00Z',
  });
});

describe('ledger action parsing', () => {
  it('splits an aliased connector tool name', () => {
    expect(splitLedgerAction('crm__update_deal')).toEqual({ alias: 'crm', actionType: 'update_deal' });
  });

  it('strips the SDK prefix and the server-key suffix', () => {
    expect(splitLedgerAction('mcp__github-a1b2c3__create_issue'))
      .toEqual({ alias: 'github', actionType: 'create_issue' });
  });

  it('reports no alias for a built-in tool', () => {
    expect(splitLedgerAction('memory_save')).toEqual({ alias: null, actionType: 'memory_save' });
  });
});

describe('entity identification', () => {
  it('finds the entity id under any of the usual keys', () => {
    expect(entityIdFromArgs({ record_id: 'r1' })).toBe('r1');
    expect(entityIdFromArgs({ id: 'x' })).toBe('x');
    expect(entityIdFromArgs({ issueId: 42 })).toBe('42');
  });

  it('returns null rather than guessing when there is no identifier', () => {
    expect(entityIdFromArgs({ query: 'all deals' })).toBeNull();
  });
});

describe('restore payload', () => {
  it('restores only the fields the action wrote', () => {
    const payload = buildRestorePayload(
      { id: 'a', Name: 'New', Industry: 'Tech' },
      { Name: 'Old', Industry: 'Retail', Untouched: 'keep' },
    );
    expect(payload).toEqual({ Name: 'Old', Industry: 'Retail' });
    expect(payload).not.toHaveProperty('Untouched');
  });

  it('skips a written field the snapshot never captured', () => {
    expect(buildRestorePayload({ id: 'a', Notes: 'x' }, { Name: 'Old' })).toEqual({});
  });
});

describe('compare-and-set', () => {
  const base = {
    postActionSnapshot: { Name: 'New', SystemModstamp: 'v2' },
    versionTokenField: 'SystemModstamp',
    fieldComparisonSet: ['Name'],
  };

  it('matches when the version token is unchanged', () => {
    expect(remoteStillMatches({ ...base, live: { SystemModstamp: 'v2' } })).toBe(true);
  });

  it('refuses when the version token has moved', () => {
    expect(remoteStillMatches({ ...base, live: { SystemModstamp: 'v3' } })).toBe(false);
  });

  it('falls back to field comparison when no version field is declared', () => {
    expect(remoteStillMatches({
      ...base, versionTokenField: null, live: { Name: 'New' },
    })).toBe(true);
    expect(remoteStillMatches({
      ...base, versionTokenField: null, live: { Name: 'Edited by someone else' },
    })).toBe(false);
  });

  it('refuses when there is no basis for the comparison at all', () => {
    expect(remoteStillMatches({
      ...base, versionTokenField: null, fieldComparisonSet: [], live: { Name: 'New' },
    })).toBe(false);
  });

  it('refuses when no post-action snapshot was captured', () => {
    expect(remoteStillMatches({ ...base, postActionSnapshot: null, live: {} })).toBe(false);
  });
});

describe('comparison fields', () => {
  it('prefers the policy declaration', () => {
    expect(comparisonFieldsFor({
      policyFieldComparisonSet: ['Name', 'Industry'],
      writtenFields: ['id', 'Notes'],
    })).toEqual(['Name', 'Industry']);
  });

  it('falls back to the fields the action wrote, minus the identifier', () => {
    expect(comparisonFieldsFor({
      policyFieldComparisonSet: [],
      writtenFields: ['id', 'Name', 'Stage'],
    })).toEqual(['Name', 'Stage']);
  });

  it('reports no basis when the action wrote nothing comparable', () => {
    expect(comparisonFieldsFor({ policyFieldComparisonSet: [], writtenFields: ['id'] })).toEqual([]);
  });

  it('drops routing arguments, which are not fields of the entity', () => {
    expect(comparisonFieldsFor({
      policyFieldComparisonSet: [],
      writtenFields: ['id', 'entityType', 'connector', 'Name'],
    })).toEqual(['Name']);
  });
});

describe('no-basis detection', () => {
  it('does not read two absent fields as a match', () => {
    // The failure this guards: comparing undefined to undefined reports
    // "unchanged" and turns an unverifiable undo into an approved one.
    expect(remoteStillMatches({
      live: {},
      postActionSnapshot: {},
      versionTokenField: null,
      fieldComparisonSet: ['Name'],
    })).toBe(false);
  });

  it('compares only the declared fields the snapshot actually captured', () => {
    expect(remoteStillMatches({
      live: { Name: 'same', Other: 'drifted' },
      postActionSnapshot: { Name: 'same' },
      versionTokenField: null,
      fieldComparisonSet: ['Name', 'NeverCaptured'],
    })).toBe(true);
  });
});

describe('planUndo', () => {
  it('plans a restore when the entity is untouched since the action', async () => {
    mockGetAuditLog.mockResolvedValue(salesforceUpdateEntry());
    const plan = await planUndo({
      tenantId: TENANT,
      auditLogId: AUDIT_ID,
      resolveConnectorType: () => 'salesforce',
    });

    expect(plan.status).toBe('Partial'); // salesforce Account declares partial undo
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0]).toMatchObject({
      connector: 'salesforce',
      entityType: 'Account',
      entityId: 'acct-1',
      kind: 'restore_fields',
      payload: { Name: 'Old Name', Industry: 'Retail' },
      versionTokenField: 'SystemModstamp',
    });
    expect(plan.operations[0].expectedCurrent).toEqual(salesforceUpdateEntry().postActionSnapshot);
    expect(plan.blockers[0].reason).toMatch(/partial undo/i);
  });

  it('REFUSES when the entity changed after the action — the whole point', async () => {
    mockGetAuditLog.mockResolvedValue(salesforceUpdateEntry());
    mockFetchState.mockResolvedValue({
      data: { Name: 'Someone else edited this', SystemModstamp: '2026-08-05T00:00:00Z' },
      fetchedAt: new Date(),
      versionToken: '2026-08-05T00:00:00Z',
    });

    const plan = await planUndo({
      tenantId: TENANT, auditLogId: AUDIT_ID, resolveConnectorType: () => 'salesforce',
    });
    expect(plan.status).toBe('Blocked');
    expect(plan.operations).toEqual([]);
    expect(plan.blockers[0].reason).toMatch(/has changed since this action ran/i);
  });

  it('refuses when the live state cannot be read, rather than assuming it is safe', async () => {
    mockGetAuditLog.mockResolvedValue(salesforceUpdateEntry());
    mockFetchState.mockRejectedValue(new Error('connector unreachable'));

    const plan = await planUndo({
      tenantId: TENANT, auditLogId: AUDIT_ID, resolveConnectorType: () => 'salesforce',
    });
    expect(plan.status).toBe('Blocked');
    expect(plan.blockers[0].reason).toMatch(/could not be read/i);
  });

  it('refuses an action that did not succeed', async () => {
    mockGetAuditLog.mockResolvedValue(salesforceUpdateEntry({ outcome: 'error' }));
    const plan = await planUndo({
      tenantId: TENANT, auditLogId: AUDIT_ID, resolveConnectorType: () => 'salesforce',
    });
    expect(plan.status).toBe('Blocked');
    expect(plan.blockers[0].reason).toMatch(/did not succeed/i);
    expect(mockFetchState).not.toHaveBeenCalled();
  });

  it('refuses a gated action, which never ran', async () => {
    mockGetAuditLog.mockResolvedValue(salesforceUpdateEntry({ outcome: 'gated' }));
    const plan = await planUndo({
      tenantId: TENANT, auditLogId: AUDIT_ID, resolveConnectorType: () => 'salesforce',
    });
    expect(plan.status).toBe('Blocked');
  });

  it('refuses when the before-state was never captured', async () => {
    mockGetAuditLog.mockResolvedValue(salesforceUpdateEntry({ preActionSnapshot: null }));
    const plan = await planUndo({
      tenantId: TENANT, auditLogId: AUDIT_ID, resolveConnectorType: () => 'salesforce',
    });
    expect(plan.status).toBe('Blocked');
    expect(plan.blockers[0].reason).toMatch(/no before-state/i);
  });

  it('refuses a delete — writing cannot bring a record back', async () => {
    mockGetAuditLog.mockResolvedValue(salesforceUpdateEntry({ action: 'crm__delete_record' }));
    const plan = await planUndo({
      tenantId: TENANT, auditLogId: AUDIT_ID, resolveConnectorType: () => 'salesforce',
    });
    expect(plan.status).toBe('Blocked');
    expect(plan.blockers[0].reason).toMatch(/no inverse/i);
  });

  it('refuses a bulk action that names no single entity', async () => {
    mockGetAuditLog.mockResolvedValue(salesforceUpdateEntry({
      inputArgs: { ids: ['a', 'b', 'c'], Stage: 'Closed' },
    }));
    const plan = await planUndo({
      tenantId: TENANT, auditLogId: AUDIT_ID, resolveConnectorType: () => 'salesforce',
    });
    expect(plan.status).toBe('Blocked');
    expect(plan.blockers[0].reason).toMatch(/no single entity/i);
  });

  it('refuses when the connector declares no undo support', async () => {
    // An unknown connector/entity falls to the registry's restrictive default,
    // which is undoSupportMode 'none'.
    mockGetAuditLog.mockResolvedValue(salesforceUpdateEntry({
      inputArgs: { id: 'x', entityType: 'SomethingUnmodelled', Field: 'v' },
    }));
    const plan = await planUndo({
      tenantId: TENANT, auditLogId: AUDIT_ID, resolveConnectorType: resolveHubspot,
    });
    expect(plan.status).toBe('Blocked');
    expect(plan.undoSupportMode).toBe('none');
    expect(plan.blockers[0].reason).toMatch(/no supported undo/i);
  });

  it('refuses when the connector is no longer bound', async () => {
    mockGetAuditLog.mockResolvedValue(salesforceUpdateEntry());
    const plan = await planUndo({
      tenantId: TENANT, auditLogId: AUDIT_ID, resolveConnectorType: () => null,
    });
    expect(plan.status).toBe('Blocked');
    expect(plan.blockers[0].reason).toMatch(/no connector is bound/i);
  });

  it('refuses a ledger entry that is not a connector action', async () => {
    mockGetAuditLog.mockResolvedValue(salesforceUpdateEntry({ action: 'memory_save' }));
    const plan = await planUndo({
      tenantId: TENANT, auditLogId: AUDIT_ID, resolveConnectorType: () => 'salesforce',
    });
    expect(plan.status).toBe('Blocked');
    expect(plan.blockers[0].reason).toMatch(/not a connector action/i);
  });

  it('reports a missing ledger entry rather than throwing', async () => {
    mockGetAuditLog.mockResolvedValue(null);
    const plan = await planUndo({
      tenantId: TENANT, auditLogId: AUDIT_ID, resolveConnectorType: () => 'salesforce',
    });
    expect(plan.status).toBe('Blocked');
    expect(plan.blockers[0].reason).toMatch(/no ledger entry/i);
  });

  it('plans a delete for an action that created something', async () => {
    // The create policy declares no version token and no comparison set, so
    // the fields the create WROTE are the basis: unchanged means the record is
    // still exactly what the agent made, and removing it discards nobody's work.
    mockGetAuditLog.mockResolvedValue(salesforceUpdateEntry({
      action: 'crm__create_record',
      inputArgs: { id: 'new-1', entityType: 'Contact', Name: 'Someone' },
      postActionSnapshot: { Name: 'Someone' },
    }));
    mockFetchState.mockResolvedValue({
      data: { Name: 'Someone' },
      fetchedAt: new Date(),
    });
    const plan = await planUndo({
      tenantId: TENANT, auditLogId: AUDIT_ID, resolveConnectorType: () => 'salesforce',
    });
    // Salesforce create declares 'full' undo — the record can simply be deleted.
    expect(plan.status).toBe('Complete');
    expect(plan.undoSupportMode).toBe('full');
    expect(plan.operations[0]?.kind).toBe('delete_created');
    expect(plan.operations[0]?.payload).toEqual({});
    expect(plan.blockers).toEqual([]);
  });

  it('refuses to delete a created record that someone has since edited', async () => {
    mockGetAuditLog.mockResolvedValue(salesforceUpdateEntry({
      action: 'crm__create_record',
      inputArgs: { id: 'new-1', entityType: 'Contact', Name: 'Someone' },
      postActionSnapshot: { Name: 'Someone' },
    }));
    mockFetchState.mockResolvedValue({
      data: { Name: 'Someone, renamed by a human' },
      fetchedAt: new Date(),
    });
    const plan = await planUndo({
      tenantId: TENANT, auditLogId: AUDIT_ID, resolveConnectorType: () => 'salesforce',
    });
    expect(plan.status).toBe('Blocked');
    expect(plan.blockers[0].reason).toMatch(/has changed since this action ran/i);
  });

  it('says so when there is no way to tell whether the entity changed', async () => {
    // Nothing comparable: no version token from the policy, and the action
    // recorded only an identifier.
    mockGetAuditLog.mockResolvedValue(salesforceUpdateEntry({
      action: 'crm__create_record',
      inputArgs: { id: 'new-1', entityType: 'Contact' },
      postActionSnapshot: {},
    }));
    mockFetchState.mockResolvedValue({ data: {}, fetchedAt: new Date() });
    const plan = await planUndo({
      tenantId: TENANT, auditLogId: AUDIT_ID, resolveConnectorType: () => 'salesforce',
    });
    expect(plan.status).toBe('Blocked');
    expect(plan.blockers[0].reason).toMatch(/cannot be established/i);
  });
});
