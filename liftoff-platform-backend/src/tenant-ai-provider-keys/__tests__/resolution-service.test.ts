// The two tests, and the cases where getting them wrong costs real money or
// switches off a safety control.

import type { StoredProviderKey } from '../repository';

const listKeys = jest.fn<Promise<StoredProviderKey[]>, [string]>();
jest.mock('../repository', () => ({ listKeys: (t: string) => listKeys(t) }));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  AGENT_INVOCATION_PURPOSE,
  invalidateResolutionCache,
  isByokEligiblePurpose,
  keyVendorForProvider,
  resolveByokCredential,
} from '../resolution-service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';

function key(
  vendor: StoredProviderKey['vendor'],
  status: StoredProviderKey['status'] = 'valid',
): StoredProviderKey {
  return {
    vendor,
    secretName: `ai-provider-key-${TENANT}-${vendor}`,
    hint: 'sk-xxx••••••••1234',
    status,
    updatedAt: '2026-09-01T00:00:00.000Z',
    lastVerifiedAt: '2026-09-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  listKeys.mockReset();
  listKeys.mockResolvedValue([key('anthropic')]);
  invalidateResolutionCache();
});

describe('test 1 — would this call appear on the customer Liftoff invoice today', () => {
  it('refuses a purpose the platform absorbs, even with a key on file', async () => {
    // distill is platform_overhead: Liftoff absorbs the cost of BUILDING an
    // agent and charges for running it. That bargain does not change because
    // the customer supplied a key.
    const result = await resolveByokCredential({
      tenantId: TENANT,
      resolvedProvider: 'anthropic',
      purpose: 'distill',
      agentId: AGENT,
      source: 'platform_llm',
    });
    expect(result).toEqual({ mode: 'managed', reason: 'not_customer_chargeable' });
  });

  it('refuses the injection guard, which runs on every turn and is not the customer workload', async () => {
    const result = await resolveByokCredential({
      tenantId: TENANT,
      resolvedProvider: 'anthropic',
      purpose: 'injection_guard',
      agentId: AGENT,
      source: 'platform_llm',
    });
    expect(result).toEqual({ mode: 'managed', reason: 'not_customer_chargeable' });
  });
});

describe('test 2 — did the customer initiate it', () => {
  it('refuses dlp_deep_scan, which PASSES test 1 and must still never reach a customer key', async () => {
    // It comes from the runtime, so classifyChargeability calls it 'customer'
    // unconditionally. Test 2 is the only thing standing between it and the
    // customer's provider account — and a customer must not be able to switch
    // off a safety control by letting their key lapse.
    const result = await resolveByokCredential({
      tenantId: TENANT,
      resolvedProvider: 'anthropic',
      purpose: 'dlp_deep_scan',
      agentId: AGENT,
      source: 'tenant_runtime',
    });
    expect(result).toEqual({ mode: 'managed', reason: 'purpose_not_eligible' });
  });

  it('refuses a memory loop, which runs on Liftoff schedule and is invisible in the product', async () => {
    const result = await resolveByokCredential({
      tenantId: TENANT,
      resolvedProvider: 'anthropic',
      purpose: 'memory_consolidation',
      agentId: AGENT,
      source: 'tenant_runtime',
    });
    expect(result).toEqual({ mode: 'managed', reason: 'purpose_not_eligible' });
  });

  it('refuses an unrecognised purpose rather than riding the billing fallthrough', async () => {
    // classifyChargeability answers 'customer' here on purpose — a missed
    // charge is the failure it defends against. Unexplained spend on somebody
    // else's invoice is not, so this list is closed by default.
    const result = await resolveByokCredential({
      tenantId: TENANT,
      resolvedProvider: 'anthropic',
      purpose: 'some_future_background_job',
      agentId: AGENT,
      source: 'platform_llm',
    });
    expect(result).toEqual({ mode: 'managed', reason: 'purpose_not_eligible' });
  });

  it('accepts the agent invocation itself', async () => {
    const result = await resolveByokCredential({
      tenantId: TENANT,
      resolvedProvider: 'anthropic',
      purpose: AGENT_INVOCATION_PURPOSE,
      agentId: AGENT,
      source: 'tenant_runtime',
    });
    expect(result).toEqual({
      mode: 'byok',
      vendor: 'anthropic',
      secretName: `ai-provider-key-${TENANT}-anthropic`,
      rerouteToVendorApi: false,
    });
  });

  it('keeps category H off the eligible list', () => {
    expect(isByokEligiblePurpose('injection_guard')).toBe(false);
    expect(isByokEligiblePurpose('dlp_deep_scan')).toBe(false);
  });
});

describe('per-provider, not per-tenant-boolean', () => {
  it('funds Anthropic and leaves an OpenAI call on the managed pool', async () => {
    const anthropic = await resolveByokCredential({
      tenantId: TENANT,
      resolvedProvider: 'anthropic',
      purpose: AGENT_INVOCATION_PURPOSE,
      agentId: AGENT,
    });
    expect(anthropic.mode).toBe('byok');

    const openai = await resolveByokCredential({
      tenantId: TENANT,
      resolvedProvider: 'openai',
      purpose: AGENT_INVOCATION_PURPOSE,
      agentId: AGENT,
    });
    expect(openai).toEqual({ mode: 'managed', reason: 'no_key' });
  });

  it('leaves retrieval on the managed pool when only an Anthropic key exists', async () => {
    // Embeddings are pinned to Google whatever the workspace picked, so a
    // workspace holding only an Anthropic key has nothing to embed with. This
    // is the concrete reason the resolver is per-provider.
    const result = await resolveByokCredential({
      tenantId: TENANT,
      resolvedProvider: 'google',
      purpose: 'embedding_retrieval',
      agentId: AGENT,
    });
    expect(result).toEqual({ mode: 'managed', reason: 'no_key' });
  });

  it('funds retrieval when the Google key is the one on file', async () => {
    listKeys.mockResolvedValue([key('google')]);
    const result = await resolveByokCredential({
      tenantId: TENANT,
      resolvedProvider: 'google',
      purpose: 'embedding_retrieval',
      agentId: AGENT,
    });
    expect(result).toMatchObject({ mode: 'byok', vendor: 'google' });
  });
});

describe('providers no customer key can settle', () => {
  it('refuses anthropic-vertex, which bills Liftoff GCP account over ADC', async () => {
    expect(keyVendorForProvider('anthropic-vertex')).toBeNull();
    const result = await resolveByokCredential({
      tenantId: TENANT,
      resolvedProvider: 'anthropic-vertex',
      purpose: AGENT_INVOCATION_PURPOSE,
      agentId: AGENT,
    });
    expect(result).toEqual({ mode: 'managed', reason: 'provider_not_fundable' });
  });

  it('refuses a non-Grok OpenRouter model — glm, qwen, deepseek and kimi have no key to offer', async () => {
    const result = await resolveByokCredential({
      tenantId: TENANT,
      resolvedProvider: 'openrouter',
      resolvedModelId: 'z-ai/glm-5.2',
      purpose: AGENT_INVOCATION_PURPOSE,
      agentId: AGENT,
    });
    expect(result).toEqual({ mode: 'managed', reason: 'provider_not_fundable' });
  });
});

describe('Grok', () => {
  it('is funded by an xAI key and asks to leave OpenRouter to do it', async () => {
    listKeys.mockResolvedValue([key('xai')]);
    const result = await resolveByokCredential({
      tenantId: TENANT,
      resolvedProvider: 'openrouter',
      resolvedModelId: 'x-ai/grok-4.6',
      purpose: AGENT_INVOCATION_PURPOSE,
      agentId: AGENT,
    });
    expect(result).toEqual({
      mode: 'byok',
      vendor: 'xai',
      secretName: `ai-provider-key-${TENANT}-xai`,
      // A customer xAI key cannot pay an OpenRouter invoice.
      rerouteToVendorApi: true,
    });
  });

  it('keeps running through OpenRouter on Liftoff account when there is no xAI key', async () => {
    listKeys.mockResolvedValue([key('anthropic')]);
    const result = await resolveByokCredential({
      tenantId: TENANT,
      resolvedProvider: 'openrouter',
      resolvedModelId: 'x-ai/grok-4.6',
      purpose: AGENT_INVOCATION_PURPOSE,
      agentId: AGENT,
    });
    expect(result).toEqual({ mode: 'managed', reason: 'no_key' });
  });
});

describe('a declined key', () => {
  it('is not retried — the answer is distinct from having no key at all', async () => {
    // Retrying a dead key on every turn is a per-turn latency tax for no gain.
    listKeys.mockResolvedValue([key('anthropic', 'revoked')]);
    const result = await resolveByokCredential({
      tenantId: TENANT,
      resolvedProvider: 'anthropic',
      purpose: AGENT_INVOCATION_PURPOSE,
      agentId: AGENT,
    });
    expect(result).toEqual({ mode: 'managed', reason: 'key_revoked' });
  });
});

describe('cache', () => {
  it('reads the key set once per tenant', async () => {
    await resolveByokCredential({
      tenantId: TENANT, resolvedProvider: 'anthropic',
      purpose: AGENT_INVOCATION_PURPOSE, agentId: AGENT,
    });
    await resolveByokCredential({
      tenantId: TENANT, resolvedProvider: 'anthropic',
      purpose: AGENT_INVOCATION_PURPOSE, agentId: AGENT,
    });
    expect(listKeys).toHaveBeenCalledTimes(1);
  });

  it('re-reads after an invalidation, so a rotated key takes effect on the next call', async () => {
    await resolveByokCredential({
      tenantId: TENANT, resolvedProvider: 'anthropic',
      purpose: AGENT_INVOCATION_PURPOSE, agentId: AGENT,
    });
    invalidateResolutionCache(TENANT);
    await resolveByokCredential({
      tenantId: TENANT, resolvedProvider: 'anthropic',
      purpose: AGENT_INVOCATION_PURPOSE, agentId: AGENT,
    });
    expect(listKeys).toHaveBeenCalledTimes(2);
  });

  it('never asks the database for a call that failed either test', async () => {
    await resolveByokCredential({
      tenantId: TENANT,
      resolvedProvider: 'anthropic',
      purpose: 'injection_guard',
      agentId: AGENT,
      source: 'platform_llm',
    });
    expect(listKeys).not.toHaveBeenCalled();
  });
});
