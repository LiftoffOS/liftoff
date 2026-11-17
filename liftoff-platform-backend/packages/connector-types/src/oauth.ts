// OAuth flow types for the connector service.
// Covers static OAuth (pre-registered client credentials per vendor) and
// Dynamic Client Registration per RFC 7591 (Notion, Linear, Calendly, ...).

export type OAuthFlowKind =
  | 'static'
  | 'dynamic_client_registration'
  | 'api_key'
  | 'keypair'
  | 'none';

export interface OAuthCredentials {
  /** Access token (short-lived). */
  accessToken: string;
  /** Optional refresh token (for long-lived connectors). */
  refreshToken?: string;
  /** Token-endpoint expiry seconds since epoch. */
  expiresAtEpochSec?: number;
  /** Scopes granted by the token. */
  scopes?: string[];
  /** Vendor-specific extra fields (stripe-style workspace_id, slack team_id, etc). */
  extra?: Record<string, unknown>;
}

export interface ApiKeyCredentials {
  apiKey: string;
  extra?: Record<string, unknown>;
}

export interface KeypairCredentials {
  publicKey: string;
  privateKey: string;
  keyId?: string;
  extra?: Record<string, unknown>;
}

export type CredentialMaterial =
  | ({ kind: 'oauth' } & OAuthCredentials)
  | ({ kind: 'api_key' } & ApiKeyCredentials)
  | ({ kind: 'keypair' } & KeypairCredentials);

/**
 * OAuth Dynamic Client Registration record (platform-level, shared across
 * tenants). Migrated from platform-backend/migrations/125_oauth_dynamic_registrations.sql.
 */
export interface OAuthDynamicRegistration {
  id: string;
  /** Issuer URL (authorization server). */
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  /** Redirect URIs registered with the authorization server. */
  redirectUris: string[];
  /** When the registration was created. */
  createdAt: Date;
  /** Scheduled rotation time; null = never. */
  rotateAfter: Date | null;
}

/**
 * Functional capability groups — callers request `capability`, the connector
 * service resolves to specific connector types + required OAuth scopes.
 */
export type ConnectorCapability =
  | 'email_marketing'
  | 'hris'
  | 'accounting'
  | 'support_ticketing'
  | 'ats'
  | 'crm'
  | 'incident_management'
  | 'error_tracking';

/** A caller's declaration of what a tool / agent needs. */
export type ConnectorRequirement =
  | { connectorType: string }
  | { capability: ConnectorCapability };
