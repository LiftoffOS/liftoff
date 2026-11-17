// HTTP client for Liftoff platform API

const API_BASE_URL = process.env.LIFTOFF_API_URL || 'https://api.example.com';

export interface CreateKeyResponse {
  id: string;
  key: string;
  keyPrefix: string;
  keyHint: string;
  name: string;
  setupInstructions: {
    baseUrl: string;
    envCommand: string;
  };
}

export async function createProxyKey(
  firebaseToken: string,
  tenantId: string,
  anthropicApiKey: string,
): Promise<CreateKeyResponse> {
  const res = await fetch(`${API_BASE_URL}/api/claude-code-proxy/keys`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${firebaseToken}`,
    },
    body: JSON.stringify({ tenantId, anthropicApiKey }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(error.error || `Request failed: ${res.status}`);
  }

  return res.json();
}

export interface SetupExchangeResponse {
  proxyKey: string;
  baseUrl: string;
  tokenId?: string;  // Set for liftoff_mcp_* tokens, used by collab command for revocation
}

export async function exchangeSetupToken(
  firebaseToken: string,
  setupToken: string,
  codeVerifier: string,
): Promise<SetupExchangeResponse> {
  const res = await fetch(`${API_BASE_URL}/api/claude-code-proxy/setup-exchange`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${firebaseToken}`,
    },
    body: JSON.stringify({ setupToken, codeVerifier }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(error.error || `Setup exchange failed: ${res.status}`);
  }

  return res.json();
}

export async function revokeProxyKey(proxyApiKey: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/proxy/v1/revoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': proxyApiKey,
    },
    body: JSON.stringify({ confirm: true }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(error.error?.message || error.error || `Revoke failed: ${res.status}`);
  }
}

// ── MCP token management ───────────────────────────────────────────────

export interface CreateMcpTokenResponse {
  id: string;
  setupToken: string;
  proxyBaseUrl: string;
}

export async function createMcpToken(
  firebaseToken: string,
  tenantId: string,
): Promise<CreateMcpTokenResponse> {
  const res = await fetch(`${API_BASE_URL}/api/claude-code-proxy/mcp-tokens`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${firebaseToken}`,
    },
    body: JSON.stringify({ tenantId }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(error.error || `MCP token creation failed: ${res.status}`);
  }

  return res.json();
}

export async function revokeMcpToken(
  bearerToken: string,
  tokenId: string,
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/claude-code-proxy/mcp-tokens/${tokenId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${bearerToken}`,
    },
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(error.error || `MCP token revoke failed: ${res.status}`);
  }
}
