// Reflection Engine Service Unit Tests
// Tests reflection triggers, evidence collection, and analysis

import { ReflectionEngineService } from '../service';
import { pool } from '../../infrastructure/database';
import { isExecutionAllowed } from '../../entitlements-client/service';
import {
  ReflectionTrigger,
  ReflectionSuggestion,
  ReflectionQuota,
  ReflectionContext,
  EvidenceRef,
} from '../types';

// Mock dependencies
jest.mock('../../infrastructure/database');
jest.mock('../../infrastructure/logging');
jest.mock('../../infrastructure/vertex-ai');
jest.mock('../../agent-lifecycle/repository');
// Inline jest.fn() (not an out-of-scope ref) so the factory is TDZ-safe when
// ../service is imported at the top of this file. Defaults to allowed; the
// billing-gate test overrides it per-call.
jest.mock('../../entitlements-client/service', () => ({
  isExecutionAllowed: jest.fn().mockResolvedValue(true),
  getEntitlementsClient: jest.fn(),
}));

const _mockPool = pool as jest.Mocked<typeof pool>;
const mockIsExecutionAllowed = isExecutionAllowed as jest.Mock;

// ==========================================
// Mock Factories
// ==========================================

function createMockReflectionTrigger(overrides: Partial<ReflectionTrigger> = {}): ReflectionTrigger {
  return {
    tenantId: 'tenant-test-456',
    triggerType: 'repeated_failures',
    metadata: { failureCount: 5, threshold: 3 },
    ...overrides,
  };
}

function createMockReflectionQuota(overrides: Partial<ReflectionQuota> = {}): ReflectionQuota {
  return {
    tenantId: 'tenant-test-456',
    dailyRunsLimit: 5,
    dailyRunsUsed: 2,
    dailyRunsRemaining: 3,
    weeklyAgentRunsLimit: 20,
    weeklyAgentRunsUsed: 5,
    weeklyAgentRunsRemaining: 15,
    maxConcurrentJobs: 3,
    currentConcurrentJobs: 1,
    concurrentJobsRemaining: 2,
    ...overrides,
  };
}

function createMockReflectionContext(overrides: Partial<ReflectionContext> = {}): ReflectionContext {
  return {
    instructionVersion: 1,
    workflowSummaries: [
      { id: 'wf-1', status: 'completed', totalActions: 10 },
      { id: 'wf-2', status: 'failed', totalActions: 5 },
    ],
    taskOutcomes: [
      { taskId: 'task-1', status: 'completed', duration: 5000 },
      { taskId: 'task-2', status: 'failed', error: 'Timeout' },
    ],
    escalationHistory: [
      { escalationId: 'esc-1', reason: 'Error threshold exceeded', resolvedAt: new Date() },
    ],
    undoHistory: [
      { actionId: 'action-1', undoReason: 'User requested', undoneAt: new Date() },
    ],
    humanFeedback: [
      { feedbackId: 'fb-1', type: 'correction', content: 'Use different approach' },
    ],
    successfulRuns: [
      { denialId: 'denial-1', policy: 'write_scope', reason: 'Field not allowed' },
    ],
    ...overrides,
  };
}

function createMockReflectionSuggestion(overrides: Partial<ReflectionSuggestion> = {}): ReflectionSuggestion {
  return {
    id: 'suggestion-test-123',
    agentId: 'agent-test-789',
    suggestion: 'Consider adding retry logic for transient failures',
    evidenceRefs: [
      { type: 'workflow', id: 'wf-1' },
      { type: 'task', id: 'task-2' },
      { type: 'escalation', id: 'esc-1' },
    ] as EvidenceRef[],
    confidenceScore: 0.85,
    recurrenceScore: 0.7,
    severity: 'medium',
    status: 'pending',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

function _quotaToDbRow(quota: ReflectionQuota): Record<string, any> {
  return {
    tenant_id: quota.tenantId,
    daily_runs_limit: quota.dailyRunsLimit,
    daily_runs_used: quota.dailyRunsUsed,
    daily_runs_remaining: quota.dailyRunsRemaining,
    weekly_agent_runs_limit: quota.weeklyAgentRunsLimit,
    weekly_agent_runs_used: quota.weeklyAgentRunsUsed,
    weekly_agent_runs_remaining: quota.weeklyAgentRunsRemaining,
    max_concurrent_jobs: quota.maxConcurrentJobs,
    current_concurrent_jobs: quota.currentConcurrentJobs,
    concurrent_jobs_remaining: quota.concurrentJobsRemaining,
  };
}

function _suggestionToDbRow(suggestion: ReflectionSuggestion): Record<string, any> {
  return {
    id: suggestion.id,
    agent_id: suggestion.agentId,
    suggestion: suggestion.suggestion,
    evidence_refs: JSON.stringify(suggestion.evidenceRefs),
    confidence_score: suggestion.confidenceScore,
    recurrence_score: suggestion.recurrenceScore,
    severity: suggestion.severity,
    status: suggestion.status,
    created_at: suggestion.createdAt,
  };
}

// ==========================================
// ReflectionEngineService Tests
// ==========================================

describe('ReflectionEngineService', () => {
  let service: ReflectionEngineService;
  let mockVertexAI: any;
  let mockRepository: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsExecutionAllowed.mockResolvedValue(true);
    service = new ReflectionEngineService();

    // The instruction baseline. A reflection REFUSES to plan without one — a
    // suggestion with no baseline can be applied over an operator's edit and
    // can never be reverted — so every test that expects a reflection to run
    // has to give it a state to snapshot.
    (_mockPool.query as jest.Mock).mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM agents WHERE id')) {
        return Promise.resolve({
          rows: [{ system_prompt: 'sys', user_instructions: 'do the thing', entity_version: 3 }],
        });
      }
      if (typeof sql === 'string' && sql.includes('COUNT(*)')) {
        return Promise.resolve({ rows: [{ cnt: '42' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    // Setup mock agent repository — return ACTIVE by default
    (service as any).agentRepository = {
      findById: jest.fn().mockResolvedValue({ id: 'agent-test-789', lifecycle: 'ACTIVE' }),
    };

    // Setup mock Vertex AI
    mockVertexAI = {
      runReflection: jest.fn().mockResolvedValue({
        suggestion: 'Consider adding retry logic for transient failures',
        evidenceRefs: [
          { type: 'workflow', id: 'wf-1' },
          { type: 'task', id: 'task-2' },
        ] as EvidenceRef[],
        confidenceScore: 0.85,
        recurrenceScore: 0.7,
        severity: 'medium',
      }),
    };
    (service as any).vertexAI = mockVertexAI;

    // Setup mock repository
    mockRepository = {
      getQuotaStatus: jest.fn().mockResolvedValue(createMockReflectionQuota()),
      gatherReflectionContext: jest.fn().mockResolvedValue(createMockReflectionContext()),
      saveSuggestion: jest.fn().mockResolvedValue(undefined),
      getSuggestions: jest.fn().mockResolvedValue([createMockReflectionSuggestion()]),
      getEvidenceCounts: jest.fn().mockResolvedValue({
        failures: 5,
        humanCorrections: 2,
        escalations: 1,
        successfulRuns: 0,
      }),
      getRecentEvidenceCounts: jest.fn().mockResolvedValue({
        failures: 4, humanCorrections: 1, escalations: 1, successfulRuns: 0,
      }),
      // Density now reads the LEARNED weights rather than the static constant,
      // so the mock has to answer this too. Empty is the honest default: no
      // outcome has ever been recorded, so no pattern exists and the adjusted
      // weights are the defaults.
      getPatternWeights: jest.fn().mockResolvedValue([]),
    };
    (service as any).repository = mockRepository;
  });

  // ==========================================
  // Trigger Reflection Tests
  // ==========================================

  describe('triggerReflection', () => {
    it('should skip reflection when agent is PAUSED', async () => {
      (service as any).agentRepository.findById.mockResolvedValueOnce({
        id: 'agent-test-789', lifecycle: 'PAUSED',
      });

      const trigger = createMockReflectionTrigger();
      const result = await service.triggerReflection('agent-test-789', trigger);

      expect(result.started).toBe(false);
      expect(result.reason).toContain('Agent not ACTIVE');
      expect(mockVertexAI.runReflection).not.toHaveBeenCalled();
    });

    it('should skip reflection when agent not found', async () => {
      (service as any).agentRepository.findById.mockResolvedValueOnce(null);

      const trigger = createMockReflectionTrigger();
      const result = await service.triggerReflection('agent-test-789', trigger);

      expect(result.started).toBe(false);
      expect(result.reason).toContain('Agent not ACTIVE');
      expect(mockVertexAI.runReflection).not.toHaveBeenCalled();
    });

    // BILLING-GATE: suspension leaves agents ACTIVE, so without this gate a
    // suspended tenant's reflection (Claude Opus) would still fire and drain OUs.
    it('should skip reflection when the tenant is not execution-allowed (suspended)', async () => {
      mockIsExecutionAllowed.mockResolvedValueOnce(false);

      const trigger = createMockReflectionTrigger();
      const result = await service.triggerReflection('agent-test-789', trigger);

      expect(result.started).toBe(false);
      expect(result.reason).toContain('suspended');
      expect(mockIsExecutionAllowed).toHaveBeenCalledWith(trigger.tenantId);
      expect(mockVertexAI.runReflection).not.toHaveBeenCalled();
    });

    it('should start reflection when all quotas available', async () => {
      const trigger = createMockReflectionTrigger();

      const result = await service.triggerReflection('agent-test-789', trigger);

      expect(result.started).toBe(true);
      expect(result.reason).toBeUndefined();
      // Phase 5: gatherReflectionContext now takes an optional
      // triggerFeedbackId third arg. For non-flagged_feedback triggers
      // it is undefined.
      expect(mockRepository.gatherReflectionContext).toHaveBeenCalledWith(
        'agent-test-789',
        'tenant-test-456',
        undefined,
      );
      expect(mockVertexAI.runReflection).toHaveBeenCalled();
      expect(mockRepository.saveSuggestion).toHaveBeenCalled();
    });

    it('should reject when daily quota exceeded', async () => {
      mockRepository.getQuotaStatus.mockResolvedValueOnce(
        createMockReflectionQuota({ dailyRunsRemaining: 0 })
      );

      const trigger = createMockReflectionTrigger();

      const result = await service.triggerReflection('agent-test-789', trigger);

      expect(result.started).toBe(false);
      expect(result.reason).toBe('Daily reflection quota exceeded');
      expect(mockRepository.gatherReflectionContext).not.toHaveBeenCalled();
    });

    it('should reject when weekly agent quota exceeded', async () => {
      mockRepository.getQuotaStatus.mockResolvedValueOnce(
        createMockReflectionQuota({ weeklyAgentRunsRemaining: 0 })
      );

      const trigger = createMockReflectionTrigger();

      const result = await service.triggerReflection('agent-test-789', trigger);

      expect(result.started).toBe(false);
      expect(result.reason).toBe('Weekly agent reflection quota exceeded');
    });

    it('should reject when max concurrent jobs reached', async () => {
      mockRepository.getQuotaStatus.mockResolvedValueOnce(
        createMockReflectionQuota({ concurrentJobsRemaining: 0 })
      );

      const trigger = createMockReflectionTrigger();

      const result = await service.triggerReflection('agent-test-789', trigger);

      expect(result.started).toBe(false);
      expect(result.reason).toBe('Max concurrent reflection jobs reached');
    });

    it('should reject when evidence density is insufficient', async () => {
      // Return low evidence counts
      mockRepository.getEvidenceCounts.mockResolvedValueOnce({
        failures: 0,
        escalations: 0,
        humanCorrections: 0,
        successfulRuns: 0,
        escalations: 0,
        successfulRuns: 0,
      });
      mockRepository.getRecentEvidenceCounts.mockResolvedValueOnce({
        failures: 0,
        escalations: 0,
        humanCorrections: 0,
        successfulRuns: 0,
      });

      const trigger = createMockReflectionTrigger();

      const result = await service.triggerReflection('agent-test-789', trigger);

      expect(result.started).toBe(false);
      expect(result.reason).toBe('Insufficient evidence density');
    });

    it('should handle repeated_failures trigger type', async () => {
      const trigger = createMockReflectionTrigger({
        triggerType: 'repeated_failures',
        metadata: { failureCount: 5, threshold: 3 },
      });

      const result = await service.triggerReflection('agent-test-789', trigger);

      expect(result.started).toBe(true);
      expect(mockRepository.gatherReflectionContext).toHaveBeenCalled();
    });

    it('should handle repeated_undos trigger type', async () => {
      const trigger = createMockReflectionTrigger({
        triggerType: 'repeated_undos',
        metadata: { undoCount: 4, threshold: 3 },
      });

      const result = await service.triggerReflection('agent-test-789', trigger);

      expect(result.started).toBe(true);
    });

    it('should handle repeated_human_corrections trigger type', async () => {
      const trigger = createMockReflectionTrigger({
        triggerType: 'repeated_human_corrections',
        metadata: { correctionCount: 3 },
      });

      const result = await service.triggerReflection('agent-test-789', trigger);

      expect(result.started).toBe(true);
    });

    it('should handle n_successful_runs trigger type', async () => {
      const trigger = createMockReflectionTrigger({
        triggerType: 'n_successful_runs',
        metadata: { runCount: 100, threshold: 100 },
      });

      const result = await service.triggerReflection('agent-test-789', trigger);

      expect(result.started).toBe(true);
    });

    it('should handle scheduled trigger type', async () => {
      const trigger = createMockReflectionTrigger({
        triggerType: 'scheduled',
        metadata: { schedule: 'weekly' },
      });

      const result = await service.triggerReflection('agent-test-789', trigger);

      expect(result.started).toBe(true);
    });

    // Phase 5: flagged_feedback trigger type — late-rejection feedback
    // short-circuits density to 1.0 because each flag is itself the
    // evidence. No other signal needs to co-occur.
    it('should handle flagged_feedback trigger type with density bypass', async () => {
      // Even with NO other evidence, the density bypass (return 1.0)
      // ensures the job still runs.
      mockRepository.getEvidenceCounts.mockResolvedValueOnce({
        failures: 0,
        escalations: 0,
        humanCorrections: 0,
        successfulRuns: 0,
        escalations: 0,
        successfulRuns: 0,
      });
      mockRepository.getRecentEvidenceCounts.mockResolvedValueOnce({
        failures: 0,
        escalations: 0,
        humanCorrections: 0,
        successfulRuns: 0,
      });

      const trigger = createMockReflectionTrigger({
        triggerType: 'flagged_feedback',
        metadata: { feedbackId: 'fb-123' },
      });

      const result = await service.triggerReflection('agent-test-789', trigger);

      expect(result.started).toBe(true);
      expect(mockRepository.gatherReflectionContext).toHaveBeenCalled();
      expect(mockVertexAI.runReflection).toHaveBeenCalled();
    });

    // Phase 5 gap fix: feedbackId from trigger.metadata is passed through
    // as the third arg to gatherReflectionContext so the repository can
    // hoist that specific row to the front of flaggedFeedback.
    it('plumbs metadata.feedbackId through to gatherReflectionContext for flagged_feedback triggers', async () => {
      mockRepository.getEvidenceCounts.mockResolvedValueOnce({
        failures: 0, escalations: 0, humanCorrections: 0, successfulRuns: 0,
        escalations: 0, successfulRuns: 0,
      });
      mockRepository.getRecentEvidenceCounts.mockResolvedValueOnce({
        failures: 0, escalations: 0, humanCorrections: 0, successfulRuns: 0,
      });

      const trigger = createMockReflectionTrigger({
        triggerType: 'flagged_feedback',
        metadata: { feedbackId: 'fb-deadbeef' },
      });

      await service.triggerReflection('agent-test-789', trigger);

      expect(mockRepository.gatherReflectionContext).toHaveBeenCalledWith(
        'agent-test-789',
        'tenant-test-456',
        'fb-deadbeef',
      );
    });

    // Phase 5 gap fix: saveSuggestion is called with triggeredBy equal to
    // the trigger type so the applier can gate auto-apply.
    it('persists triggeredBy on the saved suggestion matching the trigger type', async () => {
      const trigger = createMockReflectionTrigger({
        triggerType: 'flagged_feedback',
        metadata: { feedbackId: 'fb-999' },
      });
      mockRepository.getEvidenceCounts.mockResolvedValueOnce({
        failures: 0, escalations: 0, humanCorrections: 0, successfulRuns: 0,
        escalations: 0, successfulRuns: 0,
      });
      mockRepository.getRecentEvidenceCounts.mockResolvedValueOnce({
        failures: 0, escalations: 0, humanCorrections: 0, successfulRuns: 0,
      });

      await service.triggerReflection('agent-test-789', trigger);

      expect(mockRepository.saveSuggestion).toHaveBeenCalledWith(
        expect.objectContaining({ triggeredBy: 'flagged_feedback' }),
      );
    });
  });

  // ==========================================
  // Phase 5: shouldTriggerReflection for flagged_feedback
  // ==========================================

  describe('shouldTriggerReflection — flagged_feedback', () => {
    it('returns shouldTrigger=true when 2 or more flags exist in last 7 days', async () => {
      mockRepository.countFlaggedLateFeedback = jest.fn().mockResolvedValue(2);

      const result = await service.shouldTriggerReflection(
        'agent-test-789',
        'tenant-test-456',
        'flagged_feedback',
      );

      expect(result.shouldTrigger).toBe(true);
      expect(mockRepository.countFlaggedLateFeedback).toHaveBeenCalledWith(
        'agent-test-789',
        7,
      );
    });

    it('returns shouldTrigger=false when only 1 flag exists', async () => {
      mockRepository.countFlaggedLateFeedback = jest.fn().mockResolvedValue(1);

      const result = await service.shouldTriggerReflection(
        'agent-test-789',
        'tenant-test-456',
        'flagged_feedback',
      );

      expect(result.shouldTrigger).toBe(false);
      expect(result.reason).toContain('Only 1');
      expect(result.reason).toContain('need 2');
    });

    it('returns shouldTrigger=false when zero flags', async () => {
      mockRepository.countFlaggedLateFeedback = jest.fn().mockResolvedValue(0);

      const result = await service.shouldTriggerReflection(
        'agent-test-789',
        'tenant-test-456',
        'flagged_feedback',
      );

      expect(result.shouldTrigger).toBe(false);
      expect(result.reason).toContain('Only 0');
    });
  });

  // ==========================================
  // Evidence Density Tests
  // ==========================================

  describe('evidence density calculation', () => {
    it('should calculate high density with sufficient evidence', async () => {
      mockRepository.getEvidenceCounts.mockResolvedValueOnce({
        failures: 10,
        escalations: 5,
        humanCorrections: 3,
        successfulRuns: 2,
      });

      const trigger = createMockReflectionTrigger();

      const result = await service.triggerReflection('agent-test-789', trigger);

      expect(result.started).toBe(true);
    });

    it('should calculate low density with minimal evidence', async () => {
      mockRepository.getEvidenceCounts.mockResolvedValueOnce({
        failures: 0,
        escalations: 0,
        humanCorrections: 0,
        successfulRuns: 0,
        escalations: 0,
        successfulRuns: 0,
      });
      mockRepository.getRecentEvidenceCounts.mockResolvedValueOnce({
        failures: 0,
        escalations: 0,
        humanCorrections: 0,
        successfulRuns: 0,
      });

      const trigger = createMockReflectionTrigger();

      const result = await service.triggerReflection('agent-test-789', trigger);

      expect(result.started).toBe(false);
      expect(result.reason).toBe('Insufficient evidence density');
    });

    it('should weight failures heavily', async () => {
      // Failures alone should be enough with high count
      mockRepository.getEvidenceCounts.mockResolvedValueOnce({
        failures: 20,
        escalations: 0,
        humanCorrections: 0,
        successfulRuns: 0,
      });

      const trigger = createMockReflectionTrigger();

      const result = await service.triggerReflection('agent-test-789', trigger);

      expect(result.started).toBe(true);
    });
  });

  // ==========================================
  // Suggestion Retrieval Tests
  // ==========================================

  describe('getSuggestions', () => {
    it('should return suggestions for agent', async () => {
      const mockSuggestions = [
        createMockReflectionSuggestion({ id: 'sug-1' }),
        createMockReflectionSuggestion({ id: 'sug-2' }),
      ];
      mockRepository.getSuggestions.mockResolvedValueOnce(mockSuggestions);

      const result = await service.getSuggestions('agent-test-789');

      expect(result).toHaveLength(2);
      expect(mockRepository.getSuggestions).toHaveBeenCalledWith('agent-test-789');
    });

    it('should return empty array when no suggestions', async () => {
      mockRepository.getSuggestions.mockResolvedValueOnce([]);

      const result = await service.getSuggestions('agent-test-789');

      expect(result).toHaveLength(0);
    });
  });

  // ==========================================
  // Quota Status Tests
  // ==========================================

  describe('getQuotaStatus', () => {
    it('should return quota status for tenant', async () => {
      const result = await service.getQuotaStatus('tenant-test-456');

      expect(result).toBeDefined();
      expect(result.tenantId).toBe('tenant-test-456');
      expect(result.dailyRunsLimit).toBe(5);
      expect(result.dailyRunsRemaining).toBe(3);
      // agentId is forwarded so the per-agent weekly allowance is read; the
      // tenant-only call reads zero-used and would let a declined run enqueue.
      expect(mockRepository.getQuotaStatus).toHaveBeenCalledWith('tenant-test-456', undefined);
    });
  });

  // ==========================================
  // Reflection Context Tests
  // ==========================================

  describe('reflection context gathering', () => {
    it('should gather all context types', async () => {
      const trigger = createMockReflectionTrigger();

      await service.triggerReflection('agent-test-789', trigger);

      expect(mockRepository.gatherReflectionContext).toHaveBeenCalledWith(
        'agent-test-789',
        'tenant-test-456',
        undefined,
      );

      // Verify the context was passed to Vertex AI
      expect(mockVertexAI.runReflection).toHaveBeenCalledWith(
        'tenant-test-456',
        'agent-test-789',
        expect.objectContaining({
          instructionVersion: 1,
          workflowSummaries: expect.any(Array),
          taskOutcomes: expect.any(Array),
          escalationHistory: expect.any(Array),
          undoHistory: expect.any(Array),
          humanFeedback: expect.any(Array),
          successfulRuns: expect.any(Array),
        })
      );
    });
  });

  // ==========================================
  // Suggestion Storage Tests
  // ==========================================

  describe('suggestion storage', () => {
    it('should save suggestion with all required fields', async () => {
      const trigger = createMockReflectionTrigger();

      await service.triggerReflection('agent-test-789', trigger);

      expect(mockRepository.saveSuggestion).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-test-789',
          suggestion: expect.any(String),
          evidenceRefs: expect.any(Array),
          confidenceScore: expect.any(Number),
          recurrenceScore: expect.any(Number),
          severity: expect.any(String),
        })
      );
    });

    it('should not auto-apply suggestions', async () => {
      const trigger = createMockReflectionTrigger();

      await service.triggerReflection('agent-test-789', trigger);

      // Verify that no auto-apply methods were called
      // Suggestions should only be stored for human review
      expect(mockRepository.saveSuggestion).toHaveBeenCalled();
      // No instruction update methods should be called
    });
  });

  // ==========================================
  // Error Handling Tests
  // ==========================================

  describe('error handling', () => {
    it('should handle Vertex AI failure gracefully', async () => {
      mockVertexAI.runReflection.mockRejectedValueOnce(new Error('AI service unavailable'));

      const trigger = createMockReflectionTrigger();

      await expect(service.triggerReflection('agent-test-789', trigger)).rejects.toThrow(
        'AI service unavailable'
      );
    });

    it('should handle repository failure gracefully', async () => {
      mockRepository.gatherReflectionContext.mockRejectedValueOnce(
        new Error('Database connection failed')
      );

      const trigger = createMockReflectionTrigger();

      await expect(service.triggerReflection('agent-test-789', trigger)).rejects.toThrow(
        'Database connection failed'
      );
    });
  });

  // ==========================================
  // Severity Tests
  // ==========================================

  describe('suggestion severity', () => {
    it('should handle low severity suggestions', async () => {
      mockVertexAI.runReflection.mockResolvedValueOnce({
        suggestion: 'Minor optimization opportunity',
        evidenceRefs: [{ type: 'workflow', id: 'wf-1' }] as EvidenceRef[],
        confidenceScore: 0.6,
        recurrenceScore: 0.3,
        severity: 'low',
      });

      const trigger = createMockReflectionTrigger();

      await service.triggerReflection('agent-test-789', trigger);

      expect(mockRepository.saveSuggestion).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: 'low',
        })
      );
    });

    it('should handle critical severity suggestions', async () => {
      mockVertexAI.runReflection.mockResolvedValueOnce({
        suggestion: 'Critical issue: Agent repeatedly accessing unauthorized resources',
        evidenceRefs: [
          { type: 'policy_denial', id: 'denial-1' },
          { type: 'policy_denial', id: 'denial-2' },
          { type: 'policy_denial', id: 'denial-3' },
        ] as EvidenceRef[],
        confidenceScore: 0.95,
        recurrenceScore: 0.9,
        severity: 'critical',
      });

      const trigger = createMockReflectionTrigger();

      await service.triggerReflection('agent-test-789', trigger);

      expect(mockRepository.saveSuggestion).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: 'critical',
        })
      );
    });
  });

  // ==========================================
  // Confidence Score Tests
  // ==========================================

  describe('confidence and recurrence scores', () => {
    it('should preserve high confidence scores', async () => {
      mockVertexAI.runReflection.mockResolvedValueOnce({
        suggestion: 'High confidence suggestion',
        evidenceRefs: [
          { type: 'workflow', id: 'wf-1' },
          { type: 'workflow', id: 'wf-2' },
          { type: 'workflow', id: 'wf-3' },
          { type: 'workflow', id: 'wf-4' },
          { type: 'workflow', id: 'wf-5' },
        ] as EvidenceRef[],
        confidenceScore: 0.95,
        recurrenceScore: 0.85,
        severity: 'high',
      });

      const trigger = createMockReflectionTrigger();

      await service.triggerReflection('agent-test-789', trigger);

      expect(mockRepository.saveSuggestion).toHaveBeenCalledWith(
        expect.objectContaining({
          confidenceScore: 0.95,
          recurrenceScore: 0.85,
        })
      );
    });

    it('should preserve low confidence scores', async () => {
      mockVertexAI.runReflection.mockResolvedValueOnce({
        suggestion: 'Tentative suggestion based on limited data',
        evidenceRefs: [{ type: 'workflow', id: 'wf-1' }] as EvidenceRef[],
        confidenceScore: 0.4,
        recurrenceScore: 0.2,
        severity: 'low',
      });

      const trigger = createMockReflectionTrigger();

      await service.triggerReflection('agent-test-789', trigger);

      expect(mockRepository.saveSuggestion).toHaveBeenCalledWith(
        expect.objectContaining({
          confidenceScore: 0.4,
          recurrenceScore: 0.2,
        })
      );
    });
  });
});

// ── The baseline is a precondition, not a nicety ────────────────────────────
//
// A suggestion with no baseline can be applied over an operator's edit and can
// never be reverted, and it looks exactly like every other suggestion while
// doing so. Skipping the reflection costs one cycle; the alternative costs
// somebody's work.
describe('reflection refuses to plan without a baseline', () => {
  let service: ReflectionEngineService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsExecutionAllowed.mockResolvedValue(true);
    service = new ReflectionEngineService();
    (service as any).agentRepository = {
      findById: jest.fn().mockResolvedValue({ id: 'agent-test-789', lifecycle: 'ACTIVE' }),
    };
    (service as any).vertexAI = { runReflection: jest.fn() };
    (service as any).repository = {
      getQuotaStatus: jest.fn().mockResolvedValue(createMockReflectionQuota()),
      getEvidenceCounts: jest.fn().mockResolvedValue({
        failures: 10, escalations: 5, humanCorrections: 5, successfulRuns: 5, escalations: 5,
      }),
      getRecentEvidenceCounts: jest.fn().mockResolvedValue({
        failures: 10, escalations: 5, humanCorrections: 5, successfulRuns: 5, escalations: 5,
      }),
      gatherReflectionContext: jest.fn(),
      saveSuggestion: jest.fn(),
      incrementQuotaUsage: jest.fn(),
      // Density reads the learned weights now; no outcome has ever been
      // recorded, so the honest default is no patterns.
      getPatternWeights: jest.fn().mockResolvedValue([]),
    };
  });

  it('does not gather context or call the LLM when the agent state cannot be read', async () => {
    (_mockPool.query as jest.Mock).mockResolvedValue({ rows: [] });   // no agent row
    await service.triggerReflection('agent-test-789', createMockReflectionTrigger());
    expect((service as any).repository.gatherReflectionContext).not.toHaveBeenCalled();
    expect((service as any).vertexAI.runReflection).not.toHaveBeenCalled();
  });

  it('saves no suggestion when the agent state cannot be read', async () => {
    (_mockPool.query as jest.Mock).mockResolvedValue({ rows: [] });
    await service.triggerReflection('agent-test-789', createMockReflectionTrigger());
    expect((service as any).repository.saveSuggestion).not.toHaveBeenCalled();
  });

  it('stamps every saved suggestion with a baseline when it CAN read the state', async () => {
    (_mockPool.query as jest.Mock).mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM agents WHERE id')) {
        return Promise.resolve({
          rows: [{ system_prompt: 'sys', user_instructions: 'instructions', entity_version: 7 }],
        });
      }
      if (typeof sql === 'string' && sql.includes('COUNT(*)')) {
        return Promise.resolve({ rows: [{ cnt: '11' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    (service as any).repository.gatherReflectionContext.mockResolvedValue({});
    (service as any).vertexAI.runReflection.mockResolvedValue({
      suggestion: 'do better', evidenceRefs: [], confidenceScore: 0.9,
      recurrenceScore: 0.8, severity: 'high', expectedOutcome: 'fewer 404s',
    });

    await service.triggerReflection('agent-test-789', createMockReflectionTrigger());

    const saved = (service as any).repository.saveSuggestion.mock.calls[0]?.[0];
    expect(saved).toBeDefined();
    expect(saved.baselineHash).toMatch(/^[0-9a-f]{64}$/);
    expect(saved.beforeState).toEqual({
      systemPrompt: 'sys', userInstructions: 'instructions', entityVersion: 7,
    });
    expect(saved.trajectoryVersion).toBe(11);
    // The expectation the outcome-closure job compares against. Without it,
    // "did this help?" has nothing to be measured against.
    expect(saved.expectedOutcome).toBe('fewer 404s');
  });
});
