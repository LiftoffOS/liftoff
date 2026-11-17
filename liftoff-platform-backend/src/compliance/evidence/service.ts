// Compliance Evidence Collection Service
// Per Section 19/20: SOC 2 and GDPR readiness - compliance evidence collection

import { pool } from '../../infrastructure/database';
import { log } from '../../infrastructure/logging';
import { Storage } from '@google-cloud/storage';
import * as crypto from 'crypto';
import {
  EvidenceRecord,
  AccessReviewReport,
  AccessReviewChange,
  AccessReviewFinding,
  ChangeManagementRecord,
  AuditPackage,
  AuditPackageControl,
  AuditPackageSummary,
  CollectEvidenceInput,
  GenerateAccessReviewInput,
  GenerateAuditPackageInput,
  SOC2_CONTROLS,
  ComplianceFramework,
} from './types';

const storage = new Storage();
const EVIDENCE_BUCKET = process.env.EVIDENCE_BUCKET || 'compliance-evidence';

export class ComplianceEvidenceService {
  // Collect evidence
  async collectEvidence(input: CollectEvidenceInput): Promise<EvidenceRecord> {
    let artifactHash: string | undefined;

    // If artifact path provided, calculate hash for integrity
    if (input.artifactPath) {
      try {
        const bucket = storage.bucket(EVIDENCE_BUCKET);
        const file = bucket.file(input.artifactPath);
        const [content] = await file.download();
        artifactHash = crypto.createHash('sha256').update(content).digest('hex');
      } catch (error) {
        log.warn('Failed to calculate artifact hash', { error, path: input.artifactPath });
      }
    }

    const result = await pool.query(
      `INSERT INTO compliance_evidence (
        type, framework, control_id, title, description, status,
        collected_by, collected_at, artifact_path, artifact_hash, metadata, expires_at
      ) VALUES ($1, $2, $3, $4, $5, 'collected', $6, NOW(), $7, $8, $9, $10)
      RETURNING *`,
      [
        input.type,
        input.framework,
        input.controlId,
        input.title,
        input.description,
        input.collectedBy,
        input.artifactPath,
        artifactHash,
        JSON.stringify(input.metadata || {}),
        input.expiresAt,
      ]
    );

    const evidence = this.mapEvidence(result.rows[0]);

    log.info('Compliance evidence collected', {
      evidenceId: evidence.id,
      type: evidence.type,
      framework: evidence.framework,
      controlId: evidence.controlId,
    });

    return evidence;
  }

  // Review evidence
  async reviewEvidence(evidenceId: string, reviewedBy: string): Promise<EvidenceRecord> {
    const result = await pool.query(
      `UPDATE compliance_evidence
       SET status = 'reviewed', reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [evidenceId, reviewedBy]
    );

    if (!result.rows[0]) {
      throw new Error('Evidence not found');
    }

    return this.mapEvidence(result.rows[0]);
  }

  // Approve evidence
  async approveEvidence(evidenceId: string, approvedBy: string): Promise<EvidenceRecord> {
    const result = await pool.query(
      `UPDATE compliance_evidence
       SET status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [evidenceId, approvedBy]
    );

    if (!result.rows[0]) {
      throw new Error('Evidence not found');
    }

    return this.mapEvidence(result.rows[0]);
  }

  // Get evidence by ID
  async getEvidence(evidenceId: string): Promise<EvidenceRecord | null> {
    const result = await pool.query(
      'SELECT * FROM compliance_evidence WHERE id = $1',
      [evidenceId]
    );

    return result.rows[0] ? this.mapEvidence(result.rows[0]) : null;
  }

  // Get evidence by control
  async getEvidenceByControl(controlId: string, framework?: ComplianceFramework): Promise<EvidenceRecord[]> {
    let query = 'SELECT * FROM compliance_evidence WHERE control_id = $1';
    const values: any[] = [controlId];

    if (framework) {
      query += ' AND framework = $2';
      values.push(framework);
    }

    query += ' ORDER BY collected_at DESC';

    const result = await pool.query(query, values);
    return result.rows.map(this.mapEvidence);
  }

  // Generate access review report
  async generateAccessReview(input: GenerateAccessReviewInput): Promise<AccessReviewReport> {
    // Get all access changes in the period
    const changesResult = await pool.query(
      `SELECT * FROM production_access_audit
       WHERE timestamp >= $1 AND timestamp <= $2
         AND event_type IN ('access_granted', 'access_revoked', 'access_approved')
       ORDER BY timestamp ASC`,
      [input.reviewPeriodStart, input.reviewPeriodEnd]
    );

    const changes: AccessReviewChange[] = changesResult.rows.map(row => ({
      userId: row.user_id,
      userEmail: row.user_email,
      changeType: row.event_type === 'access_revoked' ? 'revoked' : 'granted',
      previousAccess: row.details?.previousAccess || [],
      newAccess: row.details?.newAccess || row.target_resources || [],
      reason: row.details?.reason || '',
      changedBy: row.details?.changedBy || row.user_id,
      changedAt: row.timestamp,
    }));

    // Get total user count
    const userCountResult = await pool.query(
      'SELECT COUNT(DISTINCT user_id) as count FROM production_access_audit WHERE timestamp >= $1 AND timestamp <= $2',
      [input.reviewPeriodStart, input.reviewPeriodEnd]
    );

    const totalUsers = parseInt(userCountResult.rows[0].count);

    // Analyze for findings
    const findings: AccessReviewFinding[] = [];

    // Check for excessive access grants
    const excessiveGrants = changes.filter(c => c.changeType === 'granted' && c.newAccess.length > 5);
    if (excessiveGrants.length > 0) {
      findings.push({
        severity: 'medium',
        description: `${excessiveGrants.length} users were granted access to more than 5 resources`,
        remediation: 'Review and apply least-privilege principle',
      });
    }

    // Check for access without approval
    const unapprovedAccess = changes.filter(c =>
      c.changeType === 'granted' && !changesResult.rows.find(r =>
        r.user_id === c.userId && r.event_type === 'access_approved'
      )
    );
    if (unapprovedAccess.length > 0) {
      findings.push({
        severity: 'high',
        description: `${unapprovedAccess.length} access grants without corresponding approval`,
        remediation: 'Investigate and ensure all access follows approval workflow',
      });
    }

    // Create the report
    const reportResult = await pool.query(
      `INSERT INTO access_review_reports (
        review_period_start, review_period_end, reviewed_by, reviewed_at,
        total_users, users_reviewed, access_changes, findings, status
      ) VALUES ($1, $2, $3, NOW(), $4, $4, $5, $6, 'completed')
      RETURNING *`,
      [
        input.reviewPeriodStart,
        input.reviewPeriodEnd,
        input.reviewedBy,
        totalUsers,
        JSON.stringify(changes),
        JSON.stringify(findings),
      ]
    );

    const report = this.mapAccessReviewReport(reportResult.rows[0]);

    // Auto-collect as evidence
    await this.collectEvidence({
      type: 'access_review',
      framework: 'SOC2',
      controlId: 'CC6',
      title: `Access Review Report ${input.reviewPeriodStart.toISOString().split('T')[0]} to ${input.reviewPeriodEnd.toISOString().split('T')[0]}`,
      description: `Periodic access review covering ${totalUsers} users with ${changes.length} access changes`,
      collectedBy: input.reviewedBy,
      metadata: {
        reportId: report.id,
        totalUsers,
        changesCount: changes.length,
        findingsCount: findings.length,
      },
    });

    log.info('Access review report generated', {
      reportId: report.id,
      totalUsers,
      changesCount: changes.length,
    });

    return report;
  }

  // Record change management
  async recordChange(change: Omit<ChangeManagementRecord, 'id' | 'createdAt' | 'updatedAt' | 'artifacts'>): Promise<ChangeManagementRecord> {
    const result = await pool.query(
      `INSERT INTO change_management_records (
        change_type, title, description, requested_by, requested_at,
        environment, risk_level, rollback_plan, test_evidence, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        change.changeType,
        change.title,
        change.description,
        change.requestedBy,
        change.requestedAt,
        change.environment,
        change.riskLevel,
        change.rollbackPlan,
        change.testEvidence,
        change.status,
      ]
    );

    return this.mapChangeRecord(result.rows[0]);
  }

  // Approve change
  async approveChange(changeId: string, approvedBy: string): Promise<ChangeManagementRecord> {
    const result = await pool.query(
      `UPDATE change_management_records
       SET status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [changeId, approvedBy]
    );

    if (!result.rows[0]) {
      throw new Error('Change record not found');
    }

    return this.mapChangeRecord(result.rows[0]);
  }

  // Implement change
  async implementChange(changeId: string, implementedBy: string): Promise<ChangeManagementRecord> {
    const result = await pool.query(
      `UPDATE change_management_records
       SET status = 'implemented', implemented_by = $2, implemented_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [changeId, implementedBy]
    );

    if (!result.rows[0]) {
      throw new Error('Change record not found');
    }

    return this.mapChangeRecord(result.rows[0]);
  }

  // Verify change
  async verifyChange(changeId: string, verifiedBy: string): Promise<ChangeManagementRecord> {
    const result = await pool.query(
      `UPDATE change_management_records
       SET status = 'verified', verified_by = $2, verified_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [changeId, verifiedBy]
    );

    if (!result.rows[0]) {
      throw new Error('Change record not found');
    }

    const change = this.mapChangeRecord(result.rows[0]);

    // Auto-collect as evidence
    await this.collectEvidence({
      type: 'change_management',
      framework: 'SOC2',
      controlId: 'CC8',
      title: `Change: ${change.title}`,
      description: change.description,
      collectedBy: verifiedBy,
      metadata: {
        changeId: change.id,
        changeType: change.changeType,
        environment: change.environment,
        riskLevel: change.riskLevel,
      },
    });

    return change;
  }

  // Add artifact to change record
  async addChangeArtifact(
    changeId: string,
    artifact: { type: string; reference: string; url?: string; hash?: string }
  ): Promise<void> {
    await pool.query(
      `INSERT INTO change_artifacts (change_id, type, reference, url, hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [changeId, artifact.type, artifact.reference, artifact.url, artifact.hash]
    );
  }

  // Generate audit package
  async generateAuditPackage(input: GenerateAuditPackageInput): Promise<AuditPackage> {
    // Get all evidence for the framework and period
    const evidenceResult = await pool.query(
      `SELECT * FROM compliance_evidence
       WHERE framework = $1
         AND collected_at >= $2
         AND collected_at <= $3
         AND status IN ('collected', 'reviewed', 'approved')
       ORDER BY control_id, collected_at DESC`,
      [input.framework, input.periodStart, input.periodEnd]
    );

    const evidence = evidenceResult.rows.map(this.mapEvidence);

    // Build control summary
    const controlsMap = new Map<string, AuditPackageControl>();
    const controls = input.framework === 'SOC2' ? SOC2_CONTROLS : {};

    for (const [controlId, controlInfo] of Object.entries(controls) as [string, { name: string; category: string }][]) {
      const controlEvidence = evidence.filter(e => e.controlId === controlId);

      controlsMap.set(controlId, {
        controlId,
        controlName: controlInfo.name,
        category: controlInfo.category,
        evidenceCount: controlEvidence.length,
        evidenceIds: controlEvidence.map(e => e.id),
        status: controlEvidence.length >= 2 ? 'complete' :
                controlEvidence.length === 1 ? 'partial' : 'missing',
      });
    }

    const controlsList = Array.from(controlsMap.values());

    // Calculate summary
    const summary: AuditPackageSummary = {
      totalControls: controlsList.length,
      completeControls: controlsList.filter(c => c.status === 'complete').length,
      partialControls: controlsList.filter(c => c.status === 'partial').length,
      missingControls: controlsList.filter(c => c.status === 'missing').length,
      totalEvidence: evidence.length,
      coverage: controlsList.length > 0
        ? Math.round((controlsList.filter(c => c.status !== 'missing').length / controlsList.length) * 100)
        : 0,
    };

    // Create the audit package
    const packageResult = await pool.query(
      `INSERT INTO audit_packages (
        framework, period_start, period_end, generated_by, generated_at,
        status, controls, summary
      ) VALUES ($1, $2, $3, $4, NOW(), 'draft', $5, $6)
      RETURNING *`,
      [
        input.framework,
        input.periodStart,
        input.periodEnd,
        input.generatedBy,
        JSON.stringify(controlsList),
        JSON.stringify(summary),
      ]
    );

    const auditPackage = this.mapAuditPackage(packageResult.rows[0]);

    log.info('Audit package generated', {
      packageId: auditPackage.id,
      framework: input.framework,
      coverage: summary.coverage,
    });

    return auditPackage;
  }

  // Get audit package
  async getAuditPackage(packageId: string): Promise<AuditPackage | null> {
    const result = await pool.query(
      'SELECT * FROM audit_packages WHERE id = $1',
      [packageId]
    );

    return result.rows[0] ? this.mapAuditPackage(result.rows[0]) : null;
  }

  // List audit packages
  async listAuditPackages(framework?: ComplianceFramework): Promise<AuditPackage[]> {
    let query = 'SELECT * FROM audit_packages';
    const values: any[] = [];

    if (framework) {
      query += ' WHERE framework = $1';
      values.push(framework);
    }

    query += ' ORDER BY generated_at DESC';

    const result = await pool.query(query, values);
    return result.rows.map(this.mapAuditPackage);
  }

  // Mark expired evidence
  async processExpiredEvidence(): Promise<number> {
    const result = await pool.query(
      `UPDATE compliance_evidence
       SET status = 'expired', updated_at = NOW()
       WHERE status NOT IN ('expired') AND expires_at < NOW()`
    );

    if ((result.rowCount ?? 0) > 0) {
      log.info('Marked expired evidence', { count: result.rowCount });
    }

    return result.rowCount ?? 0;
  }

  // Get compliance dashboard stats
  async getDashboardStats(framework?: ComplianceFramework): Promise<{
    totalEvidence: number;
    pendingReview: number;
    approved: number;
    expired: number;
    controlCoverage: number;
    recentChanges: number;
  }> {
    const frameworkFilter = framework ? 'AND framework = $1' : '';
    const values = framework ? [framework] : [];

    const evidenceStats = await pool.query(
      `SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'collected') as pending_review,
        COUNT(*) FILTER (WHERE status = 'approved') as approved,
        COUNT(*) FILTER (WHERE status = 'expired') as expired
       FROM compliance_evidence
       WHERE 1=1 ${frameworkFilter}`,
      values
    );

    const controlStats = await pool.query(
      `SELECT COUNT(DISTINCT control_id) as covered_controls
       FROM compliance_evidence
       WHERE status IN ('collected', 'reviewed', 'approved') ${frameworkFilter}`,
      values
    );

    const changeStats = await pool.query(
      `SELECT COUNT(*) as recent_changes
       FROM change_management_records
       WHERE created_at >= NOW() - INTERVAL '30 days'`
    );

    const totalControls = framework === 'SOC2' ? Object.keys(SOC2_CONTROLS).length : 12;

    return {
      totalEvidence: parseInt(evidenceStats.rows[0].total),
      pendingReview: parseInt(evidenceStats.rows[0].pending_review),
      approved: parseInt(evidenceStats.rows[0].approved),
      expired: parseInt(evidenceStats.rows[0].expired),
      controlCoverage: Math.round(
        (parseInt(controlStats.rows[0].covered_controls) / totalControls) * 100
      ),
      recentChanges: parseInt(changeStats.rows[0].recent_changes),
    };
  }

  // Mapping helpers
  private mapEvidence(row: any): EvidenceRecord {
    return {
      id: row.id,
      type: row.type,
      framework: row.framework,
      controlId: row.control_id,
      title: row.title,
      description: row.description,
      status: row.status,
      collectedBy: row.collected_by,
      collectedAt: row.collected_at,
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at,
      approvedBy: row.approved_by,
      approvedAt: row.approved_at,
      expiresAt: row.expires_at,
      artifactPath: row.artifact_path,
      artifactHash: row.artifact_hash,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapAccessReviewReport(row: any): AccessReviewReport {
    return {
      id: row.id,
      reviewPeriodStart: row.review_period_start,
      reviewPeriodEnd: row.review_period_end,
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at,
      totalUsers: row.total_users,
      usersReviewed: row.users_reviewed,
      accessChanges: typeof row.access_changes === 'string'
        ? JSON.parse(row.access_changes)
        : row.access_changes,
      findings: typeof row.findings === 'string'
        ? JSON.parse(row.findings)
        : row.findings,
      status: row.status,
      approvedBy: row.approved_by,
      approvedAt: row.approved_at,
      createdAt: row.created_at,
    };
  }

  private mapChangeRecord(row: any): ChangeManagementRecord {
    return {
      id: row.id,
      changeType: row.change_type,
      title: row.title,
      description: row.description,
      requestedBy: row.requested_by,
      requestedAt: row.requested_at,
      approvedBy: row.approved_by,
      approvedAt: row.approved_at,
      implementedBy: row.implemented_by,
      implementedAt: row.implemented_at,
      environment: row.environment,
      riskLevel: row.risk_level,
      rollbackPlan: row.rollback_plan,
      testEvidence: row.test_evidence,
      status: row.status,
      verifiedBy: row.verified_by,
      verifiedAt: row.verified_at,
      artifacts: [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapAuditPackage(row: any): AuditPackage {
    return {
      id: row.id,
      framework: row.framework,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      generatedBy: row.generated_by,
      generatedAt: row.generated_at,
      status: row.status,
      controls: typeof row.controls === 'string' ? JSON.parse(row.controls) : row.controls,
      summary: typeof row.summary === 'string' ? JSON.parse(row.summary) : row.summary,
      artifactPath: row.artifact_path,
      createdAt: row.created_at,
    };
  }
}
