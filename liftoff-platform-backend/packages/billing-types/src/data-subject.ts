// Data-subject access (GDPR Right of Access / CCPA) — shared across
// every service via the pattern defined in Phase 0s. Each service
// implements ExportTenantData + DeleteTenantUserData on the same shape.

export type DataScope = 'tenant' | 'user';

/**
 * Request carries an HMAC signed by the orchestrator with a key shared
 * with each callee. Callees verify signature before streaming records.
 */
export interface ExportTenantDataRequest {
  tenantId: string;
  subjectUserId: string | null;
  scope: DataScope;
  requestedBy: string;
  expiresAt: Date;
  authorizationHmac: Buffer;
}

export interface ExportRecord<T = unknown> {
  recordType: string;
  sequence: bigint;
  record: T;
}

export interface DeleteTenantUserDataRequest {
  tenantId: string;
  subjectUserId: string | null;
  scope: DataScope;
  requestedBy: string;
  expiresAt: Date;
  authorizationHmac: Buffer;
}

export interface DeleteTenantUserDataResult {
  recordsDeleted: bigint;
  recordsPseudonymized: bigint;
  auditReceiptId: string;
}
