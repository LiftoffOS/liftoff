import {
  ToolClassifier,
  effectClassFromBands,
  includedByBands,
  mapSensitivityToActionCategories,
} from '../tool-classifier';
import { llmClient } from '../../llm/client';
import { ask } from '../../typesafe/client';
import { CLASSIFIER_SET } from '../../typesafe/questions';

jest.mock('../../llm/client');
// Jev is the classifier; the generation prompt is the fallback when `ask`
// returns null. The existing cases below exercise the fallback, so `ask`
// answers null unless a case says otherwise.
jest.mock('../../typesafe/client', () => ({ ask: jest.fn().mockResolvedValue(null) }));

const mockQuery = jest.fn();
(global as any).__mockToolClassifierQuery = mockQuery;
jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...args: unknown[]) => (global as any).__mockToolClassifierQuery(...args) },
}));

const mockDb = { query: mockQuery } as any;

describe('ToolClassifier', () => {
  let classifier: ToolClassifier;

  beforeEach(() => {
    classifier = new ToolClassifier(mockDb, llmClient);
    jest.clearAllMocks();
  });

  describe('classifyTool', () => {
    it('returns valid categories for send_email tool', async () => {
      (llmClient.complete as jest.Mock).mockResolvedValue({
        content: JSON.stringify({ categories: ['customerCommunication'] })
      });

      const { categories } = await classifier.classifyTool({
        name: 'send_email',
        description: 'Send an email to a customer'
      });

      expect(categories).toEqual(['customerCommunication']);
    });

    it('returns empty array for read-only tools', async () => {
      (llmClient.complete as jest.Mock).mockResolvedValue({
        content: JSON.stringify({ categories: [] })
      });

      const { categories } = await classifier.classifyTool({
        name: 'get_user',
        description: 'Retrieve user information'
      });

      expect(categories).toEqual([]);
    });

    it('filters invalid category values', async () => {
      (llmClient.complete as jest.Mock).mockResolvedValue({
        content: JSON.stringify({ categories: ['customerCommunication', 'invalidCategory', 'dataChanges'] })
      });

      const { categories } = await classifier.classifyTool({
        name: 'send_email',
        description: 'Send email'
      });

      expect(categories).toEqual(['customerCommunication', 'dataChanges']);
      expect(categories).not.toContain('invalidCategory');
    });
  });

  describe('validateCategories', () => {
    it('filters out invalid category names', () => {
      const result = classifier.validateCategories([
        'customerCommunication',
        'invalid',
        'financialActions'
      ]);
      expect(result).toEqual(['customerCommunication', 'financialActions']);
    });
  });

  describe('hashDescription', () => {
    it('produces consistent 12-char hashes', () => {
      const hash1 = classifier.hashDescription('test description');
      const hash2 = classifier.hashDescription('test description');

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(12);
      expect(hash1).toMatch(/^[a-f0-9]{12}$/);
    });

    it('produces different hashes for different descriptions', () => {
      const hash1 = classifier.hashDescription('description 1');
      const hash2 = classifier.hashDescription('description 2');

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('getCachedClassification', () => {
    it('returns null for missing tools', async () => {
      (mockDb.query as jest.Mock).mockResolvedValue({ rows: [] });

      const result = await classifier.getCachedClassification('unknown_tool');
      expect(result).toBeNull();
    });

    it('returns cached categories for known tools', async () => {
      (mockDb.query as jest.Mock).mockResolvedValue({
        rows: [{ categories: ['dataChanges'], tool_description_hash: 'abc123def456' }]
      });

      const result = await classifier.getCachedClassification('known_tool');
      expect(result).toEqual(expect.objectContaining({
        categories: ['dataChanges'],
        toolDescriptionHash: 'abc123def456'
      }));
    });

    it('qualifies the lookup by integration_type so two servers cannot collide on a tool name', async () => {
      (mockDb.query as jest.Mock).mockResolvedValue({ rows: [] });
      await classifier.getCachedClassification('search', 'custom_mcp_server:abc', 'tenant-1');
      // The integration_type must reach the query params; matching a typed row by
      // bare tool name is exactly the collision migration 458 closes.
      const params = (mockDb.query as jest.Mock).mock.calls[0][1] as unknown[];
      expect(params).toContain('custom_mcp_server:abc');
    });

    it('a lookup with no integration_type does not carry a spurious type', async () => {
      (mockDb.query as jest.Mock).mockResolvedValue({ rows: [] });
      await classifier.getCachedClassification('search');
      const params = (mockDb.query as jest.Mock).mock.calls[0][1] as unknown[];
      // null (COALESCEd to '') — a no-type caller matches only an untyped/global row.
      expect(params).toContain(null);
    });
  });

  // TE-006: Determinism tests
  describe('classification determinism', () => {
    it('returns same result for same input', async () => {
      const tool = { name: 'test_tool', description: 'Test description' };

      // classifyTool always calls LLM — determinism is via classifyToolDeterministic
      (llmClient.complete as jest.Mock).mockResolvedValue({
        content: JSON.stringify({ categories: ['dataChanges'] })
      });
      const result1 = (await classifier.classifyTool(tool)).categories;
      const result2 = (await classifier.classifyTool(tool)).categories;

      expect(result1).toEqual(result2);
      expect(llmClient.complete).toHaveBeenCalledTimes(2);
    });

    it('uses responseSchema for structured output', async () => {
      await classifier.classifyTool({ name: 'test', description: 'test' });

      expect(llmClient.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          responseSchema: expect.objectContaining({
            name: 'classify_tool',
            schema: expect.objectContaining({
              type: 'object',
              properties: expect.objectContaining({
                categories: expect.any(Object)
              })
            })
          })
        }),
        undefined,
        expect.objectContaining({ purpose: 'tool_classification' }),
      );
    });
  });

  // Phase 0.3: classifyAndCache
  describe('classifyAndCache', () => {
    it('calls LLM for uncached tools', async () => {
      (mockDb.query as jest.Mock).mockResolvedValue({ rows: [] });
      (llmClient.complete as jest.Mock).mockResolvedValue({
        content: JSON.stringify({ categories: ['dataChanges'] })
      });

      const categories = await classifier.classifyAndCache(
        { name: 'create_issue', description: 'Create a new issue' },
        'github'
      );

      expect(categories).toEqual(['dataChanges']);
      expect(llmClient.complete).toHaveBeenCalled();
    });

    it('returns manual override categories when set', async () => {
      (mockDb.query as jest.Mock).mockResolvedValue({
        rows: [{
          tool_name: 'custom_tool',
          integration_type: 'test',
          tool_description_hash: 'abc123def456',
          categories: ['financialActions'],
          draft_variant: null,
          classified_at: new Date(),
          reviewed_by: 'admin',
          is_manual_override: true,
          tenant_id: null,
        }]
      });

      const categories = await classifier.classifyAndCache(
        { name: 'custom_tool', description: 'Custom tool' },
        'test'
      );

      expect(categories).toEqual(['financialActions']);
      expect(llmClient.complete).not.toHaveBeenCalled();
    });

    it('treats financial connectors the same as any other', async () => {
      (mockDb.query as jest.Mock).mockResolvedValue({ rows: [] });
      (llmClient.complete as jest.Mock).mockResolvedValue({
        content: JSON.stringify({ categories: ['financialActions', 'dataChanges'] })
      });

      const categories = await classifier.classifyAndCache(
        { name: 'create_refund', description: 'Create a refund for a charge' },
        'stripe'
      );

      expect(categories).toEqual(['financialActions', 'dataChanges']);
      expect(llmClient.complete).toHaveBeenCalled();
    });
  });

  // Phase 0.3: tenant isolation
  describe('tenant isolation (SE-008)', () => {
    it('returns tenant-specific classification when available', async () => {
      (mockDb.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [{
            tool_name: 'send_email',
            integration_type: 'google_mail',
            tool_description_hash: 'abc',
            categories: ['customerCommunication', 'financialActions'],
            draft_variant: null,
            classified_at: new Date(),
            reviewed_by: 'admin',
            is_manual_override: true,
            tenant_id: 'tenant-123',
          }]
        });

      const result = await classifier.getCachedClassification('send_email', 'google_mail', 'tenant-123');
      expect(result?.categories).toEqual(['customerCommunication', 'financialActions']);
      expect(result?.tenantId).toBe('tenant-123');
    });

    it('falls back to global when no tenant-specific override', async () => {
      (mockDb.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [] }) // tenant-specific miss
        .mockResolvedValueOnce({
          rows: [{
            tool_name: 'send_email',
            integration_type: 'google_mail',
            tool_description_hash: 'abc',
            categories: ['customerCommunication'],
            draft_variant: null,
            classified_at: new Date(),
            reviewed_by: null,
            is_manual_override: false,
            tenant_id: null,
          }]
        });

      const result = await classifier.getCachedClassification('send_email', 'google_mail', 'tenant-456');
      expect(result?.categories).toEqual(['customerCommunication']);
      expect(result?.tenantId).toBeNull();
    });
  });

  describe('setManualOverride identity', () => {
    it('writes under the connector integration_type, not a "manual" sentinel', async () => {
      (mockDb.query as jest.Mock).mockResolvedValue({ rows: [] });

      await classifier.setManualOverride('create_refund', 'stripe', ['financialActions'], 'admin@x', 'tenant-1');

      // cacheClassification INSERT params:
      //   [tool_name, integration_type, hash, categories, draft, reviewed_by, is_manual_override, tenant_id]
      // cacheClassification INSERT params (migration 507 added effect_class and
      // classification_version at $9 and $10):
      //   [tool_name, integration_type, hash, categories, draft, reviewed_by, is_manual_override, tenant_id, effect_class, classification_version]
      const params = (mockDb.query as jest.Mock).mock.calls[0][1] as unknown[];
      expect(params[0]).toBe('create_refund');
      // The identity fix: the row is keyed by the connector's real type, so the
      // connector-qualified read finds it. 'manual' here is exactly the collision bug.
      expect(params[1]).toBe('stripe');
      expect(params[1]).not.toBe('manual');
      expect(params[5]).toBe('admin@x');   // reviewed_by
      expect(params[6]).toBe(true);        // is_manual_override
      expect(params[7]).toBe('tenant-1');  // tenant_id
    });

    it('is found by the connector-qualified lookup it is stored under', async () => {
      // Round-trip: an override set for (create_refund, stripe, tenant-1) is returned
      // by getCachedClassification(create_refund, stripe, tenant-1). Under the old
      // integration_type='manual' write, that lookup (COALESCE(integration_type,'')='stripe')
      // returned nothing and the review silently did not apply.
      (mockDb.query as jest.Mock).mockResolvedValueOnce({
        rows: [{
          tool_name: 'create_refund',
          integration_type: 'stripe',
          tool_description_hash: '',
          categories: ['financialActions'],
          draft_variant: null,
          classified_at: new Date(),
          reviewed_by: 'admin@x',
          is_manual_override: true,
          tenant_id: 'tenant-1',
        }]
      });

      const cached = await classifier.getCachedClassification('create_refund', 'stripe', 'tenant-1');
      const lookupParams = (mockDb.query as jest.Mock).mock.calls[0][1] as unknown[];
      expect(lookupParams).toContain('stripe');
      expect(cached?.isManualOverride).toBe(true);
      expect(cached?.categories).toEqual(['financialActions']);
    });
  });
});

// Taxonomy mapping tests
describe('mapSensitivityToActionCategories (BE-009)', () => {
  it('maps customerCommunication to outbound', () => {
    expect(mapSensitivityToActionCategories(['customerCommunication'])).toEqual(['outbound']);
  });

  it('maps financialActions to write + sensitive', () => {
    const result = mapSensitivityToActionCategories(['financialActions']);
    expect(result).toContain('write');
    expect(result).toContain('sensitive');
  });

  it('maps dataChanges to write', () => {
    expect(mapSensitivityToActionCategories(['dataChanges'])).toEqual(['write']);
  });

  it('deduplicates when multiple categories map to same action', () => {
    const result = mapSensitivityToActionCategories(['dataChanges', 'financialActions']);
    const writeCount = result.filter(c => c === 'write').length;
    expect(writeCount).toBe(1); // deduplicated
  });
});


// ── Phase 1: Jev classifies, the generation prompt is the fallback ─────────

function jevAnswer(perCategory: Record<string, number>, effect: Record<string, number>) {
  const answers: Record<string, unknown> = {};
  for (const [cat, pYes] of Object.entries(perCategory)) {
    answers[cat] = { type: 'choice', choice: pYes >= 0.5 ? 'yes' : 'no', confidence: 1, probabilities: { yes: pYes, no: 1 - pYes } };
  }
  const best = Object.entries(effect).sort((a, b) => b[1] - a[1])[0][0];
  answers.effect = { type: 'choice', choice: best, confidence: 1, probabilities: effect };
  return { answers, model: CLASSIFIER_SET.model, usage: { inputTokens: 10, outputTokens: 1 }, callId: 'c', attempts: 1, latencyMs: 1 };
}

const ALL_NO = { customerCommunication: 0, financialActions: 0, dataChanges: 0, externalPublishing: 0, hiringDecisions: 0 };
const READ = { read: 0.95, write: 0.02, destructive: 0.01, outbound: 0.01, unclear: 0.01 };

describe('the three-band rule', () => {
  const { INCLUDE_T, EXCLUDE_T } = CLASSIFIER_SET.thresholds as Record<string, number>;
  it('includes at or above INCLUDE_T, excludes at or below EXCLUDE_T, includes between', () => {
    expect(includedByBands(INCLUDE_T, INCLUDE_T, EXCLUDE_T)).toBe(true);
    expect(includedByBands(EXCLUDE_T, INCLUDE_T, EXCLUDE_T)).toBe(false);
    expect(includedByBands((INCLUDE_T + EXCLUDE_T) / 2, INCLUDE_T, EXCLUDE_T)).toBe(true);
    expect(includedByBands(0, INCLUDE_T, EXCLUDE_T)).toBe(false);
    expect(includedByBands(1, INCLUDE_T, EXCLUDE_T)).toBe(true);
  });
});

describe('1b: the effect band rule', () => {
  it('stores read only on a confident read with every category excluded', () => {
    expect(effectClassFromBands(READ, true, 0.7, 0.5)).toBe('read');
    expect(effectClassFromBands(READ, false, 0.7, 0.5)).toBeNull();
    expect(effectClassFromBands({ ...READ, read: 0.69 }, true, 0.7, 0.5)).toBeNull();
  });
  it('stores the most restrictive answer at or above EFFECT_T, and null on uncertainty', () => {
    expect(effectClassFromBands({ read: 0, write: 0.2, destructive: 0.55, outbound: 0.2, unclear: 0.05 }, false, 0.7, 0.5)).toBe('destructive');
    expect(effectClassFromBands({ read: 0, write: 0.3, destructive: 0.1, outbound: 0.55, unclear: 0.05 }, false, 0.7, 0.5)).toBe('outbound');
    expect(effectClassFromBands({ read: 0, write: 0.8, destructive: 0.1, outbound: 0.05, unclear: 0.05 }, false, 0.7, 0.5)).toBe('write');
    expect(effectClassFromBands({ read: 0.3, write: 0.3, destructive: 0.2, outbound: 0.1, unclear: 0.1 }, false, 0.7, 0.5)).toBeNull();
    expect(effectClassFromBands({ read: 0, write: 0, destructive: 0, outbound: 0, unclear: 1 }, true, 0.7, 0.5)).toBeNull();
  });
});

describe('classifyTool with Jev', () => {
  let classifier: ToolClassifier;
  beforeEach(() => {
    classifier = new ToolClassifier(mockDb, llmClient);
    jest.clearAllMocks();
    delete process.env.TYPESAFE_CLASSIFIER_ENABLED;
  });

  it('uses the Jev answer and never the generation when Jev answers', async () => {
    (ask as jest.Mock).mockResolvedValueOnce(jevAnswer(
      { ...ALL_NO, dataChanges: 0.9 },
      { read: 0.01, write: 0.05, destructive: 0.9, outbound: 0.02, unclear: 0.02 },
    ));
    const r = await classifier.classifyTool({ name: 'delete_record', description: 'Deletes a record' }, { purpose: 'tool_classification', tenantId: 't1' });
    expect(r).toEqual({ categories: ['dataChanges'], effectClass: 'destructive', by: 'jev' });
    expect(llmClient.complete).not.toHaveBeenCalled();
  });

  it('falls to the generation on null, then to keywords on a generation failure', async () => {
    (ask as jest.Mock).mockResolvedValueOnce(null);
    (llmClient.complete as jest.Mock).mockResolvedValueOnce({ content: JSON.stringify({ categories: ['externalPublishing'] }) });
    const r = await classifier.classifyTool({ name: 'post_message', description: 'Posts' }, { purpose: 'tool_classification', tenantId: 't1' });
    expect(r).toEqual({ categories: ['externalPublishing'], by: 'generation' });

    (ask as jest.Mock).mockResolvedValueOnce(null);
    (llmClient.complete as jest.Mock).mockRejectedValueOnce(new Error('down'));
    const k = await classifier.classifyTool({ name: 'send_email', description: 'Sends' });
    expect(k).toEqual({ categories: ['customerCommunication'], by: 'keywords' });
  });

  it('the kill never calls ask', async () => {
    process.env.TYPESAFE_CLASSIFIER_ENABLED = '0';
    (llmClient.complete as jest.Mock).mockResolvedValueOnce({ content: JSON.stringify({ categories: [] }) });
    await classifier.classifyTool({ name: 'get_user', description: 'Gets' }, { purpose: 'tool_classification', tenantId: 't1' });
    expect(ask).not.toHaveBeenCalled();
    expect(llmClient.complete).toHaveBeenCalledTimes(1);
  });

  it('carries tenant and purpose on both paths', async () => {
    (ask as jest.Mock).mockResolvedValueOnce(null);
    (llmClient.complete as jest.Mock).mockResolvedValueOnce({ content: JSON.stringify({ categories: [] }) });
    await classifier.classifyTool({ name: 'get_user', description: 'Gets' }, { purpose: 'tool_classification', tenantId: 't1' });
    expect(ask).toHaveBeenCalledWith(
      CLASSIFIER_SET,
      { tool: { name: 'get_user', description: 'Gets' } },
      expect.objectContaining({ purpose: 'tool_classification', tenantId: 't1', deadlineMs: 4_000, attemptTimeoutMs: 2_500, maxRetries: 1 }),
    );
    expect(llmClient.complete).toHaveBeenCalledWith(
      expect.anything(), undefined, { purpose: 'tool_classification', tenantId: 't1' },
    );
  });

  it('a read with a sensitivity category present is not stored as read', async () => {
    (ask as jest.Mock).mockResolvedValueOnce(jevAnswer({ ...ALL_NO, financialActions: 0.8 }, READ));
    const r = await classifier.classifyTool({ name: 'get_invoice', description: 'Reads an invoice' }, { purpose: 'tool_classification', tenantId: 't1' });
    expect(r.categories).toEqual(['financialActions']);
    expect(r.effectClass).toBeNull();
  });

  it('a manual override wins over a fresh classification in the upsert, effect class included', async () => {
    (mockDb.query as jest.Mock).mockResolvedValue({ rows: [] });
    await classifier.cacheClassification('t', 'x', 'h', ['dataChanges'], undefined, { tenantId: 't1', effectClass: 'write', classificationVersion: 1 });
    const sql = (mockDb.query as jest.Mock).mock.calls[0][0] as string;
    expect(sql).toContain('effect_class = CASE');
    expect(sql).toContain('WHEN tool_classification_cache.is_manual_override = true AND EXCLUDED.is_manual_override = false');
    const params = (mockDb.query as jest.Mock).mock.calls[0][1] as unknown[];
    expect(params[8]).toBe('write');
    expect(params[9]).toBe(1);
  });
});
