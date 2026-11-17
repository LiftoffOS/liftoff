// HITL Enforcement Service
// Per implementation plan: Phase 1.6 Tenant Runtime HITL Enforcement

import crypto from 'crypto';
import { pool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { insertAuditLog } from '../audit/service';
import {
  publishCorrectionCaptured,
  publishLateFeedbackFlagged,
} from '../events/publisher';
import { reflectionTriggerService } from '../reflection-engine/trigger-service';
import {
  ToolCallRequest,
  ModelTool,
  HitlApprovalRequest,
  HitlApprovalPolicy,
  ApprovalStatus,
  OversightSettings,
  GateResult,
  CreateApprovalInput,
  ResolveApprovalInput,
  SUPER_DESTRUCTIVE_OPERATIONS,
} from './types';
// Pure risk taxonomy (matcher + name-sets) shared with the per-action Authorize
// path — see ./risk-classes for why it is not defined in this DB-backed module.
import { toolActionMatchesNameSet, MERGE_TO_MAIN_TOOL_NAMES } from './risk-classes';

// [SE-001] Rate limit for autonomous operations (Level 5 and Level 4 auto-elevated)
const AUTONOMOUS_HOURLY_LIMIT = 1000;

export class HitlEnforcementService {
  // [SE-001] Get count of recent autonomous operations for rate limiting
  // Counts both Level 5 and Level 4 auto-elevated operations
  async getRecentOperationCount(tenantId: string, window: string): Promise<number> {
    // Parse window (e.g., '1h' -> 1 hour) and calculate cutoff timestamp
    const match = window.match(/^(\d+)([hms])$/);
    if (!match) {
      return 0;
    }

    const [, value, unit] = match;
    const multipliers: Record<string, number> = { h: 3600000, m: 60000, s: 1000 };
    const windowMs = parseInt(value, 10) * multipliers[unit];
    const cutoffTime = new Date(Date.now() - windowMs);

    const result = await pool.query(
      `SELECT COUNT(*) as count FROM hitl_rate_limit_events
       WHERE tenant_id = $1
         AND created_at > $2`,
      [tenantId, cutoffTime]
    );

    return parseInt(result.rows[0]?.count || '0', 10);
  }

  private async recordRateLimitEvent(params: {
    tenantId: string;
    hitlLevel: 4 | 5;
    toolName: string;
    autoElevated: boolean;
  }): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO hitl_rate_limit_events
           (tenant_id, hitl_level, tool_name, auto_elevated)
         VALUES ($1, $2, $3, $4)`,
        [params.tenantId, params.hitlLevel, params.toolName, params.autoElevated]
      );
    } catch (err) {
      log.warn(
        {
          tenantId: params.tenantId,
          toolName: params.toolName,
          hitlLevel: params.hitlLevel,
          err: (err as Error).message,
        },
        'Non-fatal: failed to record HITL rate-limit event'
      );
    }
  }

  // Check if a tool is low-risk (safe for auto-elevation to Level 5 behavior)
  // Low-risk = explicitly classified with no sensitive categories and not destructive
  private isLowRiskTool(tool: ModelTool | undefined): boolean {
    if (!tool) return false; // Unknown tool - treat as higher risk
    if (tool.categories === undefined) return false; // Not classified - treat as higher risk
    if (tool.categories.length > 0) return false; // Has sensitive categories
    if (tool.description?.includes('⚠️ DESTRUCTIVE')) return false; // Destructive marker
    return true;
  }

  // Per implementation plan: Check HITL gate - returns GateResult
  // Parameter order: (toolCalls, oversight, hitlLevel, tools, tenantId, options?)
  // [SE-001, SE-002] Made async to support Level 5 rate limiting and audit logging
  async checkHitlGate(
    toolCalls: ToolCallRequest[],
    oversight: OversightSettings | undefined,
    hitlLevel: number,
    tools: ModelTool[],
    tenantId: string,
    options?: { dryRun?: boolean; trustLevel?: 'trusted' | 'untrusted_inbound' }
  ): Promise<GateResult> {

    // 0. Empty tool calls - nothing to gate
    if (toolCalls.length === 0) {
      return { shouldGate: false };
    }

    // 1. Super-destructive always gates [FIX: SE-002]
    const superDestructive = toolCalls.filter(t =>
      toolActionMatchesNameSet(SUPER_DESTRUCTIVE_OPERATIONS, t.name)
    );
    if (superDestructive.length > 0) {
      if (!options?.dryRun) {
        for (const call of toolCalls) {
          await insertAuditLog(null, tenantId, {
            action: call.name,
            inputArgs: { hitlLevel, gated: true, reason: 'super_destructive_gate' },
            outcome: 'gated',
            triggeredBy: 'system',
          });
        }
      }
      return { shouldGate: true, reason: 'super_destructive_gate' };
    }

    // 1a. Name-based merge-to-main gate. Fires BEFORE the autonomy-level
    //     shortcuts (level 4/5) so a fully-autonomous agent can't bypass it,
    //     and independent of escalation — matching liftoff-tenant-runtime's
    //     checkHitlGate ordering so the operator dashboard preview matches
    //     runtime. (Previously this lived inside the escalation+sensitive_work
    //     block AFTER the level-4/5 early returns, so it never fired for
    //     autonomous agents.) Covers GitHub MCP tools whose categories are
    //     discovered dynamically from the vendor MCP server and carry no static
    //     labels. Tool names are dispatch-prefixed (alias__ / mcp__…__), so
    //     match via toolActionMatchesNameSet (bare + prefixed).
    if (oversight?.sensitiveWork?.mergeToMain) {
      const mergeCall = toolCalls.find(tc => toolActionMatchesNameSet(MERGE_TO_MAIN_TOOL_NAMES, tc.name));
      if (mergeCall) {
        return { shouldGate: true, reason: 'merge_to_main' };
      }
    }

    // 1b. External-content write gate — a platform invariant, mirroring
    //     tenant-runtime's runtime gate so the operator dashboard preview matches.
    //     When the run's content trust is untrusted_inbound (external-authored input
    //     reached the agent) and any pending call is not a pure read (effect !==
    //     'read', which includes write, spawn, and a missing effect → fail closed),
    //     gate. Placed BEFORE the level-4/5 autonomy shortcuts so earned autonomy
    //     cannot bypass it. The runtime side additionally clears this via a standing
    //     policy whose action_classes cover every pending call; the simulator models
    //     the base decision (no live policy in the debug request).
    if (options?.trustLevel === 'untrusted_inbound') {
      const hasEffectfulCall = toolCalls.some(call => {
        const tool = tools.find(t => t.name === call.name);
        return tool?.effect !== 'read';
      });
      if (hasEffectfulCall) {
        return { shouldGate: true, reason: 'external_content_write' };
      }
    }

    // 2. Level 4: Smart autonomous - auto-elevate low-risk tools to Level 5 behavior
    // When user selects "More autonomous", low-risk tools proceed without gate
    if (hitlLevel === 4) {
      const allToolsLowRisk = toolCalls.every(call => {
        const tool = tools.find(t => t.name === call.name);
        return this.isLowRiskTool(tool);
      });

      if (allToolsLowRisk) {
        // Apply Level 5 behavior for low-risk tools: rate limit + audit + no gate
        const recentOps = await this.getRecentOperationCount(tenantId, '1h');
        if (recentOps > AUTONOMOUS_HOURLY_LIMIT) {
          if (!options?.dryRun) {
            for (const call of toolCalls) {
              await insertAuditLog(null, tenantId, {
                action: call.name,
                inputArgs: { hitlLevel: 4, gated: true, reason: 'rate_limit_exceeded', recentOps },
                outcome: 'gated',
                triggeredBy: 'system',
              });
            }
          }
          return {
            shouldGate: true,
            reason: 'rate_limit_exceeded',
            message: `Autonomous rate limit exceeded (${recentOps}/${AUTONOMOUS_HOURLY_LIMIT} ops/hour)`
          };
        }

        // Audit log as auto-elevated operation
        if (!options?.dryRun) {
          for (const call of toolCalls) {
            const tool = tools.find(t => t.name === call.name);
            await insertAuditLog(null, tenantId, {
              action: call.name,
              inputArgs: {
                hitlLevel: 4,
                autoElevated: true,
                categories: tool?.categories || [],
              },
              outcome: 'success',
              triggeredBy: 'system',
            });
            await this.recordRateLimitEvent({
              tenantId,
              hitlLevel: 4,
              toolName: call.name,
              autoElevated: true,
            });
          }
        }

        return { shouldGate: false };
      }
      // Fall through to sensitive work check for tools with categories
    }

    // 3. Level 5: Fully autonomous - only super-destructive gates [SE-001, SE-002]
    if (hitlLevel === 5) {
      // Rate limiting check
      const recentOps = await this.getRecentOperationCount(tenantId, '1h');
      if (recentOps > AUTONOMOUS_HOURLY_LIMIT) {
        if (!options?.dryRun) {
          for (const call of toolCalls) {
            await insertAuditLog(null, tenantId, {
              action: call.name,
              inputArgs: { hitlLevel: 5, gated: true, reason: 'rate_limit_exceeded', recentOps },
              outcome: 'gated',
              triggeredBy: 'system',
            });
          }
        }
        return {
          shouldGate: true,
          reason: 'rate_limit_exceeded',
          message: `Autonomous rate limit exceeded (${recentOps}/${AUTONOMOUS_HOURLY_LIMIT} ops/hour)`
        };
      }

      // Audit log autonomous operations
      if (!options?.dryRun) {
        for (const call of toolCalls) {
          const tool = tools.find(t => t.name === call.name);
          await insertAuditLog(null, tenantId, {
            action: call.name,
            inputArgs: {
              hitlLevel: 5,
              autoElevated: false,
              categories: tool?.categories || [],
            },
            outcome: 'success',
            triggeredBy: 'system',
          });
          await this.recordRateLimitEvent({
            tenantId,
            hitlLevel: 5,
            toolName: call.name,
            autoElevated: false,
          });
        }
      }

      return { shouldGate: false };
    }

    // 4. Level-based gating
    if (hitlLevel === 1) {
      if (!options?.dryRun) {
        for (const call of toolCalls) {
          await insertAuditLog(null, tenantId, {
            action: call.name,
            inputArgs: { hitlLevel: 1, gated: true, reason: 'level_1_gate' },
            outcome: 'gated',
            triggeredBy: 'system',
          });
        }
      }
      return { shouldGate: true, reason: 'level_1_gate' };
    }

    if (hitlLevel === 2) {
      const destructiveNames = new Set(
        tools
          .filter(t => t.description?.includes('⚠️ DESTRUCTIVE'))
          .map(t => t.name)
      );
      const destructive = toolCalls.filter(t => destructiveNames.has(t.name));
      if (destructive.length > 0) {
        if (!options?.dryRun) {
          for (const call of toolCalls) {
            await insertAuditLog(null, tenantId, {
              action: call.name,
              inputArgs: {
                hitlLevel: 2,
                gated: true,
                reason: 'destructive_gate',
                isDestructiveTrigger: destructiveNames.has(call.name),
              },
              outcome: 'gated',
              triggeredBy: 'system',
            });
          }
        }
        return { shouldGate: true, reason: 'destructive_gate' };
      }
    }

    // 5. Escalation + Sensitive Work check (if oversight settings provided)
    // Also applies to Level 4 when tools have sensitive categories (not auto-elevated)
    if (oversight && (oversight.escalation === 'sensitive' || oversight.escalation === 'important')) {
      const enabledCategories = Object.entries(oversight.sensitiveWork)
        .filter(([, enabled]) => enabled)
        .map(([category]) => category);

      // Pass 1: find first matching category
      let matchedCategory: string | undefined;
      for (const call of toolCalls) {
        const tool = tools.find(t => t.name === call.name);
        const cat = tool?.categories?.find(c => enabledCategories.includes(c));
        if (cat) {
          matchedCategory = cat;
          break;
        }
      }

      // Pass 2: if any match, audit all tools in batch and gate
      if (matchedCategory) {
        if (!options?.dryRun) {
          for (const call of toolCalls) {
            const tool = tools.find(t => t.name === call.name);
            await insertAuditLog(null, tenantId, {
              action: call.name,
              inputArgs: {
                hitlLevel,
                gated: true,
                reason: 'sensitive_work',
                matchedCategory,
                categories: tool?.categories || [],
              },
              outcome: 'gated',
              triggeredBy: 'system',
            });
          }
        }
        return { shouldGate: true, reason: 'sensitive_work', matchedCategory };
      }
    }

    if (!options?.dryRun) {
      for (const call of toolCalls) {
        const tool = tools.find(t => t.name === call.name);
        await insertAuditLog(null, tenantId, {
          action: call.name,
          inputArgs: {
            hitlLevel,
            autoElevated: false,
            categories: tool?.categories || [],
          },
          outcome: 'success',
          triggeredBy: 'system',
        });
      }
    }
    return { shouldGate: false };
  }

  // Hash tool calls for tamper detection [FIX: SE-008]
  hashToolCalls(toolCalls: ToolCallRequest[]): string {
    const normalized = JSON.stringify(toolCalls.map(t => ({
      id: t.id,
      name: t.name,
      input: t.input,
    })));
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }

  // Create approval request
  async createApprovalRequest(input: CreateApprovalInput): Promise<HitlApprovalRequest> {
    const toolCallsHash = this.hashToolCalls(input.pendingToolCalls);

    const result = await pool.query(
      `INSERT INTO hitl_approval_requests
        (tenant_id, workflow_id, task_id, agent_id, hitl_level, pending_tool_calls, tool_calls_hash, reason, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [
        input.tenantId,
        // workflow_id / task_id are nullable UUID columns. Some callers (the
        // Authorize HITL gate) legitimately have no workflow/task and pass an
        // empty string, which Postgres rejects as `invalid input syntax for
        // type uuid: ""` — an uncaught throw that 500s the Authorize hot path.
        // Coalesce empty -> NULL so a missing id stores as NULL, not a crash.
        input.workflowId || null,
        input.taskId || null,
        input.agentId,
        input.hitlLevel,
        JSON.stringify(input.pendingToolCalls),
        toolCallsHash,
        input.reason,
        input.idempotencyKey || null,
      ]
    );

    log.info({
      approvalId: result.rows[0].id,
      tenantId: input.tenantId,
      reason: input.reason,
    }, 'HITL approval request created');

    return this.mapApprovalRequest(result.rows[0]);
  }

  // Get approval request by ID
  async getApprovalRequest(approvalId: string): Promise<HitlApprovalRequest | null> {
    const result = await pool.query(
      `SELECT * FROM hitl_approval_requests WHERE id = $1`,
      [approvalId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapApprovalRequest(result.rows[0]);
  }

  // Count pending approvals for a tenant — used by the /review badge.
  async getPendingApprovalCount(tenantId: string): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM hitl_approval_requests
       WHERE tenant_id = $1 AND status = 'pending'`,
      [tenantId]
    );
    return parseInt(result.rows[0].count, 10) || 0;
  }

  // List pending approvals for a tenant
  async listPendingApprovals(
    tenantId: string,
    options?: { cursor?: string; limit?: number }
  ): Promise<{ approvals: HitlApprovalRequest[]; nextCursor: string | null }> {
    const limit = Math.min(options?.limit || 20, 100);

    let query = `
      SELECT * FROM hitl_approval_requests
      WHERE tenant_id = $1 AND status = 'pending'
    `;
    const params: (string | number)[] = [tenantId];

    if (options?.cursor) {
      query += ` AND created_at < $2`;
      params.push(options.cursor);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit + 1);

    const result = await pool.query(query, params);
    const hasMore = result.rows.length > limit;
    const approvals = result.rows
      .slice(0, limit)
      .map(row => this.mapApprovalRequest(row));

    return {
      approvals,
      nextCursor: hasMore && approvals.length > 0
        ? approvals[approvals.length - 1].createdAt.toISOString()
        : null,
    };
  }

  // Approve request [FIX: SE-008] with tamper detection
  async approveRequest(input: ResolveApprovalInput): Promise<HitlApprovalRequest> {
    const approval = await this.getApprovalRequest(input.approvalId);

    if (!approval) {
      throw new Error('Approval request not found');
    }

    if (approval.status !== 'pending') {
      throw new Error(`Cannot approve: request status is ${approval.status}`);
    }

    if (approval.expiresAt < new Date()) {
      throw new Error('Cannot approve: request has expired');
    }

    // [FIX: SE-008] Verify hash matches
    const currentHash = this.hashToolCalls(approval.pendingToolCalls);
    if (currentHash !== approval.toolCallsHash) {
      throw new Error('TAMPER_DETECTED: pending_tool_calls have been modified');
    }

    const result = await pool.query(
      `UPDATE hitl_approval_requests SET
        status = 'approved',
        decision = 'approved',
        decided_by = $2,
        decided_by_role = $3,
        decided_at = NOW(),
        updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [input.approvalId, input.decidedBy, input.decidedByRole]
    );

    log.info({
      approvalId: input.approvalId,
      decidedBy: input.decidedBy,
    }, 'HITL approval request approved');

    const approved = this.mapApprovalRequest(result.rows[0]);

    if (approved.pendingToolCalls?.length) {
      for (const call of approved.pendingToolCalls) {
        await insertAuditLog(null, approved.tenantId, {
          internalAgentId: approved.agentId ?? undefined,
          action: call.name,
          inputArgs: {
            hitlLevel: approved.hitlLevel,
            decision: 'approved',
            decidedBy: input.decidedBy,
            decidedByRole: input.decidedByRole,
          },
          outcome: 'success',
          triggeredBy: 'system',
        });
      }
    }

    if (input.alwaysApply && approved.agentId && approved.reason) {
      await this.upsertApprovalPolicy({
        tenantId: approved.tenantId,
        agentId: approved.agentId,
        gateReason: approved.reason,
        decision: 'approved',
        createdBy: input.decidedBy,
      });
    }

    return approved;
  }

  // Reject request
  async rejectRequest(input: ResolveApprovalInput): Promise<HitlApprovalRequest> {
    const approval = await this.getApprovalRequest(input.approvalId);

    if (!approval) {
      throw new Error('Approval request not found');
    }

    if (approval.status !== 'pending') {
      throw new Error(`Cannot reject: request status is ${approval.status}`);
    }

    const result = await pool.query(
      `UPDATE hitl_approval_requests SET
        status = 'rejected',
        decision = 'rejected',
        decided_by = $2,
        decided_by_role = $3,
        rejection_reason = $4,
        decided_at = NOW(),
        updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [input.approvalId, input.decidedBy, input.decidedByRole, input.rejectionReason || null]
    );

    log.info({
      approvalId: input.approvalId,
      decidedBy: input.decidedBy,
      reason: input.rejectionReason,
    }, 'HITL approval request rejected');

    // Phase 3e: tenant-runtime owns the reflection + learning loop. Publish
    // a governance event describing the rejection so any subscriber
    // (reflection engine, analytics, audit tooling) can react. The
    // publisher is fire-and-forget and already swallows transport errors.
    void publishCorrectionCaptured({
      tenantId: approval.tenantId,
      agentId: approval.agentId,
      actionId: null,
      correctionType: 'rejected',
      correctionPayload: {
        pendingToolCalls: approval.pendingToolCalls || [],
        rejectionReason: input.rejectionReason,
        approvalId: input.approvalId,
      },
    });
    // Also fire the reflection-engine trigger (now Pub/Sub-backed) so the
    // late-feedback analysis path picks up immediate rejections.
    void reflectionTriggerService.onLateFeedbackFlagged(
      approval.agentId,
      approval.tenantId,
      input.approvalId,
    );

    const rejected = this.mapApprovalRequest(result.rows[0]);

    if (rejected.pendingToolCalls?.length) {
      for (const call of rejected.pendingToolCalls) {
        await insertAuditLog(null, rejected.tenantId, {
          internalAgentId: rejected.agentId ?? undefined,
          action: call.name,
          inputArgs: {
            hitlLevel: rejected.hitlLevel,
            decision: 'rejected',
            decidedBy: input.decidedBy,
            decidedByRole: input.decidedByRole,
            rejectionReason: input.rejectionReason ?? null,
          },
          outcome: 'gated',
          triggeredBy: 'system',
        });
      }
    }

    if (input.alwaysApply && rejected.agentId && rejected.reason) {
      await this.upsertApprovalPolicy({
        tenantId: rejected.tenantId,
        agentId: rejected.agentId,
        gateReason: rejected.reason,
        decision: 'rejected',
        createdBy: input.decidedBy,
      });
    }

    return rejected;
  }

  // Upsert a standing approval policy for an (agent_id, gate_reason) pair.
  async upsertApprovalPolicy(input: {
    tenantId: string;
    agentId: string;
    gateReason: string;
    decision: 'approved' | 'rejected';
    createdBy: string;
    expiresAt?: Date | null;
    actionClasses?: string[] | null;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO hitl_approval_policies (tenant_id, agent_id, gate_reason, decision, created_by, expires_at, action_classes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, agent_id, gate_reason) DO UPDATE
         SET decision = EXCLUDED.decision,
             created_by = EXCLUDED.created_by,
             created_at = now(),
             expires_at = EXCLUDED.expires_at,
             action_classes = EXCLUDED.action_classes`,
      [input.tenantId, input.agentId, input.gateReason, input.decision, input.createdBy, input.expiresAt ?? null, input.actionClasses ?? null],
    );
    log.info({ tenantId: input.tenantId, agentId: input.agentId, gateReason: input.gateReason, decision: input.decision }, 'Approval policy upserted');
  }

  // Look up a standing approval policy. Returns null if none exists or it has expired.
  async getApprovalPolicy(tenantId: string, agentId: string, gateReason: string): Promise<HitlApprovalPolicy | null> {
    const result = await pool.query<{
      id: string; tenant_id: string; agent_id: string; gate_reason: string;
      decision: string; created_by: string; created_at: Date; expires_at: Date | null;
      action_classes: string[] | null;
    }>(
      `SELECT * FROM hitl_approval_policies
       WHERE tenant_id = $1 AND agent_id = $2 AND gate_reason = $3
         AND (expires_at IS NULL OR expires_at > now())
       LIMIT 1`,
      [tenantId, agentId, gateReason],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      tenantId: row.tenant_id,
      agentId: row.agent_id,
      gateReason: row.gate_reason,
      decision: row.decision as 'approved' | 'rejected',
      createdBy: row.created_by,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      actionClasses: row.action_classes,
    };
  }

  // Record late feedback from Platform Backend.
  //
  // Late feedback represents a human decision that arrived AFTER the original
  // HITL approval expired (the agent already moved on without waiting). The
  // decision is still useful for agent learning, so we:
  //   1. Look up the original approval to recover agent_id, tenant_id, task_id
  //   2. Verify tenant isolation
  //   3. Insert into human_feedback (the table reflection-engine reads from)
  //      with idempotency on feedback_id, so retries from Platform Backend
  //      don't duplicate the row
  //   4. Return whether this was a fresh write or a no-op duplicate
  //
  // The reflection trigger is fired by the router after a successful fresh
  // write — keeping it out of this method makes the unit test trivially
  // mockable without a Cloud Tasks dependency.
  async recordLateFeedback(input: {
    feedbackId: string;
    tenantId: string;
    approvalId: string;
    decision: 'approved' | 'rejected';
    decidedBy: string;
    decidedByRole: string;
    rejectionReason?: string;
  }): Promise<{ inserted: boolean; agentId: string | null }> {
    // Look up the original approval to get agent_id, task_id, and verify tenant.
    const approvalResult = await pool.query(
      `SELECT agent_id, tenant_id, task_id FROM hitl_approval_requests WHERE id = $1`,
      [input.approvalId]
    );

    if (approvalResult.rows.length === 0) {
      log.warn({
        feedbackId: input.feedbackId,
        approvalId: input.approvalId,
        tenantId: input.tenantId,
      }, 'Late feedback received for unknown approval');
      return { inserted: false, agentId: null };
    }

    const approval = approvalResult.rows[0];
    if (approval.tenant_id !== input.tenantId) {
      // Cross-tenant attempt — surface as not-found, never confirm existence.
      log.warn({
        feedbackId: input.feedbackId,
        approvalId: input.approvalId,
        callingTenantId: input.tenantId,
      }, 'Cross-tenant late feedback attempt rejected');
      return { inserted: false, agentId: null };
    }

    const agentId = approval.agent_id as string;
    const taskId = approval.task_id as string | null;

    // Encode the decision as a structured feedback row. The reflection
    // engine reads `feedback` (text) and `feedback_type` (string) — we put
    // the rejection reason into the text body when present, and tag the
    // type so reflection can weight late approvals vs late rejections
    // differently if it ever wants to.
    const feedbackType = input.decision === 'approved' ? 'late_approval' : 'late_rejection';
    const feedbackText =
      input.decision === 'rejected' && input.rejectionReason
        ? `Late rejection by ${input.decidedByRole} (${input.decidedBy}): ${input.rejectionReason}`
        : `Late ${input.decision} by ${input.decidedByRole} (${input.decidedBy})`;

    // Idempotent insert keyed on feedback_id (unique partial index from
    // migration 057). Returning the id tells us whether this was a fresh
    // write or a duplicate caught by ON CONFLICT.
    const insertResult = await pool.query(
      `INSERT INTO human_feedback (agent_id, tenant_id, task_id, feedback, feedback_type, feedback_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (feedback_id) WHERE feedback_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [agentId, input.tenantId, taskId, feedbackText, feedbackType, input.feedbackId]
    );

    const inserted = insertResult.rows.length > 0;

    log.info({
      event: 'hitl_late_feedback_recorded',
      feedbackId: input.feedbackId,
      approvalId: input.approvalId,
      tenantId: input.tenantId,
      agentId,
      decision: input.decision,
      inserted,
    }, inserted ? 'Late feedback recorded' : 'Late feedback already recorded (idempotent)');

    // Phase 3e: publish a correction event on late rejections so the
    // reflection engine / learning loop (tenant-runtime) can ingest it.
    if (inserted && input.decision === 'rejected') {
      void publishCorrectionCaptured({
        tenantId: input.tenantId,
        agentId,
        actionId: null,
        correctionType: 'rejected',
        correctionPayload: {
          // pendingToolCalls not on the approval lookup — reflection can
          // reload from hitl_approval_requests if it needs them.
          pendingToolCalls: [],
          rejectionReason: input.rejectionReason,
          approvalId: input.approvalId,
        },
      });
      // Also emit the late-feedback-flagged event so subscribers that only
      // care about the late-feedback channel pick it up.
      void publishLateFeedbackFlagged({
        tenantId: input.tenantId,
        agentId,
        feedbackId: input.feedbackId,
        approvalId: input.approvalId,
        decision: input.decision,
        rejectionReason: input.rejectionReason,
      });
    }

    return { inserted, agentId };
  }

  // Get cached oversight settings
  async getOversightSettings(tenantId: string): Promise<OversightSettings | null> {
    const result = await pool.query(
      `SELECT * FROM tenant_oversight_cache WHERE tenant_id = $1`,
      [tenantId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      tenantId: row.tenant_id,
      autonomy: row.autonomy,
      escalation: row.escalation,
      sensitiveWork: row.sensitive_work,
      communication: row.communication,
    };
  }

  // Get default HITL level from autonomy
  getDefaultHitlLevel(autonomy: string): number {
    switch (autonomy) {
      case 'controlled':
        return 2;
      case 'balanced':
        return 3;
      case 'autonomous':
        return 4;
      default:
        return 3;
    }
  }

  // Resolve effective HITL level (team override -> tenant default)
  // Fail-closed: if DB is unreachable, return level 1 to gate everything rather
  // than relying on the indirect "no token → blocked" path in Authorize.
  async resolveHitlLevel(tenantId: string, teamHitlLevel?: number): Promise<number> {
    try {
      if (teamHitlLevel !== undefined && teamHitlLevel !== null) {
        return teamHitlLevel;
      }

      const oversight = await this.getOversightSettings(tenantId);
      return this.getDefaultHitlLevel(oversight?.autonomy || 'balanced');
    } catch (err) {
      log.error(
        { error: (err as Error).message, tenantId },
        'resolveHitlLevel: DB error, failing closed at level 1',
      );
      return 1;
    }
  }

  // Map database row to HitlApprovalRequest
  private mapApprovalRequest(row: Record<string, unknown>): HitlApprovalRequest {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      workflowId: row.workflow_id as string,
      taskId: row.task_id as string,
      agentId: row.agent_id as string,
      hitlLevel: row.hitl_level as number,
      pendingToolCalls: this.parseToolCalls(row.pending_tool_calls),
      toolCallsHash: row.tool_calls_hash as string,
      reason: row.reason as string,
      status: row.status as ApprovalStatus,
      decidedBy: row.decided_by as string | null,
      decidedByRole: row.decided_by_role as string | null,
      decision: row.decision as 'approved' | 'rejected' | null,
      rejectionReason: row.rejection_reason as string | null,
      decidedAt: row.decided_at ? new Date(row.decided_at as string) : null,
      idempotencyKey: row.idempotency_key as string | null,
      expiresAt: new Date(row.expires_at as string),
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  private parseToolCalls(raw: unknown): ToolCallRequest[] {
    if (Array.isArray(raw)) {
      return raw as ToolCallRequest[];
    }
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch {
        return [];
      }
    }
    return [];
  }
}

export const hitlEnforcementService = new HitlEnforcementService();
