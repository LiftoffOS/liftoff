// Unit tests for the reconciler's drift classification (plan §6.6).
// Exercises classifyDrift in isolation so the full reconciler flow doesn't
// need to be booted to verify the matrix.

import { classifyDrift } from '../reconciler';
import type { InternalAgentRow } from '../row-mapper';

function makeAgent(overrides: Partial<InternalAgentRow>): InternalAgentRow {
  return {
    id: 'agent-1',
    tenantId: 'tenant-1',
    role: 'reviewer',
    responsibilities: null,
    integrations: [],
    pendingIntegrations: [],
    additionalContext: null,
    summary: null,
    systemPrompt: null,
    userInstructions: null,
    instructionsMd: null,
    instructions: null,
    temperature: 0.3,
    status: 'active',
    currentVersion: 1,
    tasksCompleted: 0,
    tasks30d: 0,
    monthlyCost: 0,
    lastActive: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    agentType: 'agent',
    modelConfig: {},
    memoryScope: { readableLayers: ['individual'], writableLayers: ['individual'] },
    execConfig: {},
    workflowSteps: null,
    triggerConfig: null,
    delegates: [],
    workforcePlanId: null,
    reviewedAt: null,
    reviewedBy: null,
    workflowStepsHash: null,
    messagingNickname: null,
    lastActivity: null,
    lastActivityAction: null,
    workflowVisualizationSteps: null,
    autonomyOverride: null,
    skills: [],
    capabilityTier: 'connector_only',
    pinnedKnowledgeIds: [],
    deletedAt: null,
    ...overrides,
  };
}

describe('classifyDrift', () => {
  it('returns missing_create when PB has agent (not deleted) and runtime has no mapping', () => {
    const agent = makeAgent({ currentVersion: 5, deletedAt: null });
    expect(classifyDrift(agent, { hasMapping: false })).toBe('missing_create');
  });

  it('returns null when PB is soft-deleted and runtime has no mapping (consistent)', () => {
    const agent = makeAgent({ deletedAt: new Date() });
    expect(classifyDrift(agent, { hasMapping: false })).toBeNull();
  });

  it('returns missed_delete when PB is soft-deleted but runtime cachedStatus is active', () => {
    const agent = makeAgent({ deletedAt: new Date(), currentVersion: 5 });
    expect(classifyDrift(agent, {
      hasMapping: true,
      hasActiveInstruction: true,
      cachedEntityVersion: 5,
      cachedStatus: 'active',
    })).toBe('missed_delete');
  });

  it('returns null when PB is soft-deleted and runtime cachedStatus is already deleted', () => {
    const agent = makeAgent({ deletedAt: new Date(), currentVersion: 5 });
    expect(classifyDrift(agent, {
      hasMapping: true,
      hasActiveInstruction: true,
      cachedEntityVersion: 5,
      cachedStatus: 'deleted',
    })).toBeNull();
  });

  it('returns missing_instruction when mapping exists but hasActiveInstruction is false', () => {
    const agent = makeAgent({ currentVersion: 5 });
    expect(classifyDrift(agent, {
      hasMapping: true,
      hasActiveInstruction: false,
      cachedEntityVersion: 5,
      cachedStatus: 'active',
    })).toBe('missing_instruction');
  });

  it('missing_instruction takes precedence over stale_update', () => {
    const agent = makeAgent({ currentVersion: 5 });
    expect(classifyDrift(agent, {
      hasMapping: true,
      hasActiveInstruction: false,
      cachedEntityVersion: 3,
      cachedStatus: 'active',
    })).toBe('missing_instruction');
  });

  it('returns stale_update when cachedEntityVersion < currentVersion', () => {
    const agent = makeAgent({ currentVersion: 5 });
    expect(classifyDrift(agent, {
      hasMapping: true,
      hasActiveInstruction: true,
      cachedEntityVersion: 3,
      cachedStatus: 'active',
    })).toBe('stale_update');
  });

  it('returns null when in sync (versions match, instruction active)', () => {
    const agent = makeAgent({ currentVersion: 5 });
    expect(classifyDrift(agent, {
      hasMapping: true,
      hasActiveInstruction: true,
      cachedEntityVersion: 5,
      cachedStatus: 'active',
    })).toBeNull();
  });

  it('treats missing cachedEntityVersion as -1 (so any positive currentVersion triggers stale_update)', () => {
    const agent = makeAgent({ currentVersion: 1 });
    expect(classifyDrift(agent, {
      hasMapping: true,
      hasActiveInstruction: true,
      cachedEntityVersion: null,
      cachedStatus: 'active',
    })).toBe('stale_update');
  });

  // ── stale_content drift ─────────────────────────────────────────────
  // Fires when entity_version is current but a behavior-affecting field
  // diverged from PB. The canonical case is a v22 update event being
  // applied by a subscriber that did not yet carry trigger_config
  // in handleInternalAgentUpdated. event_versions advanced past v22, no
  // later redistill produced a diff, so neither the version gate nor the
  // outbox naturally re-fires — agents.trigger_config is permanently
  // stuck. classifyDrift's hash compare catches this.

  const okHashes = {
    triggerConfigHash: 'a'.repeat(64),
    instructionsHash: 'b'.repeat(64),
    capabilityTier: 'connector_only' as const,
  };

  it('returns stale_content when versions match but triggerConfigHash differs', () => {
    const agent = makeAgent({ currentVersion: 5 });
    expect(classifyDrift(agent, {
      hasMapping: true,
      hasActiveInstruction: true,
      cachedEntityVersion: 5,
      cachedStatus: 'active',
      triggerConfigHash: 'X'.repeat(64),
      instructionsHash: okHashes.instructionsHash,
      capabilityTier: 'connector_only',
    }, okHashes)).toBe('stale_content');
  });

  it('returns stale_content when versions match but instructionsHash differs', () => {
    const agent = makeAgent({ currentVersion: 5 });
    expect(classifyDrift(agent, {
      hasMapping: true,
      hasActiveInstruction: true,
      cachedEntityVersion: 5,
      cachedStatus: 'active',
      triggerConfigHash: okHashes.triggerConfigHash,
      instructionsHash: 'X'.repeat(64),
      capabilityTier: 'connector_only',
    }, okHashes)).toBe('stale_content');
  });

  it('returns stale_content when versions match but capabilityTier differs', () => {
    const agent = makeAgent({ currentVersion: 5 });
    expect(classifyDrift(agent, {
      hasMapping: true,
      hasActiveInstruction: true,
      cachedEntityVersion: 5,
      cachedStatus: 'active',
      triggerConfigHash: okHashes.triggerConfigHash,
      instructionsHash: okHashes.instructionsHash,
      capabilityTier: 'execution_enabled',
    }, okHashes)).toBe('stale_content');
  });

  it('returns null when all hashes match (no drift, in-sync)', () => {
    const agent = makeAgent({ currentVersion: 5 });
    expect(classifyDrift(agent, {
      hasMapping: true,
      hasActiveInstruction: true,
      cachedEntityVersion: 5,
      cachedStatus: 'active',
      triggerConfigHash: okHashes.triggerConfigHash,
      instructionsHash: okHashes.instructionsHash,
      capabilityTier: 'connector_only',
    }, okHashes)).toBeNull();
  });

  it('skips stale_content check when runtime omits hashes (older TR build before deploy)', () => {
    // Degrades safely: if the runtime sync-state route hasn't been redeployed
    // with the hash fields, the reconciler still does version-based drift
    // detection but doesn't false-positive on the missing hashes.
    const agent = makeAgent({ currentVersion: 5 });
    expect(classifyDrift(agent, {
      hasMapping: true,
      hasActiveInstruction: true,
      cachedEntityVersion: 5,
      cachedStatus: 'active',
      // no triggerConfigHash, no instructionsHash, no capabilityTier
    }, okHashes)).toBeNull();
  });

  it('skips stale_content check when PB hashes were not computed (compute failure fallback)', () => {
    const agent = makeAgent({ currentVersion: 5 });
    expect(classifyDrift(agent, {
      hasMapping: true,
      hasActiveInstruction: true,
      cachedEntityVersion: 5,
      cachedStatus: 'active',
      triggerConfigHash: 'X'.repeat(64),
      instructionsHash: 'Y'.repeat(64),
      capabilityTier: 'connector_only',
    } /* no pbHashes */)).toBeNull();
  });

  it('stale_update takes precedence over stale_content (version drift > content drift)', () => {
    const agent = makeAgent({ currentVersion: 5 });
    // Both version AND content drift; version is the more reliable signal so
    // we route through the existing stale_update repair path first.
    expect(classifyDrift(agent, {
      hasMapping: true,
      hasActiveInstruction: true,
      cachedEntityVersion: 3,
      cachedStatus: 'active',
      triggerConfigHash: 'X'.repeat(64),
      instructionsHash: 'Y'.repeat(64),
      capabilityTier: 'execution_enabled',
    }, okHashes)).toBe('stale_update');
  });

  it('catches a v22 trigger drift (event-config in PB, cron-config hash in TR)', () => {
    // PB has the event-based trigger_config; TR's
    // agents.trigger_config is a stale cron. Versions
    // match (22 == 22), instruction is active — nothing in version-only
    // drift detection sees the problem. The hash compare must catch it.
    const pbHashes = {
      triggerConfigHash: 'pb-event-hash-' + 'a'.repeat(50),
      instructionsHash: okHashes.instructionsHash,
      capabilityTier: 'connector_only' as const,
    };
    const driftedAgent = makeAgent({
      id: 'e8af341f-4d82-43c8-ba7b-6ca64bc8d983',
      currentVersion: 22,
    });
    expect(classifyDrift(driftedAgent, {
      hasMapping: true,
      hasActiveInstruction: true,
      cachedEntityVersion: 22,
      cachedStatus: 'active',
      triggerConfigHash: 'tr-cron-hash-' + 'b'.repeat(51),
      instructionsHash: okHashes.instructionsHash,
      capabilityTier: 'connector_only',
    }, pbHashes)).toBe('stale_content');
  });
});
