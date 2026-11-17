// The third outcome, and the two purposes that stopped riding the fallthrough.

import { classifyChargeability } from '../event-classification';

const AGENT = '22222222-2222-4222-8222-222222222222';

describe('byok_customer_funded', () => {
  it('zero-rates a call the customer own key paid for', () => {
    // Leaving it 'customer' charges them twice for the same tokens, and the
    // double charge lands the moment the first key is saved.
    expect(classifyChargeability({
      source: 'tenant_runtime',
      purpose: null,
      agentId: AGENT,
      byokFunded: true,
    })).toBe('byok_customer_funded');
  });

  it('bills a fallback turn as ordinary consumption', () => {
    // A turn served by the managed key after the customer key was declined is
    // normal customer consumption: Liftoff key paid for it. The gateway reports
    // which key ACTUALLY served the request, not whether a key is on file.
    expect(classifyChargeability({
      source: 'tenant_runtime',
      purpose: null,
      agentId: AGENT,
      byokFunded: false,
    })).toBe('customer');
  });

  it('cannot turn an absorbed call into a BYOK line', () => {
    // The flag rides on TOP of the base answer. A mis-set flag on an absorbed
    // purpose leaves it absorbed rather than inventing a customer-funded line
    // for something no customer key ever served.
    expect(classifyChargeability({
      source: 'platform_llm',
      purpose: 'distill',
      agentId: AGENT,
      byokFunded: true,
    })).toBe('platform_overhead');
    expect(classifyChargeability({
      source: 'gcp_billing_platform',
      purpose: null,
      agentId: null,
      byokFunded: true,
    })).toBe('platform_overhead');
  });

  it('leaves every existing call unchanged when the flag is absent', () => {
    expect(classifyChargeability({
      source: 'tenant_runtime', purpose: null, agentId: AGENT,
    })).toBe('customer');
    expect(classifyChargeability({
      source: 'platform_llm', purpose: 'injection_guard', agentId: AGENT,
    })).toBe('platform_overhead');
  });
});

describe('the two previously unclassified purposes', () => {
  // They carry an agentId, so they already reached 'customer' — but through the
  // defensive "unknown purpose, charge it" branch, which is a default rather
  // than a decision. Enumerating them fixes the answer where a future refactor
  // of that branch cannot move it by accident.
  it.each(['absorption_classification', 'chat_learning_classification'])(
    '%s is customer-chargeable by name',
    (purpose) => {
      expect(classifyChargeability({
        source: 'platform_llm', purpose, agentId: AGENT,
      })).toBe('customer');
    },
  );

  it('does not absorb them — that would silently stop charging for them', () => {
    for (const purpose of ['absorption_classification', 'chat_learning_classification']) {
      expect(classifyChargeability({
        source: 'platform_llm', purpose, agentId: AGENT,
      })).not.toBe('platform_overhead');
    }
  });
});
