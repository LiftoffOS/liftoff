// A rollout writes the model SLUG into the policy, never the registry UUID.
//
// `models` has two identifiers and they are not interchangeable: `id` is a UUID
// primary key, and `model_id` is the vendor's own slug (`claude-sonnet-5-5`). A
// rollout needs both — the UUID identifies the config row it upserts, the slug is
// the only value a runtime can resolve against a provider.
//
// Both rollout paths wrote the UUID into `defaultModel`. The failure is entirely
// silent: the write succeeds, the config row is correct, the event publishes, the
// API answers 200 — and the policy names a model no provider has ever published,
// so nothing resolves from it. The rollback half is the worse one, because a
// rollback is what someone reaches for when a model is already misbehaving.
//
// This is the one place a model id legitimately reaches a policy. A rollout is a
// deliberate platform decision to put a tenant on a named model — a pin, not a
// workspace picking from a menu — which is why the fence in
// workspace-ai-vendors.test.ts covers what `buildWorkspaceAiPolicy` writes and
// not this.

import { jest } from '@jest/globals';

const NEW_MODEL = { id: 'uuid-new', modelId: 'claude-opus-5-5', provider: 'anthropic', tier: 'large' };
const OLD_MODEL = { id: 'uuid-old', modelId: 'claude-sonnet-5-5', provider: 'anthropic', tier: 'medium' };

const upsert = jest.fn(async () => ({}));
const deleteConfig = jest.fn(async () => undefined);

let rollout: Record<string, unknown> = {};

jest.mock('../repository', () => ({
  ModelRepository: jest.fn().mockImplementation(() => ({
    findById: jest.fn(async (id: string) =>
      id === NEW_MODEL.id ? NEW_MODEL : id === OLD_MODEL.id ? OLD_MODEL : null,
    ),
    findByTierAndProvider: jest.fn(async () => null),
  })),
  ModelConfigRepository: jest.fn().mockImplementation(() => ({
    upsert: (...args: unknown[]) => upsert(...(args as [])),
    delete: (...args: unknown[]) => deleteConfig(...(args as [])),
    findByTenantId: jest.fn(async () => []),
  })),
  ModelRolloutRepository: jest.fn().mockImplementation(() => ({
    findById: jest.fn(async () => rollout),
    completeRollout: jest.fn(async () => ({ ...rollout, status: 'completed' })),
    rollback: jest.fn(async () => ({ ...rollout, status: 'rolled_back' })),
  })),
}));

jest.mock('../../events/publisher', () => ({ publishEvent: jest.fn(async () => undefined) }));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { ModelRegistryService } from '../service';

/** The routing policy the rollout handed to the config repository. */
function writtenPolicy(): Record<string, unknown> {
  expect(upsert).toHaveBeenCalledTimes(1);
  return upsert.mock.calls[0][2] as Record<string, unknown>;
}

beforeEach(() => {
  upsert.mockClear();
  deleteConfig.mockClear();
});

describe('completeRollout', () => {
  beforeEach(() => {
    rollout = {
      id: 'r1', tenantId: 't1', modelId: NEW_MODEL.id,
      previousModelId: OLD_MODEL.id, status: 'in_progress', version: 1,
    };
  });

  it('writes the model slug, not the registry UUID', async () => {
    await new ModelRegistryService().completeRollout('r1');

    expect(writtenPolicy().defaultModel).toBe('claude-opus-5-5');
    expect(writtenPolicy().defaultModel).not.toBe(NEW_MODEL.id);
  });

  it('still identifies the config row by the UUID', async () => {
    // The distinction this test exists for: the same rollout field is correct in
    // one argument and wrong in the other, which is why one value was used for
    // both.
    await new ModelRegistryService().completeRollout('r1');

    expect(upsert.mock.calls[0][1]).toBe(NEW_MODEL.id);
  });
});

describe('rollbackRollout', () => {
  it('reverts to the previous model’s slug, not its UUID', async () => {
    rollout = {
      id: 'r2', tenantId: 't1', modelId: NEW_MODEL.id,
      previousModelId: OLD_MODEL.id, status: 'completed', version: 2,
    };

    await new ModelRegistryService().rollbackRollout('r2', 'regression');

    expect(writtenPolicy().defaultModel).toBe('claude-sonnet-5-5');
    expect(writtenPolicy().defaultModel).not.toBe(OLD_MODEL.id);
  });

  it('refuses rather than writing an unresolvable policy when the previous model is gone', async () => {
    // A rollback whose target row has been deleted cannot produce a slug. Failing
    // loudly is the only honest option: writing the UUID is what it used to do,
    // and that looked like a successful rollback.
    rollout = {
      id: 'r3', tenantId: 't1', modelId: NEW_MODEL.id,
      previousModelId: 'uuid-vanished', status: 'completed', version: 2,
    };

    await expect(new ModelRegistryService().rollbackRollout('r3', 'regression'))
      .rejects.toThrow(/Previous model uuid-vanished not found/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('deletes the config when the rollout had no previous model', async () => {
    rollout = {
      id: 'r4', tenantId: 't1', modelId: NEW_MODEL.id,
      previousModelId: null, status: 'in_progress', version: 1,
    };

    await new ModelRegistryService().rollbackRollout('r4', 'regression');

    expect(upsert).not.toHaveBeenCalled();
    expect(deleteConfig).toHaveBeenCalledWith('t1', NEW_MODEL.id);
  });
});
