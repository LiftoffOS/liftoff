// workspace-ai-vendor-loader — the Workspace AI vendor map is driven by the
// `models` registry (newest approved model per provider+tier), overlaid onto the
// static seed.
//
// The load-bearing property is that a vendor's rows are read under the key it
// EXECUTES under. There used to be two keys and a translation between them —
// GLM's rows under 'openrouter', Grok's under 'grok' — and the failure mode of
// a wrong translation is silence: the lookup misses, the static seed keeps
// answering, and the registry row that was meant to override it never does.
// Migration 450 removed the second vocabulary; these tests hold the first one
// to being the only one.
const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({ getPool: () => ({ query: mockQuery }) }));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { refreshWorkspaceAiVendorModels } from '../workspace-ai-vendor-loader';
import {
  applyRegistryVendorModels,
  OPENROUTER_HOSTED_PROVIDERS,
  WORKSPACE_AI_VENDORS,
  type WorkspaceAiTier,
  type WorkspaceAiVendor,
} from '../workspace-ai-vendors';
import { providerOfModelId } from '../model-family';

const VENDORS = Object.keys(WORKSPACE_AI_VENDORS) as WorkspaceAiVendor[];

/** The seed, captured before any test mutates the shared map. */
const SEED: Record<string, Record<string, string>> = Object.fromEntries(
  VENDORS.map((v) => [v, { ...WORKSPACE_AI_VENDORS[v].tiers }]),
);

function restoreSeed(): void {
  for (const vendor of VENDORS) {
    Object.assign(WORKSPACE_AI_VENDORS[vendor].tiers, SEED[vendor]);
  }
}

beforeEach(() => jest.clearAllMocks());
afterEach(restoreSeed);

describe('the registry key and the execution key are one value', () => {
  it('gives every vendor its own name, and Grok the company that serves it', () => {
    const byVendor = Object.fromEntries(
      VENDORS.map((v) => [v, WORKSPACE_AI_VENDORS[v].provider]),
    );
    expect(byVendor).toEqual({
      anthropic: 'anthropic',
      openai: 'openai',
      google: 'google',
      glm: 'glm',
      qwen: 'qwen',
      deepseek: 'deepseek',
      kimi: 'kimi',
      minimax: 'minimax',
      xiaomi: 'xiaomi',
      // The one vendor whose provider is not its own key. 'xai' is the company
      // and 'grok' the model line; the runtime, the rate table and the
      // invocations constraint have all said 'xai' since migration 417, and
      // renaming them to match the dropdown would move live data to settle a
      // spelling.
      grok: 'xai',
    });
  });

  // A vendor served over the gateway is a vendor whose rates come from the
  // gateway's catalog. The two used to be separate lists edited months apart,
  // and the copy said 'openrouter' where it meant GLM.
  it('derives the gateway-served list from the transport each vendor declares', () => {
    for (const vendor of VENDORS) {
      const spec = WORKSPACE_AI_VENDORS[vendor];
      expect({ vendor, hosted: OPENROUTER_HOSTED_PROVIDERS.includes(spec.provider) })
        .toEqual({ vendor, hosted: spec.transport === 'openrouter' });
    }
  });

  // The publisher segment is what migration 450 reads to decide which family a
  // stored 'openrouter' row meant, and what the branding cross-product relies
  // on. A gateway vendor seeded with someone else's namespace would send those
  // rows to the wrong family, silently and in bulk.
  it('seeds every gateway vendor under its own publisher namespace', () => {
    for (const vendor of VENDORS) {
      const spec = WORKSPACE_AI_VENDORS[vendor];
      if (spec.transport !== 'openrouter') continue;
      for (const modelId of Object.values(spec.tiers)) {
        expect({ vendor, modelId, family: providerOfModelId(modelId) })
          .toEqual({ vendor, modelId, family: spec.provider });
      }
    }
  });
});

describe('applyRegistryVendorModels', () => {
  it('replaces only the (vendor, tier) pairs the registry carries', () => {
    const applied = applyRegistryVendorModels(
      new Map<string, Partial<Record<WorkspaceAiTier, string>>>([
        ['qwen', { large: 'qwen/qwen9-max', medium: 'qwen/qwen9-plus' }],
      ]),
    );
    expect(applied).toBe(2);
    expect(WORKSPACE_AI_VENDORS.qwen.tiers.large).toBe('qwen/qwen9-max');
    expect(WORKSPACE_AI_VENDORS.qwen.tiers.medium).toBe('qwen/qwen9-plus');
    // Absent from the overlay → keeps its seed.
    expect(WORKSPACE_AI_VENDORS.qwen.tiers.small).toBe(SEED.qwen.small);
    // A vendor the overlay never mentions is untouched.
    expect(WORKSPACE_AI_VENDORS.glm.tiers.large).toBe(SEED.glm.large);
  });

  it('gives each gateway vendor the rows under its own name', () => {
    applyRegistryVendorModels(
      new Map<string, Partial<Record<WorkspaceAiTier, string>>>([
        ['glm', { large: 'z-ai/glm-6' }],
        ['qwen', { large: 'qwen/qwen9-max' }],
      ]),
    );
    expect(WORKSPACE_AI_VENDORS.glm.tiers.large).toBe('z-ai/glm-6');
    expect(WORKSPACE_AI_VENDORS.qwen.tiers.large).toBe('qwen/qwen9-max');
  });

  // The gateway's name is not a vendor key any more. A row still filed under it
  // belongs to nobody, and must not quietly land on GLM — that is the
  // translation migration 450 removed.
  it("ignores rows still filed under 'openrouter'", () => {
    expect(applyRegistryVendorModels(
      new Map<string, Partial<Record<WorkspaceAiTier, string>>>([
        ['openrouter', { large: 'z-ai/glm-6' }],
      ]),
    )).toBe(0);
    expect(WORKSPACE_AI_VENDORS.glm.tiers.large).toBe(SEED.glm.large);
  });

  it('leaves the whole map on its seed for an empty registry', () => {
    expect(applyRegistryVendorModels(new Map())).toBe(0);
    for (const vendor of VENDORS) {
      expect(WORKSPACE_AI_VENDORS[vendor].tiers).toEqual(SEED[vendor]);
    }
  });
});

describe('refreshWorkspaceAiVendorModels', () => {
  it('groups the registry rows by provider before applying them', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { provider: 'anthropic', tier: 'medium', model_id: 'claude-sonnet-9' },
        { provider: 'google', tier: 'large', model_id: 'gemini-9-pro' },
        { provider: 'glm', tier: 'small', model_id: 'z-ai/glm-9-flash' },
      ],
    });

    const applied = await refreshWorkspaceAiVendorModels();

    expect(applied).toBe(3);
    expect(WORKSPACE_AI_VENDORS.anthropic.tiers.medium).toBe('claude-sonnet-9');
    expect(WORKSPACE_AI_VENDORS.google.tiers.large).toBe('gemini-9-pro');
    expect(WORKSPACE_AI_VENDORS.glm.tiers.small).toBe('z-ai/glm-9-flash');
  });

  it('asks for the newest approved row per provider AND tier', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await refreshWorkspaceAiVendorModels();
    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toContain('DISTINCT ON (provider, tier)');
    expect(sql).toContain("status = 'approved'");
    expect(sql).toContain('tier IS NOT NULL');
    expect(sql).toContain('ORDER BY provider, tier, created_at DESC');
  });
});

describe('Workspace AI model names', () => {
  /** A fresh copy of the loader, so "nothing loaded yet" is real. */
  function freshLoader(): typeof import('../workspace-ai-vendor-loader') {
    let mod!: typeof import('../workspace-ai-vendor-loader');
    jest.isolateModules(() => {
      mod = jest.requireActual('../workspace-ai-vendor-loader');
    });
    return mod;
  }

  it('names the models the overlay just installed, read after it', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ provider: 'anthropic', tier: 'large', model_id: 'claude-opus-9' }] })
      .mockResolvedValueOnce({ rows: [{ model_id: 'claude-opus-9', name: 'Claude Opus 9' }] });
    const loader = freshLoader();

    await loader.refreshWorkspaceAiVendorModels();

    const [, params] = mockQuery.mock.calls[1] as [string, [string[]]];
    expect(params[0]).toContain('claude-opus-9');
    expect(params[0]).not.toContain(SEED.anthropic.large);
    expect((await loader.getWorkspaceAiVendorModels()).anthropic).toEqual(['Claude Opus 9']);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('keeps the overlay when the names read fails', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ provider: 'glm', tier: 'medium', model_id: 'z-ai/glm-9' }] })
      .mockRejectedValueOnce(new Error('db down'));

    await expect(refreshWorkspaceAiVendorModels()).resolves.toBe(1);
    expect(WORKSPACE_AI_VENDORS.glm.tiers.medium).toBe('z-ai/glm-9');
  });

  it('loads names once on first use when the refresh has not run', async () => {
    mockQuery.mockResolvedValue({ rows: [{ model_id: SEED.openai.large, name: 'GPT-6 Astra' }] });
    const loader = freshLoader();

    const [a, b] = await Promise.all([
      loader.getWorkspaceAiVendorModels(),
      loader.getWorkspaceAiVendorModels(),
    ]);
    await loader.getWorkspaceAiVendorModels();

    expect(a.openai).toEqual(['GPT-6 Astra']);
    expect(b).toEqual(a);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('reads the Frontier models\' names alongside the tiers\'', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const loader = freshLoader();

    await loader.refreshWorkspaceAiModelNames();

    const [, params] = mockQuery.mock.calls[0] as [string, [string[]]];
    expect(params[0]).toContain('claude-fable-5-2');
    // Astra is OpenAI's Frontier model AND its large-tier model: asked for once.
    expect(params[0].filter((id) => id === 'gpt-6-astra')).toHaveLength(1);
  });

  it('never overlays or drops a Frontier model', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { provider: 'anthropic', tier: 'large', model_id: 'claude-opus-9' },
          { provider: 'openai', tier: 'large', model_id: 'gpt-9-astra' },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await refreshWorkspaceAiVendorModels();

    expect(WORKSPACE_AI_VENDORS.anthropic.frontier).toBe('claude-fable-5-2');
    expect(WORKSPACE_AI_VENDORS.openai.frontier).toBe('gpt-6-astra');
  });

  it('shares one first-use load between the model names and the coding tools', async () => {
    mockQuery.mockResolvedValue({ rows: [{ model_id: SEED.glm.large, name: 'GLM 5.2' }] });
    const loader = freshLoader();

    const [models, coding] = await Promise.all([
      loader.getWorkspaceAiVendorModels(),
      loader.getWorkspaceAiVendorCoding(),
    ]);

    expect(models.glm).toEqual(['GLM 5.2']);
    expect(coding.glm).toEqual({ tool: 'OpenCode', model: 'GLM 5.2' });
    expect(coding.anthropic).toEqual({ tool: 'Claude Code' });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('serves empty lists rather than failing when names cannot be read', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    const loader = freshLoader();

    const models = await loader.getWorkspaceAiVendorModels();
    expect(Object.values(models).every((names) => names.length === 0)).toBe(true);
    expect(models).not.toHaveProperty('default');
  });
});
