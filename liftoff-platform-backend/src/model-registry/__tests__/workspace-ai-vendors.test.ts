// buildWorkspaceAiPolicy — the Workspace AI routing-policy builder.
//
// THE RULE THIS FILE FENCES: a workspace selects an AI PROVIDER. It does not
// select a model. What a tier resolves to is decided centrally in the `models`
// registry and resolved at the moment of the call, so a stored policy holds
// DECISIONS — a provider and a tier, per default and per task — and no model id.
//
// It used to hold one, derived from (vendor, tier) at write time and preferred
// over the tier by every reader. A derived value stored beside its own inputs is
// a cache with no invalidation: the registry moved, the policies did not, and it
// took a job re-stamping every tenant on every deploy to keep them approximately
// current. When the OpenAI ladder moved to GPT-6 that job had not run, so every
// existing workspace was a generation behind.
//
// Covers: per-vendor shape, background-task decisions (tier + provider, no
// model), the one model id that legitimately remains, selectedVendor marker
// semantics, 'default' restore, and builder idempotence (the property the
// re-stamp script relied on).

import {
  buildWorkspaceAiPolicy,
  BACKGROUND_TASK_ASSIGNMENTS,
  LIFTOFF_MANAGED_VENDOR,
  WORKSPACE_AI_VENDORS,
  WORKSPACE_AI_SELECTIONS,
  isWorkspaceAiSelection,
  type WorkspaceAiVendor,
} from '../workspace-ai-vendors';
import type { RoutingPolicy } from '../types';

const BACKGROUND_TASKS = Object.keys(BACKGROUND_TASK_ASSIGNMENTS);

// A current policy in the migration-187/188 shape (what every tenant has today).
const CURRENT_187_POLICY: RoutingPolicy = {
  defaultProvider: 'anthropic',
  defaultTier: 'medium',
  defaultModel: 'claude-sonnet-4-6',
  taskTierOverrides: {
    retrieval_hyde: 'small', memory_consolidation: 'small', suggestion_applier: 'small',
    'chat-feedback-extraction': 'small', tabular_extract: 'small',
  },
  taskOverrides: {
    retrieval_hyde: 'claude-haiku-4-5-20251001',
    memory_consolidation: 'claude-haiku-4-5-20251001',
    suggestion_applier: 'claude-haiku-4-5-20251001',
    'chat-feedback-extraction': 'claude-haiku-4-5-20251001',
    tabular_extract: 'claude-haiku-4-5-20251001',
    embedding: 'text-embedding-004',
  },
  providerOverrides: { embedding: 'google' },
};

describe('buildWorkspaceAiPolicy', () => {
  it.each(Object.keys(WORKSPACE_AI_VENDORS) as WorkspaceAiVendor[])(
    'vendor %s: default routing records the provider and the tier, and no model',
    (vendor) => {
      const policy = buildWorkspaceAiPolicy(vendor, CURRENT_187_POLICY);
      expect(policy.defaultProvider).toBe(WORKSPACE_AI_VENDORS[vendor].provider);
      expect(policy.defaultTier).toBe('medium');
      expect(policy.selectedVendor).toBe(vendor);
      // The whole point: no resolved id, even though one is trivially derivable
      // here. Deriving it is the runtime's job, on every call, against the
      // registry — which is the only place that stays current.
      expect(policy.defaultModel).toBeUndefined();
      expect('defaultModel' in policy).toBe(false);
    },
  );

  it.each(Object.keys(WORKSPACE_AI_VENDORS) as WorkspaceAiVendor[])(
    'vendor %s: background five carry a tier AND a provider, and no model',
    (vendor) => {
      const policy = buildWorkspaceAiPolicy(vendor, CURRENT_187_POLICY);
      for (const task of BACKGROUND_TASKS) {
        const assignment = BACKGROUND_TASK_ASSIGNMENTS[task];
        const assignedSpec = WORKSPACE_AI_VENDORS[assignment.vendor];
        // Both halves of the DECISION are explicit, and both are load-bearing.
        // The provider, because the runtime resolves
        // `providerOverrides[task] || defaultProvider` and these tasks once
        // carried only a model — fine while every workspace was Anthropic, and a
        // Qwen workspace asking OpenRouter for a Claude model afterwards. The
        // tier, because without it each task falls to the workspace default,
        // which is a tier up and priced like one.
        expect(policy.providerOverrides?.[task]).toBe(assignedSpec.provider);
        expect(policy.taskTierOverrides?.[task]).toBe(assignment.tier);
        expect(policy.taskOverrides?.[task]).toBeUndefined();
      }
    },
  );

  it('preserves the embedding keys verbatim from the current policy', () => {
    const custom: RoutingPolicy = {
      ...CURRENT_187_POLICY,
      taskOverrides: { ...CURRENT_187_POLICY.taskOverrides, embedding: 'gemini-embedding-001' },
      providerOverrides: { embedding: 'google' },
    };
    const policy = buildWorkspaceAiPolicy('qwen', custom);
    expect(policy.taskOverrides?.embedding).toBe('gemini-embedding-001');
    expect(policy.providerOverrides?.embedding).toBe('google');
  });

  it('stamps the 188 embedding defaults only when the current policy lacks them', () => {
    const policy = buildWorkspaceAiPolicy('glm', undefined);
    expect(policy.taskOverrides?.embedding).toBe('text-embedding-004');
    expect(policy.providerOverrides?.embedding).toBe('google');
  });

  // Asserted through the vendor map rather than against frozen model ids. What
  // 'default' MEANS — Liftoff Managed is anthropic routing, at that vendor's
  // medium tier, with no marker written — is the property worth pinning; which
  // model that tier resolves to is the registry's answer and moves when a model
  // is onboarded. Pinning the id here would fail the build on a legitimate
  // registry row and say nothing about the behaviour this test is named for.
  it("'default' restores the platform-managed anthropic policy with NO marker", () => {
    const managed = WORKSPACE_AI_VENDORS[LIFTOFF_MANAGED_VENDOR];
    const policy = buildWorkspaceAiPolicy('default', CURRENT_187_POLICY);
    expect(LIFTOFF_MANAGED_VENDOR).toBe('anthropic');
    expect(policy.defaultProvider).toBe('anthropic');
    expect(policy.defaultTier).toBe('medium');
    expect(policy.defaultModel).toBeUndefined();
    expect(policy.selectedVendor).toBeUndefined();
    expect('selectedVendor' in policy).toBe(false);
    expect(managed.provider).toBe('anthropic');
    // Background five carry their assigned tier under anthropic — the same
    // DECISION the 187/188 policy expressed, minus the frozen ids.
    for (const task of BACKGROUND_TASKS) {
      const assignment = BACKGROUND_TASK_ASSIGNMENTS[task];
      expect(assignment.vendor).toBe('anthropic');
      expect(policy.taskTierOverrides?.[task]).toBe(assignment.tier);
      expect(policy.providerOverrides?.[task]).toBe('anthropic');
      expect(policy.taskOverrides?.[task]).toBeUndefined();
    }
  });

  it('is idempotent: rebuilding from its own output yields an identical policy', () => {
    for (const selection of WORKSPACE_AI_SELECTIONS) {
      const once = buildWorkspaceAiPolicy(selection, CURRENT_187_POLICY);
      const twice = buildWorkspaceAiPolicy(selection, once);
      expect(twice).toEqual(once);
    }
  });

  it('does NOT flow a vendor-map model edit into the policy — that is the point', () => {
    // The inverse of the test this replaces. It used to assert that editing the
    // vendor map changed what got stamped, which is exactly the coupling that
    // made a policy go stale the moment the map moved again. A policy is now
    // independent of which model a tier currently names, so a map edit reaches
    // runs through resolution and reaches stored policies not at all.
    const original = WORKSPACE_AI_VENDORS.anthropic.tiers.small;
    try {
      WORKSPACE_AI_VENDORS.anthropic.tiers.small = 'claude-haiku-9-test';
      const policy = buildWorkspaceAiPolicy('qwen', CURRENT_187_POLICY);
      expect(JSON.stringify(policy)).not.toContain('claude-haiku-9-test');
    } finally {
      WORKSPACE_AI_VENDORS.anthropic.tiers.small = original;
    }
  });

  it('assignments constant contains no model names (convention references only)', () => {
    for (const assignment of Object.values(BACKGROUND_TASK_ASSIGNMENTS)) {
      expect(Object.keys(assignment).sort()).toEqual(['tier', 'vendor']);
      expect(['large', 'medium', 'small']).toContain(assignment.tier);
      expect(Object.keys(WORKSPACE_AI_VENDORS)).toContain(assignment.vendor);
    }
  });
});

// ── The rule, made mechanical ───────────────────────────────────────────────
//
// Every test above asserts the absence of a PARTICULAR id. This one asserts the
// absence of the whole CLASS, for every selection, so a future field cannot
// quietly reintroduce one under a new name. That is the difference between a
// convention and a fence, and this estate has the scar: `defaultModel` and the
// five task ids were each added by someone who had a good local reason.
describe('no stored policy names a model, whatever the selection', () => {
  // The one legitimate exception, and it is not a routing choice. The embedding
  // entry records WHICH MODEL PRODUCED THE STORED VECTORS. Vectors from two
  // embedding models do not share a space, so resolving it at call time would
  // silently start mixing spaces and corrupt retrieval with no error. Changing
  // it means re-embedding, which is a migration, not a lookup.
  const PROVENANCE_KEYS = ['embedding'];

  /** Every string value in the policy, with its path, except the provenance
   *  entry and the `selectedVendor` marker (a vendor name, which is the one
   *  thing a workspace does choose). */
  function routingValues(policy: RoutingPolicy): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(policy)) {
      if (key === 'selectedVendor') continue;
      if (typeof value === 'string') out.push([key, value]);
      else if (value && typeof value === 'object') {
        for (const [inner, v] of Object.entries(value as Record<string, unknown>)) {
          if (PROVENANCE_KEYS.includes(inner)) continue;
          if (typeof v === 'string') out.push([`${key}.${inner}`, v]);
        }
      }
    }
    return out;
  }

  it('holds no model id that any vendor publishes, for any selection', () => {
    // Built from the vendor map rather than a hand-written list, so a vendor or
    // tier added later is covered without anyone remembering to add it here.
    const everyPublishedModel = new Set<string>();
    for (const spec of Object.values(WORKSPACE_AI_VENDORS)) {
      for (const id of Object.values(spec.tiers)) everyPublishedModel.add(id);
      if (spec.frontier) everyPublishedModel.add(spec.frontier);
    }

    for (const selection of WORKSPACE_AI_SELECTIONS) {
      const policy = buildWorkspaceAiPolicy(selection, CURRENT_187_POLICY);
      for (const [path, value] of routingValues(policy)) {
        expect(everyPublishedModel.has(value)).toBe(false);
        // Named so a failure says WHICH field reintroduced one.
        if (everyPublishedModel.has(value)) throw new Error(`${path} names a model: ${value}`);
      }
    }
  });

  it('holds nothing model-id SHAPED, so a new vendor cannot slip through', () => {
    // The set above only knows the models this build ships. A version-suffixed
    // or publisher-namespaced id is recognisable by shape, which catches an id
    // from a vendor this build has never heard of.
    const MODEL_SHAPED = /^(claude|gpt|gemini|grok)-|^(z-ai|qwen|deepseek|moonshotai|minimax|xiaomi)\//;

    for (const selection of WORKSPACE_AI_SELECTIONS) {
      const policy = buildWorkspaceAiPolicy(selection, CURRENT_187_POLICY);
      for (const [path, value] of routingValues(policy)) {
        if (MODEL_SHAPED.test(value)) {
          throw new Error(`${path} looks like a model id: ${value}`);
        }
      }
    }
  });

  it('keeps the embedding provenance entry, which is why it is excepted by NAME', () => {
    // An exception that silently covered everything would be no fence at all.
    // This asserts the excepted value is really there, so the carve-out is load
    // bearing rather than a way to make the fence pass.
    const policy = buildWorkspaceAiPolicy('qwen', CURRENT_187_POLICY);
    expect(policy.taskOverrides?.embedding).toBe('text-embedding-004');
    expect(policy.providerOverrides?.embedding).toBe('google');
  });
});

describe('isWorkspaceAiSelection', () => {
  it('accepts every wire value and rejects everything else', () => {
    for (const v of WORKSPACE_AI_SELECTIONS) expect(isWorkspaceAiSelection(v)).toBe(true);
    expect(isWorkspaceAiSelection('mistral')).toBe(false);
    expect(isWorkspaceAiSelection('')).toBe(false);
    expect(isWorkspaceAiSelection(undefined)).toBe(false);
  });
});

describe('Frontier is a designation, not a route', () => {
  it('reaches no routing policy for any selection', () => {
    const frontierOnly = Object.values(WORKSPACE_AI_VENDORS)
      .map((spec) => spec.frontier)
      .filter((id): id is string => Boolean(id))
      // Astra is also OpenAI's large-tier model, so it is routed to AS large;
      // only a Frontier model that holds no tier must never appear.
      .filter((id) =>
        !Object.values(WORKSPACE_AI_VENDORS).some((spec) => Object.values(spec.tiers).includes(id)),
      );
    expect(frontierOnly).toEqual(['claude-fable-5-2']);
    for (const selection of WORKSPACE_AI_SELECTIONS) {
      const policy = JSON.stringify(buildWorkspaceAiPolicy(selection, CURRENT_187_POLICY));
      for (const id of frontierOnly) expect(policy).not.toContain(id);
    }
  });
});
