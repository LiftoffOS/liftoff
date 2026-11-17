export type DataScope = 'tenant' | 'user';

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
