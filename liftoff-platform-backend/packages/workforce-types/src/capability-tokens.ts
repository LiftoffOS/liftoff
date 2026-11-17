// Tenant-scoped capability tokens minted by platform-backend and
// consumed by HRBP (workforce-service) + connector-service. One-use
// per step; burned on consumption. See Phase 3c.

export type CapabilityScope =
  | 'agent-template.create'
  | 'agent-template.update'
  | 'agent-template.delete'
  | 'connector.initiate_oauth'
  | 'connector.execute';

export interface CapabilityTokenClaims {
  tokenId: string;
  tenantId: string;
  planId: string;
  /**
   * User who committed the plan — HRBP's actions are attributed to this
   * identity in the audit log even though HRBP runs on a platform SA.
   */
  userId: string;
  /** Exact resources the token may mutate. */
  scopeList: ScopedResource[];
  issuedAt: Date;
  expiresAt: Date;
}

export interface ScopedResource {
  scope: CapabilityScope;
  /**
   * Opaque resource reference — interpretation is per-scope. For
   * agent-template.* it's the intended template ID; for connector.*
   * it's the connector type name.
   */
  resourceRef: string;
}

export interface CapabilityTokenLedgerEntry {
  tokenId: string;
  tenantId: string;
  planId: string;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  consumedBy: string | null;
  scopeList: ScopedResource[];
  revokedAt: Date | null;
  revocationReason: string | null;
}

export interface CapabilityTokenValidationResult {
  valid: boolean;
  /** Populated when valid === false. */
  reason:
    | 'expired'
    | 'revoked'
    | 'already_consumed'
    | 'signature_invalid'
    | 'scope_mismatch'
    | 'caller_sa_mismatch'
    | null;
}
