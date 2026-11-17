// Dynamic Quota Service — Phase 2 entitlements rework
// Capacity-based quota adjustments removed. Only abuse detection survives,
// re-wired as alerting (not throttling). credential_enumeration still suspends
// via kill switch.

import { pool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

export type AbuseAction = 'none' | 'alert' | 'suspend';

export interface AbuseDetectionResult {
  isAbusive: boolean;
  patterns: string[];
  recommendedAction: AbuseAction;
}

export class DynamicQuotaService {
  // Detect potential abuse patterns.
  // credential_enumeration → suspend via kill switch
  // rapid_action_burst, high_failure_rate → alert only
  async detectAbusePatterns(tenantId: string): Promise<AbuseDetectionResult> {
    const patterns: string[] = [];

    // Check for rapid action bursts
    const burstResult = await pool.query(
      `SELECT COUNT(*) as count
       FROM actions
       WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '10 seconds'`,
      [tenantId]
    );
    if (parseInt(burstResult.rows[0].count) > 50) {
      patterns.push('rapid_action_burst');
    }

    // Check for repeated failures
    const failureResult = await pool.query(
      `SELECT COUNT(*) as count
       FROM actions
       WHERE tenant_id = $1
         AND status = 'failed'
         AND created_at > NOW() - INTERVAL '5 minutes'`,
      [tenantId]
    );
    const failureRate = parseInt(failureResult.rows[0].count);
    if (failureRate > 100) {
      patterns.push('high_failure_rate');
    }

    // Check for credential enumeration attempts
    const authFailures = await pool.query(
      `SELECT COUNT(*) as count
       FROM connector_auth_attempts
       WHERE tenant_id = $1
         AND success = false
         AND attempted_at > NOW() - INTERVAL '5 minutes'`,
      [tenantId]
    );
    if (parseInt(authFailures.rows[0].count) > 20) {
      patterns.push('credential_enumeration');
    }

    const isAbusive = patterns.length > 0;
    let recommendedAction: AbuseAction = 'none';

    if (patterns.includes('credential_enumeration')) {
      // credential_enumeration: still suspend via kill switch
      recommendedAction = 'suspend';
    } else if (isAbusive) {
      // rapid_action_burst, high_failure_rate: alert only (no throttle)
      recommendedAction = 'alert';
    }

    if (isAbusive) {
      logger.warn('Abuse patterns detected', {
        tenantId,
        patterns,
        recommendedAction,
      });
    }

    return { isAbusive, patterns, recommendedAction };
  }
}

export const dynamicQuotaService = new DynamicQuotaService();
