// Pending OAuth integrations awaited by a plan mid-provisioning. OAuth
// state carries HMAC(plan_id || tenant_id || user_id || nonce) for
// single-use callback binding (Phase 3c).

export type PendingIntegrationStatus =
  | 'awaiting_user_consent'
  | 'callback_received'
  | 'completed'
  | 'canceled'
  | 'expired';

export interface PlanPendingIntegration {
  id: string;
  tenantId: string;
  planId: string;
  runStepId: string;
  userId: string;
  connectorType: string;
  /** HMAC payload — server-side secret signs (planId || tenantId || userId || nonce). */
  stateHmac: string;
  nonce: string;
  status: PendingIntegrationStatus;
  createdAt: Date;
  completedAt: Date | null;
  expiresAt: Date;
}

export interface OAuthCallbackValidationResult {
  valid: boolean;
  reason:
    | 'state_signature_invalid'
    | 'state_expired'
    | 'state_already_consumed'
    | 'plan_state_invalid'
    | 'user_mismatch'
    | null;
  pendingIntegrationId: string | null;
}
