// First direct tests for classifyChargeability (previously only mocked in
// other suites). Added with semantic recall v2 (plan Change 7): the recall
// embedding purposes must land on the intended sides of the
// platform-overhead / customer split, and the existing embedding purposes
// get regression rows so the policy is pinned, not incidental.

import { classifyChargeability } from '../event-classification';

const AGENT = '22222222-2222-4222-8222-222222222222';

describe('classifyChargeability — conversation recall purposes (v2)', () => {
  it('conversation_recall (background turn embeds) → platform_overhead with agentId', () => {
    expect(classifyChargeability({
      source: 'platform_llm',
      purpose: 'conversation_recall',
      agentId: AGENT,
    })).toBe('platform_overhead');
  });

  it('conversation_recall → platform_overhead without agentId', () => {
    expect(classifyChargeability({
      source: 'platform_llm',
      purpose: 'conversation_recall',
      agentId: null,
    })).toBe('platform_overhead');
  });

  it('conversation_recall_query + agentId → customer via the agent-attributed fallthrough', () => {
    // DELIBERATELY not enumerated in either purpose set — identical policy
    // to knowledge_embedding_query / capability_embedding_query.
    expect(classifyChargeability({
      source: 'platform_llm',
      purpose: 'conversation_recall_query',
      agentId: AGENT,
    })).toBe('customer');
  });
});

describe('classifyChargeability — existing embedding purposes (regression)', () => {
  it('knowledge_embedding → platform_overhead', () => {
    expect(classifyChargeability({
      source: 'platform_llm',
      purpose: 'knowledge_embedding',
      agentId: null,
    })).toBe('platform_overhead');
  });

  it('capability_embedding → platform_overhead even when agent-attributed', () => {
    expect(classifyChargeability({
      source: 'platform_llm',
      purpose: 'capability_embedding',
      agentId: AGENT,
    })).toBe('platform_overhead');
  });

  it('knowledge_embedding_query + agentId → customer (fallthrough)', () => {
    expect(classifyChargeability({
      source: 'platform_llm',
      purpose: 'knowledge_embedding_query',
      agentId: AGENT,
    })).toBe('customer');
  });

  it('capability_embedding_query + agentId → customer (fallthrough)', () => {
    expect(classifyChargeability({
      source: 'platform_llm',
      purpose: 'capability_embedding_query',
      agentId: AGENT,
    })).toBe('customer');
  });

  it('platform_llm with no agentId and unknown purpose → platform_overhead', () => {
    expect(classifyChargeability({
      source: 'platform_llm',
      purpose: 'something_unknown',
      agentId: null,
    })).toBe('platform_overhead');
  });

  it('non-platform sources stay customer (tenant workload by definition)', () => {
    expect(classifyChargeability({
      source: 'tenant_runtime',
      purpose: null,
      agentId: AGENT,
    })).toBe('customer');
  });
});

describe('classifyChargeability — the distiller patch rung', () => {
  it('distill_patch + agentId (a redistill) → platform_overhead, never the customer', () => {
    // A patch call on a redistill carries the agentId. Without the explicit
    // entry it would fall through to the agent-attributed "charge it" arm and
    // the customer would pay for the platform repairing its own output.
    expect(classifyChargeability({
      source: 'platform_llm',
      purpose: 'distill_patch',
      agentId: AGENT,
    })).toBe('platform_overhead');
  });

  it('distill_patch without agentId (a first hire) → platform_overhead', () => {
    expect(classifyChargeability({
      source: 'platform_llm',
      purpose: 'distill_patch',
      agentId: null,
    })).toBe('platform_overhead');
  });

  it('lands on the same side as the distill call it stands in for', () => {
    for (const agentId of [AGENT, null]) {
      expect(classifyChargeability({ source: 'platform_llm', purpose: 'distill_patch', agentId }))
        .toBe(classifyChargeability({ source: 'platform_llm', purpose: 'distill_update', agentId }));
    }
  });
});

describe('classifyChargeability — the TypeSafe purposes', () => {
  it('tool_classification → platform_overhead with and without an agentId', () => {
    for (const agentId of [AGENT, null]) {
      expect(classifyChargeability({ source: 'platform_llm', purpose: 'tool_classification', agentId }))
        .toBe('platform_overhead');
    }
  });

  it('distill_bind lands beside distill_patch: platform_overhead with and without an agentId', () => {
    for (const agentId of [AGENT, null]) {
      expect(classifyChargeability({ source: 'platform_llm', purpose: 'distill_bind', agentId }))
        .toBe('platform_overhead');
      expect(classifyChargeability({ source: 'platform_llm', purpose: 'distill_bind', agentId }))
        .toBe(classifyChargeability({ source: 'platform_llm', purpose: 'distill_patch', agentId }));
    }
  });

  it.each([
    'browser_task', 'browser_step', 'browser_goal_check', 'contract_check',
    'ask_check', 'memory_save', 'memory_used', 'message_check',
  ])('%s is customer usage without an agent id', (purpose) => {
    expect(classifyChargeability({ source: 'platform_llm', purpose, agentId: null })).toBe('customer');
    expect(classifyChargeability({ source: 'platform_llm', purpose, agentId: AGENT })).toBe('customer');
  });

  it('route_message with the chosen team → customer; route_message_none → platform_overhead', () => {
    expect(classifyChargeability({ source: 'platform_llm', purpose: 'route_message', agentId: AGENT })).toBe('customer');
    for (const agentId of [AGENT, null]) {
      expect(classifyChargeability({ source: 'platform_llm', purpose: 'route_message_none', agentId }))
        .toBe('platform_overhead');
    }
  });
});
