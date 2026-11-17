// Tests for the Phase 4 backfill-pinned-knowledge job.
//
// Covers:
//   - safeStripAutoKnowledgeSection helper (pure function — strip vs preserve)
//   - runBackfillBatch driver: per-agent persistence, orphan filtering,
//     report-row writes, idempotency.

const mockPoolQuery = jest.fn()
const mockFindByIds = jest.fn()

jest.mock('../../infrastructure/database', () => {
  const __db: any = {
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
};
  const __mkc = () => (__db.getPool ? __db.getPool() : (__db.pool || { query: jest.fn() }));
  __db.withTenantScope = (_t: string, fn: (c: any) => any) => fn(__mkc());
  __db.withAdminScope = (_c: any, fn: (c: any) => any) => fn(__mkc());
  return __db;
})
jest.mock('../../knowledge/repository', () => ({
  findByIds: (...args: unknown[]) => mockFindByIds(...args),
}))
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import {
  safeStripAutoKnowledgeSection,
  runBackfillBatch,
} from '../backfill-pinned-knowledge'

describe('safeStripAutoKnowledgeSection', () => {
  it('strips when the section exactly matches the auto-generated shape', () => {
    const sp = 'You are an agent.\n\n## Knowledge\n- Article 1: https://x\n- Article 2'
    const items = [
      { title: 'Article 1', sourceUrl: 'https://x' },
      { title: 'Article 2', sourceUrl: null },
    ]
    expect(safeStripAutoKnowledgeSection(sp, items)).toBe('You are an agent.')
  })

  it('leaves hand-edited sections alone (extra lines)', () => {
    const sp = 'Prompt.\n\n## Knowledge\n- Article 1\n- A hand-added note'
    const items = [{ title: 'Article 1', sourceUrl: null }]
    expect(safeStripAutoKnowledgeSection(sp, items)).toBe(sp)
  })

  it('leaves hand-edited sections alone (reordered)', () => {
    const sp = 'Prompt.\n\n## Knowledge\n- B\n- A'
    const items = [
      { title: 'A', sourceUrl: null },
      { title: 'B', sourceUrl: null },
    ]
    expect(safeStripAutoKnowledgeSection(sp, items)).toBe(sp)
  })

  it('no-op when no ## Knowledge section present', () => {
    const sp = 'Just a plain prompt.'
    expect(safeStripAutoKnowledgeSection(sp, [])).toBe(sp)
  })

  it('strips empty-pin section when items are empty too', () => {
    const sp = 'Prompt.\n\n## Knowledge\n'
    expect(safeStripAutoKnowledgeSection(sp, [])).toBe(sp)
  })

  it('idempotent: stripping twice is no-op', () => {
    const sp = 'Prompt.\n\n## Knowledge\n- A'
    const items = [{ title: 'A', sourceUrl: null }]
    const once = safeStripAutoKnowledgeSection(sp, items)
    const twice = safeStripAutoKnowledgeSection(once, items)
    expect(twice).toBe(once)
    expect(once).toBe('Prompt.')
  })
})

describe('runBackfillBatch', () => {
  const CONNECTOR_BOUND = 'c-bound'
  const CONNECTOR_OTHER = 'c-other'
  // Real UUIDs — the backfill applies the same UUID_RE gate as
  // parseAndFilterPinnedKnowledge before calling findByIds, so non-UUID ids
  // would be classified as "malformed_uuid" and never reach this code path.
  const PIN_VALID = '11111111-1111-4111-8111-111111111111'
  const PIN_ORPHAN = '22222222-2222-4222-8222-222222222222'
  const PIN_MISSING = '44444444-4444-4444-8444-444444444444'
  const PIN_MALFORMED = 'not-a-uuid'
  const AGENT = 'agent-1'
  const TENANT = 'tenant-1'

  // Tracks which UPDATE / INSERT calls fired so assertions can inspect them.
  function recordedQuery(sql: string): boolean {
    return mockPoolQuery.mock.calls.some(c => (c[0] as string).includes(sql))
  }
  function lastUpdateParams(): unknown[] | null {
    const call = mockPoolQuery.mock.calls.find(c => (c[0] as string).includes('UPDATE internal_agents'))
    return call ? (call[1] as unknown[]) : null
  }
  function lastReportInsertParams(): unknown[] | null {
    const call = mockPoolQuery.mock.calls.find(c => (c[0] as string).includes('INSERT INTO pinned_knowledge_backfill_report'))
    return call ? (call[1] as unknown[]) : null
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('keeps valid pin, drops orphan pin, strips matching ## Knowledge section, writes report row', async () => {
    // SELECT … FROM internal_agents
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{
        id: AGENT,
        tenant_id: TENANT,
        responsibilities: `See [[knowledge:${PIN_VALID}:Valid]] and [[knowledge:${PIN_ORPHAN}:Orphan]]`,
        additional_context: null,
        system_prompt: 'Prompt.\n\n## Knowledge\n- Valid: https://v\n- Orphan',
        integrations: [{ id: CONNECTOR_BOUND }],
        pinned_knowledge_ids: [],
      }],
    })
    // UPDATE internal_agents (pins differ from empty → fires)
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    // INSERT INTO pinned_knowledge_backfill_report
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })

    mockFindByIds.mockResolvedValueOnce([
      { id: PIN_VALID, title: 'Valid', sourceUrl: 'https://v', connectorId: CONNECTOR_BOUND },
      { id: PIN_ORPHAN, title: 'Orphan', sourceUrl: null, connectorId: CONNECTOR_OTHER },
    ])

    const totals = await runBackfillBatch()

    expect(totals).toMatchObject({
      agentsProcessed: 1,
      pinsBackfilled: 1,
      pinsDroppedInvalid: 1,
      systemPromptsStripped: 1,
    })

    const updateParams = lastUpdateParams()
    expect(updateParams).not.toBeNull()
    // [pinned_knowledge_ids, stripped_system_prompt, agentId, tenantId]
    expect(updateParams![0]).toEqual([PIN_VALID])
    // System prompt was stripped (lines matched what buildKnowledgeSection
    // would have produced for the parsed marker set).
    expect(updateParams![1]).toBe('Prompt.')
    expect(updateParams![2]).toBe(AGENT)
    expect(updateParams![3]).toBe(TENANT)

    const reportParams = lastReportInsertParams()
    expect(reportParams).not.toBeNull()
    // [agentId, tenantId, pinsBackfilled, pinsDroppedInvalid, stripped, invalidDetails]
    expect(reportParams![2]).toBe(1)
    expect(reportParams![3]).toBe(1)
    expect(reportParams![4]).toBe(true)
    const invalidDetails = JSON.parse(reportParams![5] as string)
    expect(invalidDetails).toEqual([{ id: PIN_ORPHAN, reason: 'connector_not_bound' }])
  })

  it('drops missing-item pin with reason knowledge_item_deleted', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{
        id: AGENT,
        tenant_id: TENANT,
        responsibilities: `See [[knowledge:${PIN_MISSING}:Gone]]`,
        additional_context: null,
        system_prompt: '',
        integrations: [{ id: CONNECTOR_BOUND }],
        pinned_knowledge_ids: [],
      }],
    })
    // No update fires because pins remain empty AND system_prompt didn't change.
    // Only the report INSERT fires.
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })

    mockFindByIds.mockResolvedValueOnce([]) // item missing

    await runBackfillBatch()

    expect(recordedQuery('UPDATE internal_agents')).toBe(false)
    const reportParams = lastReportInsertParams()
    expect(reportParams![3]).toBe(1) // pinsDroppedInvalid
    const invalidDetails = JSON.parse(reportParams![5] as string)
    expect(invalidDetails).toEqual([{ id: PIN_MISSING, reason: 'knowledge_item_deleted' }])
  })

  it('leaves hand-edited ## Knowledge section alone', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{
        id: AGENT,
        tenant_id: TENANT,
        responsibilities: `[[knowledge:${PIN_VALID}:Valid]]`,
        additional_context: null,
        // Section contains extra operator-added line that doesn't match the
        // auto-generated shape — must be preserved verbatim.
        system_prompt: 'Prompt.\n\n## Knowledge\n- Valid\n- Hand-added note',
        integrations: [{ id: CONNECTOR_BOUND }],
        pinned_knowledge_ids: [],
      }],
    })
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }) // UPDATE (pins differ)
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }) // report insert

    mockFindByIds.mockResolvedValueOnce([
      { id: PIN_VALID, title: 'Valid', sourceUrl: null, connectorId: CONNECTOR_BOUND },
    ])

    const totals = await runBackfillBatch()
    expect(totals.systemPromptsStripped).toBe(0)
    expect(totals.systemPromptsLeftAlone).toBe(1)

    const updateParams = lastUpdateParams()
    expect(updateParams![1]).toBe('Prompt.\n\n## Knowledge\n- Valid\n- Hand-added note')
  })

  it('idempotent: second run with matching pin column + stripped prompt is a no-op (no UPDATE fires)', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{
        id: AGENT,
        tenant_id: TENANT,
        responsibilities: `[[knowledge:${PIN_VALID}:Valid]]`,
        additional_context: null,
        system_prompt: 'Prompt.',           // already stripped
        integrations: [{ id: CONNECTOR_BOUND }],
        pinned_knowledge_ids: [PIN_VALID],  // already backfilled
      }],
    })
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }) // report insert only

    mockFindByIds.mockResolvedValueOnce([
      { id: PIN_VALID, title: 'Valid', sourceUrl: null, connectorId: CONNECTOR_BOUND },
    ])

    const totals = await runBackfillBatch()

    expect(totals).toMatchObject({
      agentsProcessed: 1,
      pinsBackfilled: 1,
      pinsDroppedInvalid: 0,
      systemPromptsStripped: 0,
    })
    expect(recordedQuery('UPDATE internal_agents')).toBe(false)
    expect(recordedQuery('INSERT INTO pinned_knowledge_backfill_report')).toBe(true)
  })

  it('agent with no markers and no existing ## Knowledge is a no-op (only report insert)', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{
        id: AGENT,
        tenant_id: TENANT,
        responsibilities: 'plain text',
        additional_context: null,
        system_prompt: 'Just a prompt.',
        integrations: [],
        pinned_knowledge_ids: [],
      }],
    })
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }) // report insert

    const totals = await runBackfillBatch()

    expect(mockFindByIds).not.toHaveBeenCalled()
    expect(totals).toEqual({
      agentsProcessed: 1,
      pinsBackfilled: 0,
      pinsDroppedInvalid: 0,
      systemPromptsStripped: 0,
      systemPromptsLeftAlone: 0,
    })
    expect(recordedQuery('UPDATE internal_agents')).toBe(false)
  })

  it('skips system agents (tenant_id IS NULL filter in SELECT)', async () => {
    // SELECT … must include "AND tenant_id IS NOT NULL" so the cross-tenant
    // walk never returns CAIO / HRBP rows. Otherwise the per-row report
    // INSERT (pinned_knowledge_backfill_report.tenant_id is NOT NULL) would
    // fail and crash the entire batch.
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })

    await runBackfillBatch()

    const selectSql = mockPoolQuery.mock.calls[0][0] as string
    expect(selectSql).toMatch(/FROM internal_agents/)
    expect(selectSql).toMatch(/tenant_id IS NOT NULL/)
  })

  it('classifies malformed-UUID markers as pinsDroppedInvalid (reason malformed_uuid) without calling findByIds for them', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{
        id: AGENT,
        tenant_id: TENANT,
        // Two markers: one valid UUID, one operator-typed garbage.
        responsibilities: `[[knowledge:${PIN_VALID}:Valid]] [[knowledge:${PIN_MALFORMED}:Garbage]]`,
        additional_context: null,
        system_prompt: '',
        integrations: [{ id: CONNECTOR_BOUND }],
        pinned_knowledge_ids: [],
      }],
    })
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }) // UPDATE
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }) // report insert

    mockFindByIds.mockResolvedValueOnce([
      { id: PIN_VALID, title: 'Valid', sourceUrl: null, connectorId: CONNECTOR_BOUND },
    ])

    await runBackfillBatch()

    // findByIds must be called with only the well-formed UUID.
    expect(mockFindByIds).toHaveBeenCalledWith(TENANT, [PIN_VALID])

    const reportParams = lastReportInsertParams()
    expect(reportParams).not.toBeNull()
    expect(reportParams![2]).toBe(1)  // pinsBackfilled (just the valid one)
    expect(reportParams![3]).toBe(1)  // pinsDroppedInvalid (the garbage)
    const invalidDetails = JSON.parse(reportParams![5] as string)
    expect(invalidDetails).toEqual([{ id: PIN_MALFORMED, reason: 'malformed_uuid' }])
  })
})
