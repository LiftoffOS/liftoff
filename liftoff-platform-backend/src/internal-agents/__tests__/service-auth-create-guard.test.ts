// HRBP (service-auth) create callers cannot smuggle modelConfig, a
// cross-tenant tenantId, or a non-draft status through the create tool.

import { stripServiceAuthCreateBody } from '../service-auth-create-guard';

describe(' — service-auth create guard', () => {
  it('strips modelConfig and tenantId, keeping every other field', () => {
    const out = stripServiceAuthCreateBody({
      name: 'Support Agent',
      role: 'support',
      instructions: 'help customers',
      modelConfig: { provider: 'openai', tier: 'high' },
      tenantId: 'tenant-evil',
    });
    expect(out).toEqual({
      name: 'Support Agent',
      role: 'support',
      instructions: 'help customers',
      status: 'draft',
    });
    expect(out.modelConfig).toBeUndefined();
    expect(out.tenantId).toBeUndefined();
  });

  it('does not mutate the caller-supplied body', () => {
    const input: Record<string, unknown> = { modelConfig: { tier: 'high' }, tenantId: 't' };
    stripServiceAuthCreateBody(input);
    expect(input.modelConfig).toBeDefined();
    expect(input.tenantId).toBeDefined();
  });

  it('handles null / undefined / empty bodies', () => {
    expect(stripServiceAuthCreateBody(null)).toEqual({ status: 'draft' });
    expect(stripServiceAuthCreateBody(undefined)).toEqual({ status: 'draft' });
    expect(stripServiceAuthCreateBody({})).toEqual({ status: 'draft' });
  });

  // The paywall on this route is this line. POST /_svc has no Zod and no
  // checkExecutionAllowed, so before this the only thing keeping an active
  // agent off it was that HRBP, in another repo, happened to hardcode 'draft'.
  it('forces status to draft, whatever the caller asked for', () => {
    expect(stripServiceAuthCreateBody({ status: 'active' }).status).toBe('draft');
    expect(stripServiceAuthCreateBody({ status: 'paused' }).status).toBe('draft');
    expect(stripServiceAuthCreateBody({ status: 'nonsense' }).status).toBe('draft');
    expect(stripServiceAuthCreateBody({ name: 'x' }).status).toBe('draft');
  });

  // Order matters: `status` is pinned after the spread, so a caller cannot win
  // by ordering its own keys differently.
  it('pins status even when the body sets it last', () => {
    const body = { name: 'Late', modelConfig: { tier: 'high' }, status: 'active' };
    expect(stripServiceAuthCreateBody(body)).toEqual({ name: 'Late', status: 'draft' });
  });
});
