// Auth API contract types
// Bearer JWT + single-use ticket flow for browser-iframe consumers (VSCode, noVNC, CDP).

export type AuthTicketPurpose = 'vscode' | 'vnc' | 'cdp';

export interface TicketCreateRequest {
  purpose: AuthTicketPurpose;
  ttl_seconds?: number;
}

export interface TicketCreateResponse {
  ticket: string;
  expires_at: string;
}

export interface AuthRequest {
  authorization?: string;
  original_uri?: string;
}

export interface SandboxJwtClaims {
  sandboxId: string;
  tenantId: string;
  agentId: string;
  instructionVersion: number;
  scope?: string;
  scopes?: string[];
  exp: number;
  iat?: number;
}
