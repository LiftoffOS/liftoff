// PATCH /api/tenants/:id { workspaceAiVendor } + GET /:id/workspace-ai —
// wire-level behavior of the Workspace AI selection endpoints: enum rejection
// (400 before any auth/service work), owner/admin gating, service dispatch,
// and audit logging.

import { jest } from '@jest/globals';

const mockGetById = jest.fn();
jest.mock('../service', () => ({
  TenantService: jest.fn().mockImplementation(() => ({
    getById: (...args: unknown[]) => mockGetById(...args),
    listAll: jest.fn(),
    provision: jest.fn(),
    updateName: jest.fn(),
    updateOnboardingProgress: jest.fn(),
  })),
}));

const mockLogAudit = jest.fn();
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

// The `models` registry, as the Workspace AI vendor loader reads it for names.
const mockModelsQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  pool: { query: jest.fn() },
  withTenantScope: jest.fn(),
  getPool: () => ({ query: (...args: unknown[]) => mockModelsQuery(...args) }),
}));

jest.mock('../../infrastructure/tenant-role-auth', () => ({
  requireMinRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const mockGetByFirebaseUid = jest.fn();
jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: (...args: unknown[]) => mockGetByFirebaseUid(...args),
  })),
}));

const mockGetMembership = jest.fn();
jest.mock('../../tenant-members/service', () => ({
  tenantMembersService: {
    getMembership: (...args: unknown[]) => mockGetMembership(...args),
  },
}));

const mockSetWorkspaceVendor = jest.fn();
const mockGetWorkspaceVendor = jest.fn();
jest.mock('../../model-registry/service', () => ({
  ModelRegistryService: jest.fn().mockImplementation(() => ({
    setWorkspaceVendor: (...args: unknown[]) => mockSetWorkspaceVendor(...args),
    getWorkspaceVendor: (...args: unknown[]) => mockGetWorkspaceVendor(...args),
  })),
}));

import express from 'express';
import request from 'supertest';
import { tenantsRouter } from '../router';
import { refreshWorkspaceAiModelNames } from '../../model-registry/workspace-ai-vendor-loader';
import {
  applyRegistryVendorModels,
  WORKSPACE_AI_VENDORS,
  type WorkspaceAiTier,
  type WorkspaceAiVendor,
} from '../../model-registry/workspace-ai-vendors';

const TENANT = '33333333-3333-3333-3333-333333333333';

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: { uid: string } }).user = { uid: 'firebase-uid-1' };
    (req as unknown as { ctx: Record<string, unknown> }).ctx = {};
    next();
  });
  app.use('/api/tenants', tenantsRouter);
  return app;
}

beforeEach(() => {
  mockGetById.mockReset().mockResolvedValue({ id: TENANT, name: 'Acme' });
  mockGetByFirebaseUid.mockReset().mockResolvedValue({ id: 'account-1' });
  mockGetMembership.mockReset().mockResolvedValue({ role: 'owner' });
  mockSetWorkspaceVendor.mockReset().mockResolvedValue({ id: 'cfg-1', version: 2 });
  mockGetWorkspaceVendor.mockReset().mockResolvedValue('default');
  mockLogAudit.mockReset();
});

describe('PATCH /api/tenants/:id workspaceAiVendor', () => {
  it('rejects an unknown vendor value with 400 before any service work', async () => {
    const res = await request(makeApp())
      .patch(`/api/tenants/${TENANT}`)
      .send({ workspaceAiVendor: 'mistral' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_body');
    expect(mockSetWorkspaceVendor).not.toHaveBeenCalled();
  });

  it('applies a valid vendor for an owner and audits prior -> new', async () => {
    mockGetWorkspaceVendor.mockResolvedValue('default');
    const res = await request(makeApp())
      .patch(`/api/tenants/${TENANT}`)
      .send({ workspaceAiVendor: 'qwen' });
    expect(res.status).toBe(200);
    expect(mockSetWorkspaceVendor).toHaveBeenCalledWith(TENANT, 'qwen');
    expect(mockLogAudit).toHaveBeenCalledWith(
      'tenant.workspace_ai_changed',
      expect.anything(),
      expect.objectContaining({
        resourceId: TENANT,
        previousState: { workspaceAiVendor: 'default' },
        newState: { workspaceAiVendor: 'qwen' },
      }),
    );
  });

  it('rejects a plain member with 403 and does not apply', async () => {
    mockGetMembership.mockResolvedValue({ role: 'member' });
    const res = await request(makeApp())
      .patch(`/api/tenants/${TENANT}`)
      .send({ workspaceAiVendor: 'glm' });
    expect(res.status).toBe(403);
    expect(mockSetWorkspaceVendor).not.toHaveBeenCalled();
  });
});

describe('GET /api/tenants/:id/workspace-ai', () => {
  // models.name per model_id. Keyed by id, so the fixture follows whatever the
  // live vendor map points at rather than restating it.
  let registryNames: Record<string, string | null>;

  const VENDORS = Object.keys(WORKSPACE_AI_VENDORS) as WorkspaceAiVendor[];
  const SEED = Object.fromEntries(VENDORS.map((v) => [v, { ...WORKSPACE_AI_VENDORS[v].tiers }]));

  beforeEach(async () => {
    registryNames = {
      'claude-fable-5-2': 'Claude Fable 5.2',
      'claude-opus-5-5': 'Claude Opus 5.5',
      'claude-sonnet-5-5': 'Claude Sonnet 5.5',
      'claude-haiku-5-5': 'Claude Haiku 5.5',
      'deepseek/deepseek-v4-pro': 'DeepSeek V4 Pro',
      'deepseek/deepseek-v4.1-flash': 'DeepSeek V4.1 Flash',
      'moonshotai/kimi-k3': 'Kimi K3',
      'moonshotai/kimi-k2.6': null,
      'grok-4.6': 'Grok 4.6',
      'grok-4.3': 'Grok 4.3',
      'grok-4.20-0309-non-reasoning': 'Grok 4.20',
      'gpt-6-astra': 'GPT-6 Astra',
      'gpt-6.1-sol': 'GPT-6.1 Sol',
      'gpt-6-luna': 'GPT-6 Luna',
      'z-ai/glm-5.3': 'GLM 5.3',
      'qwen/qwen3.8-max-0902': 'Qwen3.8 Max',
      'minimax/minimax-m3': 'MiniMax M3',
      'xiaomi/mimo-v2.6-pro': 'MiMo V2.6 Pro',
    };
    mockModelsQuery.mockReset().mockImplementation(async (...args: unknown[]) => {
      const ids = (args[1] as [string[]])[0];
      return {
        rows: ids
          .filter((id) => id in registryNames)
          .map((id) => ({ model_id: id, name: registryNames[id] })),
      };
    });
    await refreshWorkspaceAiModelNames();
  });

  afterEach(() => {
    for (const v of VENDORS) Object.assign(WORKSPACE_AI_VENDORS[v].tiers, SEED[v]);
  });

  it('returns the current vendor for an admin', async () => {
    mockGetMembership.mockResolvedValue({ role: 'admin' });
    mockGetWorkspaceVendor.mockResolvedValue('kimi');
    const res = await request(makeApp()).get(`/api/tenants/${TENANT}/workspace-ai`);
    expect(res.status).toBe(200);
    expect(res.body.vendor).toBe('kimi');
    expect(res.body).toHaveProperty('vendorModels');
  });

  it('keeps vendor as the stored selection, default included', async () => {
    mockGetWorkspaceVendor.mockResolvedValue('default');
    const res = await request(makeApp()).get(`/api/tenants/${TENANT}/workspace-ai`);
    expect(res.body.vendor).toBe('default');
  });

  it('lists every named vendor, and no key for Liftoff Managed', async () => {
    const res = await request(makeApp()).get(`/api/tenants/${TENANT}/workspace-ai`);
    expect(Object.keys(res.body.vendorModels).sort()).toEqual([
      'anthropic', 'deepseek', 'glm', 'google', 'grok', 'kimi', 'minimax', 'openai', 'qwen',
      'xiaomi',
    ]);
    expect(res.body.vendorModels).not.toHaveProperty('default');
  });

  it('orders names Frontier, large, medium, small', async () => {
    const res = await request(makeApp()).get(`/api/tenants/${TENANT}/workspace-ai`);
    expect(res.body.vendorModels.anthropic)
      .toEqual(['Claude Fable 5.2', 'Claude Opus 5.5', 'Claude Sonnet 5.5', 'Claude Haiku 5.5']);
    expect(res.body.vendorModels.grok).toEqual(['Grok 4.6', 'Grok 4.3', 'Grok 4.20']);
  });

  it('lists a Frontier model that is also the large-tier model once', async () => {
    const res = await request(makeApp()).get(`/api/tenants/${TENANT}/workspace-ai`);
    expect(res.body.vendorModels.openai).toEqual(['GPT-6 Astra', 'GPT-6.1 Sol', 'GPT-6 Luna']);
  });

  it('lists a model once when small repeats medium', async () => {
    const res = await request(makeApp()).get(`/api/tenants/${TENANT}/workspace-ai`);
    expect(res.body.vendorModels.deepseek).toEqual(['DeepSeek V4 Pro', 'DeepSeek V4.1 Flash']);
  });

  it('omits a model with no name, and gives an unnamed vendor an empty list', async () => {
    const res = await request(makeApp()).get(`/api/tenants/${TENANT}/workspace-ai`);
    // kimi-k2.6 has a row with no name; nothing of Google's is registered.
    expect(res.body.vendorModels.kimi).toEqual(['Kimi K3']);
    expect(res.body.vendorModels.google).toEqual([]);
  });

  it('shows names only, never a model id or provider slug', async () => {
    const res = await request(makeApp()).get(`/api/tenants/${TENANT}/workspace-ai`);
    const all = Object.values(res.body.vendorModels as Record<string, string[]>).flat();
    for (const spec of Object.values(WORKSPACE_AI_VENDORS)) {
      for (const id of [...Object.values(spec.tiers), spec.frontier]) {
        if (id) expect(JSON.stringify(res.body)).not.toContain(`"${id}"`);
      }
    }
    expect(all.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toMatch(/openrouter/);
  });

  it('follows the registry overlay, not the seed literals', async () => {
    registryNames['claude-opus-6'] = 'Claude Opus 6';
    applyRegistryVendorModels(
      new Map<string, Partial<Record<WorkspaceAiTier, string>>>([
        ['anthropic', { large: 'claude-opus-6' }],
      ]),
    );
    await refreshWorkspaceAiModelNames();
    const res = await request(makeApp()).get(`/api/tenants/${TENANT}/workspace-ai`);
    expect(res.body.vendorModels.anthropic)
      .toEqual(['Claude Fable 5.2', 'Claude Opus 6', 'Claude Sonnet 5.5', 'Claude Haiku 5.5']);
  });

  it('keeps the Frontier model through a registry overlay of the large tier', async () => {
    applyRegistryVendorModels(
      new Map<string, Partial<Record<WorkspaceAiTier, string>>>([
        ['anthropic', { large: 'claude-opus-6' }],
        ['openai', { large: 'gpt-7-astra' }],
      ]),
    );
    expect(WORKSPACE_AI_VENDORS.anthropic.frontier).toBe('claude-fable-5-2');
    expect(WORKSPACE_AI_VENDORS.openai.frontier).toBe('gpt-6-astra');
  });

  it('names each vendor\'s coding tool, and the model only for OpenCode', async () => {
    const res = await request(makeApp()).get(`/api/tenants/${TENANT}/workspace-ai`);
    expect(res.body.vendorCoding).toEqual({
      anthropic: { tool: 'Claude Code' },
      openai: { tool: 'Codex' },
      google: { tool: 'Gemini CLI' },
      grok: { tool: 'OpenCode', model: 'Grok 4.6' },
      deepseek: { tool: 'OpenCode', model: 'DeepSeek V4 Pro' },
      glm: { tool: 'OpenCode', model: 'GLM 5.3' },
      kimi: { tool: 'OpenCode', model: 'Kimi K3' },
      minimax: { tool: 'OpenCode', model: 'MiniMax M3' },
      qwen: { tool: 'OpenCode', model: 'Qwen3.8 Max' },
      xiaomi: { tool: 'OpenCode', model: 'MiMo V2.6 Pro' },
    });
    expect(res.body.vendorCoding).not.toHaveProperty('default');
  });

  it('codes with the live large-tier model, and omits a model it cannot name', async () => {
    registryNames['z-ai/glm-6'] = 'GLM 6';
    delete registryNames['qwen/qwen3.8-max-0902'];
    applyRegistryVendorModels(
      new Map<string, Partial<Record<WorkspaceAiTier, string>>>([
        ['glm', { large: 'z-ai/glm-6' }],
      ]),
    );
    await refreshWorkspaceAiModelNames();
    const res = await request(makeApp()).get(`/api/tenants/${TENANT}/workspace-ai`);
    expect(res.body.vendorCoding.glm).toEqual({ tool: 'OpenCode', model: 'GLM 6' });
    expect(res.body.vendorCoding.qwen).toEqual({ tool: 'OpenCode' });
  });

  it('serves the cached names without a registry read per request', async () => {
    mockModelsQuery.mockClear();
    await request(makeApp()).get(`/api/tenants/${TENANT}/workspace-ai`);
    expect(mockModelsQuery).not.toHaveBeenCalled();
  });

  it('403s a plain member', async () => {
    mockGetMembership.mockResolvedValue({ role: 'member' });
    const res = await request(makeApp()).get(`/api/tenants/${TENANT}/workspace-ai`);
    expect(res.status).toBe(403);
  });
});
