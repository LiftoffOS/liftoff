// The four platform vendor levers.
//
// A workspace's vendor choice answers what ITS teams run on. These answer what
// LIFTOFF's own work runs on, and the two must not be the same setting — a
// workspace switching to Qwen should not move the Chief AI Officer with it.
//
// What is asserted here is the part that cannot be seen by reading: which AREA
// a purpose lands in. Get that wrong and a cost lever silently moves a safety
// gate, or team-shaping work, and nothing fails — it just gets worse.

import {
  areaForPurpose,
  platformVendorForArea,
  platformVendorPolicy,
  _resetPlatformVendorPolicy,
  resolvePlatformVendorTarget,
  selectablePlatformVendors,
  setPlatformVendorPolicy,
  PLATFORM_VENDOR_AREAS,
  PLATFORM_VENDOR_FALLBACK,
  UNREGISTERED_PURPOSE_AREA,
} from '../platform-vendor-policy';
import { WORKSPACE_AI_VENDORS } from '../workspace-ai-vendors';

afterEach(() => _resetPlatformVendorPolicy());

describe('which area a purpose belongs to', () => {
  it.each([
    // The four assistants, by the prefixes their purposes actually use.
    'liftoff_chat', 'liftoff_summarization', 'liftoff_dataset_extract',
    'insights_chat', 'insights_intro', 'insights_observation',
    'caio_workforce_planning', 'caio_workforce_planning_title_generation',
    'caio_dataset_extract', 'workforce_chat', 'team_plan', 'brief_echo',
  ])('puts %s with the assistants', (purpose) => {
    expect(areaForPurpose(purpose)).toBe('assistants');
  });

  it.each([
    'distill', 'distill_patch', 'distill_update', 'distill_bind',
    'distill_semantic_validation', 'distill_ab_judge',
    'capability_analysis', 'capability_blueprint_analyzer',
    'capability_discovery_judge', 'template_eval_rubric',
    'skill_dedup_calibration',
  ])('puts %s with team shaping', (purpose) => {
    expect(areaForPurpose(purpose)).toBe('agent_shaping');
  });

  it.each([
    'injection_guard', 'untrusted_content', 'dlp_deep_scan',
    'tool_classification', 'harvest_classification',
    'absorption_classification', 'route_message', 'output_guard',
  ])('puts %s with safety', (purpose) => {
    expect(areaForPurpose(purpose)).toBe('safety');
  });

  it.each([
    'thread_title_generation', 'history-compaction', 'conversation_recall',
    'retrieval_hyde', 'reflection', 'memory_consolidation',
    'preference_aggregation', 'workflow_visualization_steps_generation',
  ])('puts %s with the quiet work', (purpose) => {
    expect(areaForPurpose(purpose)).toBe('quiet_work');
  });

  // The ordering law. `absorption_classification` starts with no family prefix,
  // but `template_description` does — and a classification that got captured by
  // a family prefix would ride the wrong lever silently.
  it('checks safety BEFORE the family prefixes', () => {
    expect(areaForPurpose('chat_learning_classification')).toBe('safety');
    expect(areaForPurpose('suggestion_response_classification')).toBe('safety');
  });

  it('sends an unregistered purpose to quiet work, not team shaping', () => {
    // The direction of the mistake is the point: an unknown running cheap shows
    // up as quality on a watched surface, where an unknown silently riding the
    // team-shaping lever would not show up at all.
    expect(areaForPurpose('some_future_background_job')).toBe(UNREGISTERED_PURPOSE_AREA);
    expect(areaForPurpose('something_nobody_registered')).toBe('quiet_work');
    expect(areaForPurpose(undefined)).toBe('quiet_work');
  });
});

describe('the policy itself', () => {
  it('defaults every area to the platform default, so shipping it changes nothing', () => {
    for (const area of PLATFORM_VENDOR_AREAS) {
      expect(platformVendorForArea(area)).toBe('default');
      expect(PLATFORM_VENDOR_FALLBACK[area]).toBe('default');
    }
  });

  it('sets one area without disturbing the others', () => {
    setPlatformVendorPolicy({ quiet_work: 'qwen' });
    expect(platformVendorForArea('quiet_work')).toBe('qwen');
    expect(platformVendorForArea('agent_shaping')).toBe('default');
    expect(platformVendorForArea('safety')).toBe('default');
  });

  it('IGNORES a vendor this build does not have, rather than writing it through', () => {
    // A row naming a retired vendor would otherwise take the fallback's place
    // while reading as configured, and route the area to nothing.
    setPlatformVendorPolicy({ assistants: 'not-a-vendor' as never });
    expect(platformVendorForArea('assistants')).toBe('default');
  });

  it('fills absent areas from the fallback rather than leaving them undefined', () => {
    setPlatformVendorPolicy({ safety: 'qwen' });
    expect(platformVendorPolicy()).toEqual({
      assistants: 'default', agent_shaping: 'default',
      quiet_work: 'default', safety: 'qwen',
    });
  });
});

describe('what a lever resolves to on the control plane', () => {
  it('leaves the call alone for the platform default', () => {
    expect(resolvePlatformVendorTarget('default', 'medium')).toBeNull();
  });

  it('names the provider directly for the three it holds a client for', () => {
    expect(resolvePlatformVendorTarget('anthropic', 'medium')).toEqual({ provider: 'anthropic' });
    expect(resolvePlatformVendorTarget('openai', 'small')).toEqual({ provider: 'openai' });
    expect(resolvePlatformVendorTarget('google', 'large')).toEqual({ provider: 'google' });
  });

  it('FIXES THE MODEL for a gateway vendor, because the gateway map is GLM\'s', () => {
    // Without the model, asking the gateway client for tier 'small' answers
    // with GLM's small whatever vendor the lever named.
    const qwen = resolvePlatformVendorTarget('qwen', 'small');
    expect(qwen).toEqual({
      provider: 'openrouter',
      model: WORKSPACE_AI_VENDORS.qwen.tiers.small,
    });
    const xiaomi = resolvePlatformVendorTarget('xiaomi', 'large');
    expect(xiaomi).toEqual({
      provider: 'openrouter',
      model: WORKSPACE_AI_VENDORS.xiaomi.tiers.large,
    });
  });

  it('falls back for Grok, which this plane cannot reach', () => {
    // Grok left the gateway for api.x.ai and the control plane has no xAI
    // client. Answering 'openrouter' would run GLM under Grok's name.
    expect(resolvePlatformVendorTarget('grok', 'medium')).toBeNull();
  });

  it('defaults an absent tier to medium rather than resolving nothing', () => {
    expect(resolvePlatformVendorTarget('qwen', undefined)).toEqual({
      provider: 'openrouter',
      model: WORKSPACE_AI_VENDORS.qwen.tiers.medium,
    });
  });

  it('offers only vendors it can actually route to', () => {
    const selectable = selectablePlatformVendors();
    expect(selectable).toContain('default');
    expect(selectable).toContain('qwen');
    expect(selectable).toContain('anthropic');
    // Refused rather than accepted-and-ignored.
    expect(selectable).not.toContain('grok');
  });
});
