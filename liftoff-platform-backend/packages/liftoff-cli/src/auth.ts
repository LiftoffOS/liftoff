// Browser-based login flow with PKCE (RFC 7636)
// Opens browser → Liftoff login → workspace selection → localhost callback
// Uses Firebase ID token directly (BE-003 fix — no custom session token)
// PKCE ensures the callback can only be used by the CLI that initiated the flow

import http from 'http';
import crypto from 'crypto';
import open from 'open';

const LIFTOFF_APP_URL = process.env.LIFTOFF_APP_URL || 'https://example.com';

export interface AuthResult {
  firebaseToken: string;
  tenantId: string;
  setupToken?: string;
  codeVerifier: string;
}

// PKCE: generate code_verifier (random 43-128 char string) and code_challenge (SHA-256 hash)
function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

export async function browserAuth(
  opts: { mode?: 'collab'; client?: 'claude' | 'codex' } = {},
): Promise<AuthResult> {
  const { mode } = opts;
  const client = opts.client ?? 'claude';
  // The success page lives at a per-client URL, but shares one component.
  const successPath = client === 'codex' ? 'codex' : 'claudecode';
  const state = crypto.randomBytes(16).toString('hex');
  const { codeVerifier, codeChallenge } = generatePKCE();

  return new Promise((resolve, reject) => {
    // 1. Bind localhost server FIRST (eliminates TOCTOU race — SE-004 fix)
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }

      const token = url.searchParams.get('token');
      const tenantId = url.searchParams.get('tenantId');
      const returnedState = url.searchParams.get('state');
      const setupToken = url.searchParams.get('setupToken');

      // Validate CSRF nonce
      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Authentication failed</h2><p>Invalid state parameter. Please try again.</p></body></html>');
        server.close();
        reject(new Error('CSRF validation failed: state mismatch'));
        return;
      }

      if (!token || !tenantId) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Authentication failed</h2><p>Missing token or tenant. Please try again.</p></body></html>');
        server.close();
        reject(new Error('Missing token or tenantId in callback'));
        return;
      }

      // Success — redirect to the styled, client-specific dashboard success page
      res.writeHead(302, { Location: `${LIFTOFF_APP_URL}/dashboard/agents/${successPath}/success` });
      res.end();
      server.close();
      resolve({
        firebaseToken: token,
        tenantId,
        setupToken: setupToken || undefined,
        codeVerifier,
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind localhost server'));
        return;
      }

      const port = address.port;

      // 2. Open browser with port + state nonce + PKCE code_challenge
      const modeParam = mode ? `&mode=${mode}` : '';
      const authUrl = `${LIFTOFF_APP_URL}/login?redirect=/cli-auth&port=${port}&state=${state}&code_challenge=${codeChallenge}&client=${client}${modeParam}`;
      console.log(`\nOpening browser for authentication...`);
      console.log(`If the browser doesn't open, visit: ${authUrl}\n`);
      open(authUrl).catch(() => {
        // If open fails, user can copy the URL manually
      });
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Authentication timed out. Please try again.'));
    }, 5 * 60 * 1000);
  });
}
