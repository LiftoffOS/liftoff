// The pipeline's classification stage with a cached-classification lookup:
// a current row is reused, a mismatch or a stale version classifies, a
// throwing lookup classifies, no lookup classifies all, and the pipeline
// never writes the cache.

jest.mock('../client', () => ({
  MCPClient: jest.fn().mockImplementation(() => ({
    discover: jest.fn().mockResolvedValue({
      serverName: 's',
      tools: [
        { name: 'enrich_company', description: 'Enrich a company record', inputSchema: { type: 'object' } },
        { name: 'delete_record', description: 'Delete a record', inputSchema: { type: 'object' } },
      ],
      resources: [],
      transportType: 'http',
      degradedTools: [],
    }),
  })),
}));
jest.mock('../../common/url-guard', () => ({ assertPublicUrl: jest.fn().mockResolvedValue(undefined), BlockedUrlError: class extends Error {} }));
jest.mock('../capability-analyzer', () => ({ analyzeCapabilities: jest.fn().mockResolvedValue({ capabilities: [], resources: [], summary: '', collaborationHints: '' }) }));
jest.mock('../../injection-detection/gating', () => ({ screenToolDefinitions: jest.fn().mockResolvedValue([]) }));
jest.mock('../../infrastructure/logging', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../tool-classifier', () => {
  const actual = jest.requireActual('../tool-classifier');
  return {
    ...actual,
    toolClassifier: {
      classifyTool: jest.fn(),
      cacheClassification: jest.fn(),
      getCachedClassification: jest.fn(),
    },
  };
});

import { runDiscoveryPipeline, cachedClassificationIsCurrent } from '../discovery-pipeline';
import { hashDescription, toolClassifier, type CachedClassification } from '../tool-classifier';
import { CLASSIFICATION_VERSION } from '../../typesafe/questions';

const INPUT = { endpointUrl: 'https://example.test/mcp', name: 'srv', authType: 'none' as const, tenantId: 't1' };

function cached(over: Partial<CachedClassification> = {}): CachedClassification {
  return {
    toolName: 'enrich_company', integrationType: 'custom_mcp_server:x', toolDescriptionHash: hashDescription('Enrich a company record'),
    categories: [], draftVariant: null, classifiedAt: new Date(), reviewedBy: null, isManualOverride: false, tenantId: 't1',
    effectClass: 'read', classificationVersion: CLASSIFICATION_VERSION, ...over,
  };
}

describe('discovery pipeline classification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.TYPESAFE_CLASSIFIER_ENABLED;
    (toolClassifier.classifyTool as jest.Mock).mockImplementation(async (tool: { name: string }) =>
      tool.name === 'delete_record'
        ? { categories: ['dataChanges'], effectClass: 'destructive', by: 'jev' }
        : { categories: [], effectClass: 'read', by: 'jev' });
  });

  it('no lookup classifies all and never writes the cache', async () => {
    const out = await runDiscoveryPipeline(INPUT, () => undefined);
    expect(toolClassifier.classifyTool).toHaveBeenCalledTimes(2);
    expect(toolClassifier.cacheClassification).not.toHaveBeenCalled();
    expect(out.toolClassifications).toEqual({ enrich_company: [], delete_record: ['dataChanges'] });
    expect(out.toolEffectClasses).toEqual({ enrich_company: 'read', delete_record: 'destructive' });
    expect(out.toolClassificationVersions).toEqual({ enrich_company: CLASSIFICATION_VERSION, delete_record: CLASSIFICATION_VERSION });
  });

  it('a matching hash at the current version skips the classification and carries the cached class', async () => {
    const lookup = jest.fn(async (tool: { name: string }) => (tool.name === 'enrich_company' ? cached() : null));
    const out = await runDiscoveryPipeline({ ...INPUT, classificationLookup: lookup }, () => undefined);
    expect(toolClassifier.classifyTool).toHaveBeenCalledTimes(1);
    expect((toolClassifier.classifyTool as jest.Mock).mock.calls[0][0].name).toBe('delete_record');
    expect(out.toolEffectClasses).toEqual({ enrich_company: 'read', delete_record: 'destructive' });
    expect(toolClassifier.cacheClassification).not.toHaveBeenCalled();
  });

  it('a hash mismatch classifies', async () => {
    const lookup = jest.fn(async () => cached({ toolDescriptionHash: 'stale' }));
    await runDiscoveryPipeline({ ...INPUT, classificationLookup: lookup }, () => undefined);
    expect(toolClassifier.classifyTool).toHaveBeenCalledTimes(2);
  });

  it('a row older than the classification version classifies; a manual override is always reused', async () => {
    expect(cachedClassificationIsCurrent(cached({ classificationVersion: null }), 'Enrich a company record')).toBe(false);
    expect(cachedClassificationIsCurrent(cached({ classificationVersion: CLASSIFICATION_VERSION - 1 }), 'Enrich a company record')).toBe(false);
    expect(cachedClassificationIsCurrent(cached({ isManualOverride: true, toolDescriptionHash: '' , classificationVersion: null }), 'Enrich a company record')).toBe(true);
  });

  it('a throwing lookup classifies', async () => {
    const lookup = jest.fn(async () => { throw new Error('db down'); });
    await runDiscoveryPipeline({ ...INPUT, classificationLookup: lookup }, () => undefined);
    expect(toolClassifier.classifyTool).toHaveBeenCalledTimes(2);
  });

  it('with the classifier kill off a reused row carries no effect class', async () => {
    process.env.TYPESAFE_CLASSIFIER_ENABLED = '0';
    const lookup = jest.fn(async (tool: { name: string }) => (tool.name === 'enrich_company' ? cached() : null));
    const out = await runDiscoveryPipeline({ ...INPUT, classificationLookup: lookup }, () => undefined);
    expect(out.toolEffectClasses?.enrich_company).toBeUndefined();
  });

  it('carries tenant and purpose to the classifier', async () => {
    await runDiscoveryPipeline(INPUT, () => undefined);
    expect(toolClassifier.classifyTool).toHaveBeenCalledWith(expect.anything(), { purpose: 'tool_classification', tenantId: 't1' });
  });
});
