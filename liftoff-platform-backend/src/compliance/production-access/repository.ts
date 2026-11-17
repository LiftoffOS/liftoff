// Production Access Repository
// Per Section 19: SOC 2 and GDPR readiness - access audit trail

import { pool } from '../../infrastructure/database';
import {
  AccessRequest,
  BreakglassRequest,
  BreakglassAction,
  AccessAuditEntry,
  ApprovalGate,
  AccessStatus,
  AccessStats,
} from './types';

export class ProductionAccessRepository {
  // Access Request Methods
  async createAccessRequest(request: Omit<AccessRequest, 'id' | 'createdAt' | 'updatedAt'>): Promise<AccessRequest> {
    const result = await pool.query(
      `INSERT INTO production_access_requests (
        requester_id, requester_email, access_level, reason, justification,
        target_resources, target_environment, duration_minutes, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        request.requesterId,
        request.requesterEmail,
        request.accessLevel,
        request.reason,
        request.justification,
        JSON.stringify(request.targetResources),
        request.targetEnvironment,
        request.durationMinutes,
        request.status,
      ]
    );
    return this.mapAccessRequest(result.rows[0]);
  }

  async findAccessRequestById(id: string): Promise<AccessRequest | null> {
    const result = await pool.query(
      'SELECT * FROM production_access_requests WHERE id = $1',
      [id]
    );
    return result.rows[0] ? this.mapAccessRequest(result.rows[0]) : null;
  }

  async findPendingAccessRequests(): Promise<AccessRequest[]> {
    const result = await pool.query(
      `SELECT * FROM production_access_requests
       WHERE status = 'pending'
       ORDER BY created_at ASC`
    );
    return result.rows.map(this.mapAccessRequest);
  }

  async findActiveAccesses(): Promise<AccessRequest[]> {
    const result = await pool.query(
      `SELECT * FROM production_access_requests
       WHERE status = 'active' AND expires_at > NOW()
       ORDER BY expires_at ASC`
    );
    return result.rows.map(this.mapAccessRequest);
  }

  async updateAccessRequestStatus(
    id: string,
    status: AccessStatus,
    updates: Partial<AccessRequest>
  ): Promise<AccessRequest> {
    const setClauses: string[] = ['status = $2', 'updated_at = NOW()'];
    const values: any[] = [id, status];
    let paramIndex = 3;

    if (updates.approverId) {
      setClauses.push(`approver_id = $${paramIndex++}`);
      values.push(updates.approverId);
    }
    if (updates.approverEmail) {
      setClauses.push(`approver_email = $${paramIndex++}`);
      values.push(updates.approverEmail);
    }
    if (updates.approvedAt) {
      setClauses.push(`approved_at = $${paramIndex++}`);
      values.push(updates.approvedAt);
    }
    if (updates.denialReason) {
      setClauses.push(`denial_reason = $${paramIndex++}`);
      values.push(updates.denialReason);
    }
    if (updates.grantedAt) {
      setClauses.push(`granted_at = $${paramIndex++}`);
      values.push(updates.grantedAt);
    }
    if (updates.expiresAt) {
      setClauses.push(`expires_at = $${paramIndex++}`);
      values.push(updates.expiresAt);
    }
    if (updates.revokedAt) {
      setClauses.push(`revoked_at = $${paramIndex++}`);
      values.push(updates.revokedAt);
    }
    if (updates.revokedBy) {
      setClauses.push(`revoked_by = $${paramIndex++}`);
      values.push(updates.revokedBy);
    }
    if (updates.revokedReason) {
      setClauses.push(`revoked_reason = $${paramIndex++}`);
      values.push(updates.revokedReason);
    }

    const result = await pool.query(
      `UPDATE production_access_requests SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
      values
    );
    return this.mapAccessRequest(result.rows[0]);
  }

  async markExpiredAccesses(): Promise<number> {
    const result = await pool.query(
      `UPDATE production_access_requests
       SET status = 'expired', updated_at = NOW()
       WHERE status = 'active' AND expires_at < NOW()`
    );
    return result.rowCount ?? 0;
  }

  // Breakglass Methods
  async createBreakglassRequest(request: Omit<BreakglassRequest, 'id' | 'createdAt' | 'updatedAt' | 'actionsPerformed'>): Promise<BreakglassRequest> {
    const result = await pool.query(
      `INSERT INTO breakglass_requests (
        requester_id, requester_email, incident_id, incident_severity,
        target_resources, target_environment, justification, status,
        granted_at, expires_at, duration_minutes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [
        request.requesterId,
        request.requesterEmail,
        request.incidentId,
        request.incidentSeverity,
        JSON.stringify(request.targetResources),
        request.targetEnvironment,
        request.justification,
        request.status,
        request.grantedAt,
        request.expiresAt,
        request.durationMinutes,
      ]
    );
    return this.mapBreakglassRequest(result.rows[0]);
  }

  async findBreakglassById(id: string): Promise<BreakglassRequest | null> {
    const result = await pool.query(
      'SELECT * FROM breakglass_requests WHERE id = $1',
      [id]
    );
    if (!result.rows[0]) return null;

    const breakglass = this.mapBreakglassRequest(result.rows[0]);
    breakglass.actionsPerformed = await this.findBreakglassActions(id);
    return breakglass;
  }

  async findActiveBreakglassRequests(): Promise<BreakglassRequest[]> {
    const result = await pool.query(
      `SELECT * FROM breakglass_requests
       WHERE status = 'active' AND expires_at > NOW()
       ORDER BY granted_at DESC`
    );
    return result.rows.map(this.mapBreakglassRequest);
  }

  async markExpiredBreakglass(): Promise<number> {
    const result = await pool.query(
      `UPDATE breakglass_requests
       SET status = 'expired', updated_at = NOW()
       WHERE status = 'active' AND expires_at < NOW()`
    );
    return result.rowCount ?? 0;
  }

  async revokeBreakglass(id: string, revokedBy: string, reason: string): Promise<BreakglassRequest> {
    const result = await pool.query(
      `UPDATE breakglass_requests
       SET status = 'revoked', revoked_at = NOW(), revoked_by = $2, revoked_reason = $3, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, revokedBy, reason]
    );
    return this.mapBreakglassRequest(result.rows[0]);
  }

  async recordBreakglassAction(action: Omit<BreakglassAction, 'id'>): Promise<BreakglassAction> {
    const result = await pool.query(
      `INSERT INTO breakglass_actions (
        breakglass_id, action_type, target_resource, action_details, performed_at, performed_by
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [
        action.breakglassId,
        action.actionType,
        action.targetResource,
        JSON.stringify(action.actionDetails),
        action.performedAt,
        action.performedBy,
      ]
    );
    return this.mapBreakglassAction(result.rows[0]);
  }

  async findBreakglassActions(breakglassId: string): Promise<BreakglassAction[]> {
    const result = await pool.query(
      'SELECT * FROM breakglass_actions WHERE breakglass_id = $1 ORDER BY performed_at ASC',
      [breakglassId]
    );
    return result.rows.map(this.mapBreakglassAction);
  }

  // Audit Entry Methods
  async createAuditEntry(entry: Omit<AccessAuditEntry, 'id'>): Promise<AccessAuditEntry> {
    const result = await pool.query(
      `INSERT INTO production_access_audit (
        event_type, request_id, breakglass_id, user_id, user_email,
        target_resources, target_environment, details, ip_address, user_agent, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [
        entry.eventType,
        entry.requestId,
        entry.breakglassId,
        entry.userId,
        entry.userEmail,
        JSON.stringify(entry.targetResources),
        entry.targetEnvironment,
        JSON.stringify(entry.details),
        entry.ipAddress,
        entry.userAgent,
        entry.timestamp,
      ]
    );
    return this.mapAuditEntry(result.rows[0]);
  }

  async findAuditEntries(options: {
    userId?: string;
    requestId?: string;
    breakglassId?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  }): Promise<AccessAuditEntry[]> {
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (options.userId) {
      conditions.push(`user_id = $${paramIndex++}`);
      values.push(options.userId);
    }
    if (options.requestId) {
      conditions.push(`request_id = $${paramIndex++}`);
      values.push(options.requestId);
    }
    if (options.breakglassId) {
      conditions.push(`breakglass_id = $${paramIndex++}`);
      values.push(options.breakglassId);
    }
    if (options.startDate) {
      conditions.push(`timestamp >= $${paramIndex++}`);
      values.push(options.startDate);
    }
    if (options.endDate) {
      conditions.push(`timestamp <= $${paramIndex++}`);
      values.push(options.endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const result = await pool.query(
      `SELECT * FROM production_access_audit
       ${whereClause}
       ORDER BY timestamp DESC
       LIMIT ${limit} OFFSET ${offset}`,
      values
    );
    return result.rows.map(this.mapAuditEntry);
  }

  // Approval Gate Methods
  async findApprovalGates(): Promise<ApprovalGate[]> {
    const result = await pool.query(
      'SELECT * FROM approval_gates WHERE is_active = true ORDER BY name ASC'
    );
    return result.rows.map(this.mapApprovalGate);
  }

  async findApprovalGateById(id: string): Promise<ApprovalGate | null> {
    const result = await pool.query(
      'SELECT * FROM approval_gates WHERE id = $1',
      [id]
    );
    return result.rows[0] ? this.mapApprovalGate(result.rows[0]) : null;
  }

  async findApplicableGate(
    accessLevel: string,
    reason: string,
    environment: string
  ): Promise<ApprovalGate | null> {
    const result = await pool.query(
      `SELECT * FROM approval_gates
       WHERE is_active = true
         AND $1 = ANY(allowed_access_levels)
         AND $2 = ANY(allowed_reasons)
         AND $3 = ANY(target_environments)
       ORDER BY required_approvers DESC
       LIMIT 1`,
      [accessLevel, reason, environment]
    );
    return result.rows[0] ? this.mapApprovalGate(result.rows[0]) : null;
  }

  // Statistics
  async getStats(): Promise<AccessStats> {
    const result = await pool.query(`
      SELECT
        COUNT(*) as total_requests,
        COUNT(*) FILTER (WHERE status = 'pending') as pending_requests,
        COUNT(*) FILTER (WHERE status = 'approved' OR status = 'active') as approved_requests,
        COUNT(*) FILTER (WHERE status = 'denied') as denied_requests,
        COUNT(*) FILTER (WHERE status = 'active' AND expires_at > NOW()) as active_accesses,
        AVG(EXTRACT(EPOCH FROM (approved_at - created_at)) / 60) FILTER (WHERE approved_at IS NOT NULL) as avg_approval_time
      FROM production_access_requests
    `);

    const breakglassResult = await pool.query(`
      SELECT COUNT(*) as breakglass_count FROM breakglass_requests
    `);

    return {
      totalRequests: parseInt(result.rows[0].total_requests),
      pendingRequests: parseInt(result.rows[0].pending_requests),
      approvedRequests: parseInt(result.rows[0].approved_requests),
      deniedRequests: parseInt(result.rows[0].denied_requests),
      activeAccesses: parseInt(result.rows[0].active_accesses),
      breakglassActivations: parseInt(breakglassResult.rows[0].breakglass_count),
      averageApprovalTimeMinutes: parseFloat(result.rows[0].avg_approval_time) || 0,
    };
  }

  // Mapping helpers
  private mapAccessRequest(row: any): AccessRequest {
    return {
      id: row.id,
      requesterId: row.requester_id,
      requesterEmail: row.requester_email,
      accessLevel: row.access_level,
      reason: row.reason,
      justification: row.justification,
      targetResources: typeof row.target_resources === 'string'
        ? JSON.parse(row.target_resources)
        : row.target_resources,
      targetEnvironment: row.target_environment,
      durationMinutes: row.duration_minutes,
      status: row.status,
      approverId: row.approver_id,
      approverEmail: row.approver_email,
      approvedAt: row.approved_at,
      denialReason: row.denial_reason,
      grantedAt: row.granted_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      revokedBy: row.revoked_by,
      revokedReason: row.revoked_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapBreakglassRequest(row: any): BreakglassRequest {
    return {
      id: row.id,
      requesterId: row.requester_id,
      requesterEmail: row.requester_email,
      incidentId: row.incident_id,
      incidentSeverity: row.incident_severity,
      targetResources: typeof row.target_resources === 'string'
        ? JSON.parse(row.target_resources)
        : row.target_resources,
      targetEnvironment: row.target_environment,
      justification: row.justification,
      status: row.status,
      grantedAt: row.granted_at,
      expiresAt: row.expires_at,
      durationMinutes: row.duration_minutes,
      actionsPerformed: [],
      revokedAt: row.revoked_at,
      revokedBy: row.revoked_by,
      revokedReason: row.revoked_reason,
      postIncidentReviewId: row.post_incident_review_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapBreakglassAction(row: any): BreakglassAction {
    return {
      id: row.id,
      breakglassId: row.breakglass_id,
      actionType: row.action_type,
      targetResource: row.target_resource,
      actionDetails: typeof row.action_details === 'string'
        ? JSON.parse(row.action_details)
        : row.action_details,
      performedAt: row.performed_at,
      performedBy: row.performed_by,
    };
  }

  private mapAuditEntry(row: any): AccessAuditEntry {
    return {
      id: row.id,
      eventType: row.event_type,
      requestId: row.request_id,
      breakglassId: row.breakglass_id,
      userId: row.user_id,
      userEmail: row.user_email,
      targetResources: typeof row.target_resources === 'string'
        ? JSON.parse(row.target_resources)
        : row.target_resources,
      targetEnvironment: row.target_environment,
      details: typeof row.details === 'string'
        ? JSON.parse(row.details)
        : row.details,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      timestamp: row.timestamp,
    };
  }

  private mapApprovalGate(row: any): ApprovalGate {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      requiredApprovers: row.required_approvers,
      approverRoles: row.approver_roles,
      autoExpireMinutes: row.auto_expire_minutes,
      requiresMfa: row.requires_mfa,
      requiresJustification: row.requires_justification,
      allowedAccessLevels: row.allowed_access_levels,
      allowedReasons: row.allowed_reasons,
      targetEnvironments: row.target_environments,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
