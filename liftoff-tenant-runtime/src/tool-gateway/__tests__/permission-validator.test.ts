// Permission Validator — regression tests for the integration→alias resolution
// chain. The bug class this guards against:
//
//   1. An internal agent is distilled with integration { id: <connector_uuid> }.
//   2. The user reconnects google_sheets in the UI; the platform backend
//      soft-deletes the OLD connectors row and inserts a NEW one with a fresh
//      UUID.
//   3. The connector_manifests upsert in the tenant runtime now sets `id` to
//      the NEW connector_id (per the Bug 4 fix).
//   4. The compiled instruction's integration record still references the OLD
//      connector_id. Resolving the manifest by `id` returns nothing.
//   5. Tool calls by alias (e.g. "google-sheets") are denied because the
//      allowlist contains only stale UUIDs and no aliases.
//
// The validator must resolve the integration to the CURRENT manifest alias
// using ANY of three strategies:
//   - by integration.type (preferred — type never changes after distillation)
//   - by id matching the current manifest.id directly
//   - by id matching a row in `connectors` (live or soft-deleted), then
//     joining through connector_type to find the current manifest

import { PermissionValidator } from '../permission-validator';

const queryMock = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
  getPool: () => ({ query: (...args: unknown[]) => queryMock(...args) }),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

describe('PermissionValidator.verifyConnectorAllowlist (integration → alias resolution)', () => {
  let validator: PermissionValidator;

  // SQL fragments — match against the actual rewritten query
  const isInstructionFetch = (sql: string) =>
    sql.includes('FROM compiled_instructions') &&
    sql.includes('WHERE tenant_id = $1');
  const isManifestResolve = (sql: string) =>
    sql.includes('FROM connector_manifests cm') &&
    sql.includes('cm.connector_type = ANY($2');
  const isKillSwitchCheck = (sql: string) =>
    sql.includes('connector_manifests') && sql.includes('enabled = false');
  const isAllowlistEntries = (sql: string) =>
    sql.includes('FROM action_allowlists') || sql.includes('action_allowlists');

  beforeEach(() => {
    validator = new PermissionValidator();
    queryMock.mockReset();
  });

  it('resolves integration by type when present (preferred path)', async () => {
    // Three queries to set up:
    //   1. kill switch check returns no disabled rows
    //   2. instruction fetch returns integrations with `type` field
    //   3. manifest resolve returns the alias by type
    //   4. allowlist entries returns at least one matching entry
    queryMock.mockImplementation(async (sql: string) => {
      if (isKillSwitchCheck(sql)) return { rows: [] };
      if (isInstructionFetch(sql)) {
        return {
          rows: [{
            instruction: null, // internal-agent path
            integrations: JSON.stringify([
              { id: 'OLD-stale-uuid-1', type: 'google_sheets', selectedObjects: [] },
            ]),
          }],
        };
      }
      if (isManifestResolve(sql)) {
        // The query receives integrationTypes=['google_sheets'] and integrationIds=['OLD-stale-uuid-1'].
        // The current manifest has alias 'google-sheets' and connector_type 'google_sheets'.
        // Strategy 1 (by type) hits.
        return { rows: [{ alias: 'google-sheets' }] };
      }
      if (isAllowlistEntries(sql)) {
        return { rows: [{
          id: 'allow-1', tenant_id: 't1', agent_id: 'a1', instruction_version: 1,
          connector: 'google-sheets', action_type: '*', entity_types: null,
          field_restrictions: null, conditions: null, enabled: true,
        }] };
      }
      return { rows: [] };
    });

    const result = await validator.validate({
      tenantId: 't1', agentId: 'a1', instructionVersion: 1,
      connector: 'google-sheets', actionType: 'read_spreadsheet',
      entityType: 'spreadsheet', payload: {},
    });

    expect(result.allowed).toBe(true);
  });

  it('resolves integration by stale id via connectors-table JOIN (legacy path, no type)', async () => {
    // Older instructions emitted before the platform-backend enrichment have NO
    // type field. The validator must JOIN through connectors to find the current
    // manifest. We simulate that by having the manifest-resolve query return
    // 'google-sheets' even though the integration only has the stale id.
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (isKillSwitchCheck(sql)) return { rows: [] };
      if (isInstructionFetch(sql)) {
        return {
          rows: [{
            instruction: null,
            integrations: JSON.stringify([
              { id: 'OLD-stale-uuid-2', selectedObjects: [] },
              // No `type` field — legacy
            ]),
          }],
        };
      }
      if (isManifestResolve(sql)) {
        // Verify the query was called with empty types and one id
        const types = params[1] as string[];
        const ids = params[2] as string[];
        expect(types).toEqual([]);
        expect(ids).toEqual(['OLD-stale-uuid-2']);
        // Strategy 3 hits: connectors row exists with the old id, type=google_sheets,
        // and the current manifest with that type has alias 'google-sheets'.
        return { rows: [{ alias: 'google-sheets' }] };
      }
      if (isAllowlistEntries(sql)) {
        return { rows: [{
          id: 'allow-2', tenant_id: 't1', agent_id: 'a1', instruction_version: 1,
          connector: 'google-sheets', action_type: '*', entity_types: null,
          field_restrictions: null, conditions: null, enabled: true,
        }] };
      }
      return { rows: [] };
    });

    const result = await validator.validate({
      tenantId: 't1', agentId: 'a1', instructionVersion: 1,
      connector: 'google-sheets', actionType: 'read_spreadsheet',
      entityType: 'spreadsheet', payload: {},
    });

    expect(result.allowed).toBe(true);
  });

  it('denies when neither type nor id can resolve to a manifest alias', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (isKillSwitchCheck(sql)) return { rows: [] };
      if (isInstructionFetch(sql)) {
        return {
          rows: [{
            instruction: null,
            integrations: JSON.stringify([
              { id: 'truly-unknown-uuid', selectedObjects: [] },
            ]),
          }],
        };
      }
      if (isManifestResolve(sql)) {
        return { rows: [] }; // no alias found by any strategy
      }
      return { rows: [] };
    });

    const result = await validator.validate({
      tenantId: 't1', agentId: 'a1', instructionVersion: 1,
      connector: 'google-sheets', actionType: 'read_spreadsheet',
      entityType: 'spreadsheet', payload: {},
    });

    expect(result.allowed).toBe(false);
  });

  it('passes integration types AND ids to the resolution query', async () => {
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (isKillSwitchCheck(sql)) return { rows: [] };
      if (isInstructionFetch(sql)) {
        return {
          rows: [{
            instruction: null,
            integrations: JSON.stringify([
              { id: 'uuid-A', type: 'google_sheets', selectedObjects: [] },
              { id: 'uuid-B', type: 'hubspot', selectedObjects: [] },
              { id: 'uuid-C', selectedObjects: [] }, // legacy, no type
            ]),
          }],
        };
      }
      if (isManifestResolve(sql)) {
        const types = params[1] as string[];
        const ids = params[2] as string[];
        // Both `types` and `ids` should be present, in the order encountered
        expect(types.sort()).toEqual(['google_sheets', 'hubspot']);
        expect(ids.sort()).toEqual(['uuid-A', 'uuid-B', 'uuid-C']);
        return { rows: [{ alias: 'google-sheets' }, { alias: 'hubspot' }] };
      }
      if (isAllowlistEntries(sql)) {
        return { rows: [{
          id: 'allow-3', tenant_id: 't1', agent_id: 'a1', instruction_version: 1,
          connector: 'google-sheets', action_type: '*', entity_types: null,
          field_restrictions: null, conditions: null, enabled: true,
        }] };
      }
      return { rows: [] };
    });

    const result = await validator.validate({
      tenantId: 't1', agentId: 'a1', instructionVersion: 1,
      connector: 'google-sheets', actionType: 'read_spreadsheet',
      entityType: 'spreadsheet', payload: {},
    });

    expect(result.allowed).toBe(true);
  });

  it('WS-A: bypasses ALL permission checks for __builtin:* sentinels (e.g. corpus search)', async () => {
    // Builtin TR tools tag themselves with the `__builtin:<name>` connector
    // sentinel so the dispatch table can route them, but they aren't real
    // connectors and they aren't subject to tenant connector/action policy:
    // they're features owned by the runtime. Without an early-pass at the
    // top of validate(), a support agent (or any agent using `search`) gets
    // rejected first at verifyConnectorAllowlist —
    //   "Connector '__builtin:search' is not in instruction's allowed
    //    connectors: [<real uuids>]"
    // — and even past that, getApplicableEntries returns no rows because
    // no `action_allowlists` entry exists for the synthetic sentinel.
    // The WS-A dispatch arm in agent-execution/service.ts is reachable
    // only past validate(), so this bypass is the second half of WS-A.
    //
    // Sentinel test: NO database query should fire at all.
    const result = await validator.validate({
      tenantId: 't1', agentId: 'a1', instructionVersion: 1,
      connector: '__builtin:search', actionType: 'search',
      entityType: 'search', payload: {},
    });

    expect(result.allowed).toBe(true);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
