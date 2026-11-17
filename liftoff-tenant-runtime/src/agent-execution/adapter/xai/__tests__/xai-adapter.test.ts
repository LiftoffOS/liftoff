// The xAI adapter, and the funding rule that selects it.
//
// Grok goes to api.x.ai whoever pays: managed on Liftoff's xAI account,
// customer-funded through the BYOK gateway. Only the credential differs.
//
// Two things here fail SILENTLY, which is why they are pinned rather than read:
//
//   - select the wrong adapter for a re-routed credential and the run still
//     succeeds, on Liftoff's account, while the control plane records the turn
//     as customer-funded. Liftoff pays for a call it believes it did not.
//   - send OpenRouter's model slug to api.x.ai and the request 404s, and the
//     same slug looked up in the rate table matches nothing and records the run
//     at zero cost.
//
// The control plane's half of this is covered by resolution-service.test.ts
// ("is funded by an xAI key and asks to leave OpenRouter to do it").

import { createXaiAdapter, xaiNativeModelId, xaiTarget } from '../index';
import { isNonReasoningGrokModel, TIER_MODELS } from '../../../../llm/providers/xai';
import { pairsForEngine } from '../../vendors';
import { adapterForFunding } from '../../funding';
import type { InvocationInput } from '../../types';
import type { VendorSdkAdapter } from '../../types';

const BASE = { kind: 'openai' } as unknown as VendorSdkAdapter;

function inputWith(byok?: InvocationInput['byok'], model = 'x-ai/grok-4.6'): InvocationInput {
  return { model, byok } as unknown as InvocationInput;
}

describe('which adapter executes, given who is paying', () => {
  it('keeps the resolved adapter for an ordinary managed run', () => {
    // No credential at all: every run that is not customer-funded.
    expect(adapterForFunding(BASE, null)).toBe(BASE);
    expect(adapterForFunding(BASE, undefined)).toBe(BASE);
  });

  it('keeps it for a customer key that does NOT need a different endpoint', () => {
    // An OpenAI or Anthropic key is a pure credential swap — same endpoint,
    // same model ids. Only the account paying changes, and the adapter that was
    // resolved from the provider is still the right one.
    const credential = { vendor: 'openai', rerouteToVendorApi: false };
    expect(adapterForFunding(BASE, credential)).toBe(BASE);
  });

  it('switches to the xAI adapter when the credential says to leave OpenRouter', () => {
    const credential = { vendor: 'xai', rerouteToVendorApi: true };
    // Identified by the endpoint it names rather than by its class: there is
    // no xAI subclass any more, only the shared loop pointed at the xAI target.
    // The run resolved to a gateway family — the pre-move configuration this
    // re-route exists for.
    expect(adapterForFunding(BASE, credential, 'glm').kind).toBe('xai');
  });

  it('keeps the resolved adapter when the run already resolved to xAI, whatever its engine', () => {
    // Grok is its own provider, so a current configuration resolves to `xai`
    // whoever pays, and the adapter built for it already dials api.x.ai and
    // reads the credential itself. Swapped for the wire adapter here, a
    // customer-funded Grok run on opencode would silently run on the wire
    // instead — while the invocation records opencode — and the customer's
    // key could never fund Grok on the engine the provider actually runs.
    const opencode = { kind: 'opencode' } as unknown as VendorSdkAdapter;
    const credential = { vendor: 'xai', rerouteToVendorApi: true };
    expect(adapterForFunding(opencode, credential, 'xai')).toBe(opencode);
  });

  it('refuses a re-route it has no adapter for, rather than quietly staying put', () => {
    // Staying on the base adapter would send the call to the resolved provider
    // on Liftoff's account while the control plane believes the customer is
    // funding it — a usage row reading byok_customer_funded for a call we paid
    // for. Loud is the only safe answer.
    expect(() => adapterForFunding(BASE, { vendor: 'mistral', rerouteToVendorApi: true }))
      .toThrow(/no adapter serves a re-routed mistral/);
  });
});

describe('the xAI adapter', () => {
  it('identifies as its own engine, not as the one it borrows from', () => {
    // It shares the OpenAI-wire implementation. It is not the OpenAI adapter,
    // and provenance that said otherwise would hide which endpoint served a run.
    expect(createXaiAdapter().kind).toBe('xai');
  });

  it('is the wire engine Grok resolves to behind its escape hatch, whoever funds the run', () => {
    // Grok used to resolve to `openrouter` whoever paid, which is why funding it
    // from a customer key meant swapping adapters mid-run. It is its own
    // provider now, so provenance and routing finally agree.
    //
    // The provider itself is no longer declared on the target: what a run
    // records is what the routing chain resolved, which the input already
    // carries. A constant could not answer for the gateway target, where one
    // engine serves four families — it recorded all four as the gateway.
    expect(pairsForEngine('xai-openai-wire').map((p) => p.provider)).toEqual(['xai']);
  });

  it('serves a MANAGED run from Liftoff\'s own account, and says so when it cannot', () => {
    // The adapter is no longer BYOK-only: a workspace can pick Grok without
    // supplying a key, and Liftoff pays. With no key configured it REFUSES,
    // rather than returning undefined — undefined means "use the SDK's
    // default", and the SDK's default is an OpenAI client, so the run would
    // report a missing OPENAI_API_KEY for a call that has nothing to do with
    // OpenAI. The error names the vendor whose key is actually absent.
    return expect(xaiTarget.sdkProvider(inputWith(undefined)))
      .rejects.toThrow(/no XAI_API_KEY/);
  });
});

describe('the model id xAI expects', () => {
  it('drops the OpenRouter publisher prefix', () => {
    expect(xaiNativeModelId('x-ai/grok-4.6')).toBe('grok-4.6');
    expect(xaiNativeModelId('x-ai/grok-code-fast-1')).toBe('grok-code-fast-1');
  });

  it('leaves an already-native id alone, and is idempotent', () => {
    expect(xaiNativeModelId('grok-4.6')).toBe('grok-4.6');
    expect(xaiNativeModelId(xaiNativeModelId('x-ai/grok-4.6'))).toBe('grok-4.6');
  });

  it('only strips at the START of the id', () => {
    // An id that merely CONTAINS the segment is not in OpenRouter's namespace.
    expect(xaiNativeModelId('vendor/x-ai/grok-4.6')).toBe('vendor/x-ai/grok-4.6');
  });

  it('is what the target actually applies', () => {
    const credential = { vendor: 'xai', baseUrl: 'https://gw', token: 't' };
    return expect(
      xaiTarget.modelId(inputWith(credential as InvocationInput['byok']), undefined),
    ).resolves.toBe('grok-4.6');
  });

  it('is bound to the provider that has to serve it, not passed as a bare id', async () => {
    // A bare id is resolved by the SDK's DEFAULT OpenAI client, which for a
    // customer-funded Grok turn is the wrong endpoint AND the wrong account.
    // The general rule is pinned for every target in
    // openai/__tests__/wire-target-binding.test.ts; what this pins is that the
    // id xAI gets bound to is the NATIVE one.
    const bound: string[] = [];
    const provider = {
      getModel: async (name?: string) => { bound.push(name ?? ''); return {} as never; },
    } as unknown as Parameters<typeof xaiTarget.modelId>[1];
    const model = await xaiTarget.modelId(inputWith(undefined), provider);
    expect(bound).toEqual(['grok-4.6']);
    expect(typeof model).not.toBe('string');
  });
});

describe('which Grok tiers reason', () => {
  it('names the small tier as the non-reasoning variant', () => {
    // The small tier buys speed and is deliberately the `-non-reasoning` id.
    // A consumer that flags every Grok model as reasoning-capable offers
    // effort variants on a model that has none to vary.
    expect(isNonReasoningGrokModel(TIER_MODELS.small)).toBe(true);
    expect(isNonReasoningGrokModel(TIER_MODELS.medium)).toBe(false);
    expect(isNonReasoningGrokModel(TIER_MODELS.large)).toBe(false);
  });

  it('reads the variant in either namespace, and only for Grok', () => {
    expect(isNonReasoningGrokModel('x-ai/grok-4.20-0309-non-reasoning')).toBe(true);
    expect(isNonReasoningGrokModel('grok-4.20-0309-reasoning')).toBe(false);
    expect(isNonReasoningGrokModel('z-ai/glm-5.2-non-reasoning')).toBe(false);
    expect(isNonReasoningGrokModel(null)).toBe(false);
  });
});
