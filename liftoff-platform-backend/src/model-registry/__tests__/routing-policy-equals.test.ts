// routingPolicyEquals — the comparison that lets the re-stamp run on every
// deploy.
//
// The re-stamp is what makes a model upgrade SWEEPING: a tier change has to
// reach tenants that already exist, and the policy is materialized into every
// tenant's row, so something has to rewrite those rows. Running that on every
// deploy is only safe if an unchanged tenant is genuinely skipped, because
// setWorkspaceVendor upserts and publishes unconditionally — a comparison that
// reports a false difference turns `model_configs.version` into a deploy
// counter and wakes every runtime on every release.
//
// The false-difference case is not hypothetical and is the reason this is not
// a JSON.stringify one-liner: the stored policy comes back out of `jsonb`,
// which Postgres keys in its own order rather than the order it was written.

import {
  buildWorkspaceAiPolicy,
  routingPolicyEquals,
} from '../workspace-ai-vendors';
import type { RoutingPolicy } from '../types';

/** Re-key an object the way a jsonb round trip does — deterministically NOT in
 *  insertion order — so the test exercises the real hazard rather than an
 *  object that happens to compare equal. */
function reorderKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reorderKeys) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).reverse()) {
      out[key] = reorderKeys((value as Record<string, unknown>)[key]);
    }
    return out as unknown as T;
  }
  return value;
}

describe('routingPolicyEquals', () => {
  it('calls a freshly built policy equal to itself — the no-op deploy', () => {
    const policy = buildWorkspaceAiPolicy('openai', undefined);
    expect(routingPolicyEquals(policy, buildWorkspaceAiPolicy('openai', policy))).toBe(true);
  });

  it('ignores key order, the way a jsonb round trip reorders it', () => {
    // THE case this function exists for. Without canonicalization this is
    // false for every tenant, every deploy, and the skip never fires.
    const policy = buildWorkspaceAiPolicy('anthropic', undefined);
    const fromDatabase = reorderKeys(policy);
    expect(JSON.stringify(fromDatabase)).not.toBe(JSON.stringify(policy));
    expect(routingPolicyEquals(fromDatabase, policy)).toBe(true);
  });

  it('sees a changed default model — the upgrade it must not miss', () => {
    const before = buildWorkspaceAiPolicy('openai', undefined);
    const after: RoutingPolicy = { ...before, defaultModel: 'gpt-6-sol' };
    // Guard the fixture: if the ladder ever seeds this value the assertion
    // below would pass for the wrong reason.
    expect(before.defaultModel).not.toBe('some-older-model');
    expect(routingPolicyEquals({ ...before, defaultModel: 'some-older-model' }, after)).toBe(false);
  });

  it('sees a changed background-task model', () => {
    const before = buildWorkspaceAiPolicy('default', undefined);
    const stale: RoutingPolicy = {
      ...before,
      taskOverrides: { ...before.taskOverrides, retrieval_hyde: 'claude-haiku-4-0' },
    };
    expect(routingPolicyEquals(stale, before)).toBe(false);
  });

  it('treats an absent key and an explicitly undefined one as the same policy', () => {
    // `undefined` cannot survive jsonb, so calling these different would report
    // a change the database cannot represent — a write that never settles.
    const base = buildWorkspaceAiPolicy('default', undefined);
    expect(routingPolicyEquals(base, { ...base, selectedVendor: undefined })).toBe(true);
  });

  it('does not equate a missing policy with an empty one', () => {
    const base = buildWorkspaceAiPolicy('default', undefined);
    expect(routingPolicyEquals(undefined, base)).toBe(false);
    expect(routingPolicyEquals(undefined, undefined)).toBe(true);
  });

  it('preserves the tenant embedding choice, so a re-stamp is a no-op for it', () => {
    // Embeddings never follow the vendor selection (re-embedding is
    // destructive). A re-stamp that moved them would be a silent data change,
    // and the comparison is what proves it does not.
    const chosen = buildWorkspaceAiPolicy('default', undefined);
    const withOwnEmbedding: RoutingPolicy = {
      ...chosen,
      taskOverrides: { ...chosen.taskOverrides, embedding: 'text-multilingual-embedding-002' },
      providerOverrides: { ...chosen.providerOverrides, embedding: 'google' },
    };
    const rebuilt = buildWorkspaceAiPolicy('default', withOwnEmbedding);
    expect(rebuilt.taskOverrides?.embedding).toBe('text-multilingual-embedding-002');
    expect(routingPolicyEquals(withOwnEmbedding, rebuilt)).toBe(true);
  });
});
