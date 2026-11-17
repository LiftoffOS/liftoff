// Asserts the admin-only modelConfig gate (PR 1.2 / D1+D2):
//   - adminModelConfigSchema accepts a typed tier/modelId payload and
//     defaults tier to 'medium' when omitted.
//   - customerModelConfigSchema rejects any caller-supplied modelConfig.

// The real schemas, from the request boundary every surface shares. This file
// used to mirror them inline, which is how a mirror stops testing anything: it
// kept passing on its own copy of the tier list.
import { adminModelConfigSchema, customerModelConfigSchema } from '../../workspace-actions/schemas';

describe('adminModelConfigSchema', () => {
  it('defaults tier to "medium" when admin omits the field entirely', () => {
    const parsed = adminModelConfigSchema.parse(undefined);
    expect(parsed).toEqual({ tier: 'medium' });
  });

  it('defaults tier to "medium" when admin supplies an empty object', () => {
    const parsed = adminModelConfigSchema.parse({});
    expect(parsed.tier).toBe('medium');
  });

  it('accepts an admin-supplied large tier', () => {
    const parsed = adminModelConfigSchema.parse({ tier: 'large' });
    expect(parsed.tier).toBe('large');
  });

  it('accepts a pinned modelId alongside the tier default', () => {
    const parsed = adminModelConfigSchema.parse({ modelId: 'claude-opus-4-7' });
    expect(parsed).toEqual({ modelId: 'claude-opus-4-7', tier: 'medium' });
  });

  it('rejects an unknown tier value', () => {
    const result = adminModelConfigSchema.safeParse({ tier: 'huge' });
    expect(result.success).toBe(false);
  });

  it('reads the pre-532 name of the large tier as large', () => {
    // A client or runtime still on the old version during a deploy.
    const parsed = adminModelConfigSchema.parse({ tier: 'flagship' });
    expect(parsed.tier).toBe('large');
  });

  it('refuses Frontier: a designation above the tiers, not a tier', () => {
    expect(adminModelConfigSchema.safeParse({ tier: 'frontier' }).success).toBe(false);
  });
});

describe('customerModelConfigSchema', () => {
  it('accepts undefined (the canonical no-modelConfig customer request)', () => {
    expect(customerModelConfigSchema.safeParse(undefined).success).toBe(true);
  });

  it('rejects any non-undefined customer modelConfig', () => {
    expect(customerModelConfigSchema.safeParse({ tier: 'large' }).success).toBe(false);
    expect(customerModelConfigSchema.safeParse({}).success).toBe(false);
    expect(customerModelConfigSchema.safeParse({ modelId: 'claude-opus-4-7' }).success).toBe(false);
    expect(customerModelConfigSchema.safeParse(null).success).toBe(false);
    expect(customerModelConfigSchema.safeParse('large').success).toBe(false);
  });
});
