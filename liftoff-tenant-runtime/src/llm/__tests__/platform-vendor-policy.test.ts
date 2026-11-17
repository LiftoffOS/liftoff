// The runtime's copy of the platform vendor levers.
//
// The area map is MIRRORED from the control plane rather than shared, because
// this repo cannot import from its src/. What matters is that the two give the
// same answer: if the control plane thinks `dlp_deep_scan` is safety work and
// this plane thinks it is quiet work, the same purpose runs on two vendors
// depending on which side issued the call — the exact defect one feed and one
// answer exist to prevent.
//
// The purposes below are the ones the control plane classifies explicitly, so a
// divergence on any of them fails here.

import {
  areaForPurpose,
  platformVendorForArea,
  _platformVendorPolicy,
  _resetPlatformVendorPolicy,
  resolvePlatformVendorTarget,
  setPlatformVendorPolicy,
  PLATFORM_VENDOR_AREAS,
  UNREGISTERED_PURPOSE_AREA,
} from '../platform-vendor-policy';
import { TIER_MODELS as QWEN_TIERS } from '../providers/qwen';
import { TIER_MODELS as XIAOMI_TIERS } from '../providers/xiaomi';

afterEach(() => _resetPlatformVendorPolicy());

describe('the area map agrees with the control plane', () => {
  it.each([
    ['liftoff_chat', 'assistants'],
    ['liftoff_summarization', 'assistants'],
    ['insights_chat', 'assistants'],
    ['insights_intro', 'assistants'],
    ['caio_workforce_planning', 'assistants'],
    ['caio_dataset_extract', 'assistants'],
    ['workforce_chat', 'assistants'],
    ['team_plan', 'assistants'],
    ['brief_echo', 'assistants'],
    ['distill', 'team_shaping'],
    ['distill_patch', 'team_shaping'],
    ['capability_analysis', 'team_shaping'],
    ['template_eval_rubric', 'team_shaping'],
    ['skill_dedup_calibration', 'team_shaping'],
    ['injection_guard', 'safety'],
    ['untrusted_content', 'safety'],
    ['dlp_deep_scan', 'safety'],
    ['tool_classification', 'safety'],
    ['route_message', 'safety'],
    ['output_guard', 'safety'],
    ['chat_learning_classification', 'safety'],
    ['thread_title_generation', 'quiet_work'],
    ['history-compaction', 'quiet_work'],
    ['retrieval_hyde', 'quiet_work'],
    ['reflection', 'quiet_work'],
    ['memory_consolidation', 'quiet_work'],
  ])('puts %s in %s', (purpose, area) => {
    expect(areaForPurpose(purpose)).toBe(area);
  });

  it('checks safety before the family prefixes', () => {
    expect(areaForPurpose('suggestion_response_classification')).toBe('safety');
  });

  it('sends an unregistered purpose to quiet work', () => {
    expect(areaForPurpose('something_nobody_registered')).toBe('quiet_work');
    expect(areaForPurpose(undefined)).toBe(UNREGISTERED_PURPOSE_AREA);
  });
});

describe('the overlay', () => {
  it('starts on the platform default, so a runtime that never reached the control plane is unchanged', () => {
    for (const area of PLATFORM_VENDOR_AREAS) {
      expect(platformVendorForArea(area)).toBe('default');
    }
  });

  it('installs what the snapshot carries and fills the rest', () => {
    setPlatformVendorPolicy({ quiet_work: 'qwen', safety: 'xiaomi' });
    expect(_platformVendorPolicy()).toEqual({
      assistants: 'default', team_shaping: 'default',
      quiet_work: 'qwen', safety: 'xiaomi',
    });
  });

  it('treats an absent snapshot field as the default, not as empty', () => {
    // A platform-backend predating the table sends no field at all. Reading that
    // as "no vendor" would leave every area unset.
    setPlatformVendorPolicy(undefined);
    expect(platformVendorForArea('assistants')).toBe('default');
  });
});

describe('what a lever resolves to in the runtime', () => {
  it('leaves the call alone on the default', () => {
    expect(resolvePlatformVendorTarget('default', 'small')).toBeNull();
    expect(resolvePlatformVendorTarget('', 'small')).toBeNull();
  });

  it('names a gateway family AND its model, because each family has its own map', () => {
    expect(resolvePlatformVendorTarget('qwen', 'small')).toEqual({
      provider: 'qwen', model: QWEN_TIERS.small,
    });
    expect(resolvePlatformVendorTarget('xiaomi', 'large')).toEqual({
      provider: 'xiaomi', model: XIAOMI_TIERS.large,
    });
  });

  it('falls back to the family medium for an unrecognised tier', () => {
    expect(resolvePlatformVendorTarget('qwen', 'nonsense')).toEqual({
      provider: 'qwen', model: QWEN_TIERS.medium,
    });
  });

  it('names the direct providers without a model', () => {
    expect(resolvePlatformVendorTarget('anthropic', 'medium')).toEqual({ provider: 'anthropic' });
    expect(resolvePlatformVendorTarget('google', 'large')).toEqual({ provider: 'google' });
  });

  it('refuses Grok, which does not run through this client', () => {
    expect(resolvePlatformVendorTarget('grok', 'medium')).toBeNull();
  });
});
