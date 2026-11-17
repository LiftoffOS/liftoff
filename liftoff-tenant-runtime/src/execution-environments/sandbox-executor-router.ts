// HTTP surface for the dedicated sandbox-executor Cloud Run service.

import { Router, Request, Response } from 'express';
import { log } from '../infrastructure/logging';
import { mintRuntimeOidc } from '../infrastructure/oidc';
import { requireServiceAuth } from '../security/service-auth';
import { createExecutionEnvironmentsRouter } from './router';
import type { SandboxExecutor, SandboxSession, SandboxToolCallInput, SandboxToolCallResult } from './sandbox-executor';

/**
 * Headers Express adds that must NOT be forwarded — hop-by-hop or
 * connection-scoped per RFC 7230, plus host (the upstream sets its own).
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

function buildForwardHeaders(req: Request, oidc: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lk = key.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    // The inbound Authorization carries the per-sandbox HS256 JWT. The backend
    // (tool-gateway / agent-service) is --no-allow-unauthenticated, so its Cloud
    // Run frontend verifies Authorization as a *Google* token and 401s a sandbox
    // JWT. Reserve Authorization for the freshly minted backend OIDC (below) and
    // relay the sandbox JWT in X-Sandbox-Token, which requireSandboxJwt reads.
    // Drop any inbound X-Serverless-Authorization too (its audience was this
    // service, not the backend) so it can't shadow the real credential.
    if (lk === 'authorization' || lk === 'x-serverless-authorization' || lk === 'x-sandbox-token') continue;
    out[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  const inboundAuth = req.headers['authorization'];
  if (inboundAuth) out['X-Sandbox-Token'] = Array.isArray(inboundAuth) ? inboundAuth[0] : String(inboundAuth);
  if (oidc) out['Authorization'] = `Bearer ${oidc}`;
  return out;
}

async function proxyToBackend(req: Request, res: Response, backendUrl: string, backendPath: string): Promise<void> {
  if (!backendUrl) {
    res.status(503).json({ error: 'backend_unconfigured' });
    return;
  }
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  const targetUrl = `${backendUrl}${backendPath}${qs}`;
  const oidc = await mintRuntimeOidc(backendUrl);
  const headers = buildForwardHeaders(req, oidc);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      if (!HOP_BY_HOP.has(k.toLowerCase())) res.setHeader(k, v);
    });
    res.send(await upstream.text());
  } catch (err) {
    log.warn({ message: 'sandbox-executor proxy failed', target: targetUrl, error: (err as Error).message });
    res.status(502).json({ error: 'proxy_failed', message: (err as Error).message });
  }
}

interface SandboxExecutorRouterDeps {
  executor: SandboxExecutor;
  /** Own Cloud Run URL — required, used as the OIDC audience callers must mint against. */
  sandboxExecutorUrl: string;
  /** Allow-list of caller SAs whose OIDC tokens may invoke the OIDC-gated routes. */
  allowedCallerSas: () => string[];
  /** Peer URLs for sidecar-callback proxy routes. */
  agentServiceUrl: string;
  toolGatewayServiceUrl: string;
}

export function createSandboxExecutorRouter(deps: SandboxExecutorRouterDeps): Router {
  const router = Router();

  // Fail closed when the audience env hasn't landed yet (placeholder on
  // first-ever deploy, before patch-split-service-urls runs). The OIDC-gated
  // routes refuse traffic; the sidecar-callback proxies still work because
  // they're gated by the sandbox-JWT at the backend.
  const audienceConfigured = deps.sandboxExecutorUrl
    && !deps.sandboxExecutorUrl.startsWith('placeholder://');

  const oidcGate = audienceConfigured
    ? requireServiceAuth({
        acceptOidc: true,
        oidcAudience: deps.sandboxExecutorUrl,
        allowedOidcEmails: deps.allowedCallerSas,
      })
    : (_req: Request, res: Response): void => {
        res.status(503).json({ error: 'oidc_audience_unconfigured' });
      };

  router.post('/v2/execute', oidcGate, async (req: Request, res: Response) => {
    const body = req.body as { session?: SandboxSession; toolCall?: SandboxToolCallInput };
    if (!body?.session || !body?.toolCall) {
      res.status(400).json({ success: false, error: 'missing_session_or_toolCall' });
      return;
    }
    try {
      const result: SandboxToolCallResult = await deps.executor.execute(body.session, body.toolCall);
      res.json(result);
    } catch (err) {
      log.error({ message: '/v2/execute failed', error: (err as Error).message });
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.use('/api/v1/execution-environments', oidcGate, createExecutionEnvironmentsRouter(deps.executor));

  // Sidecar callbacks: app-level auth is the sandbox-JWT, validated by the
  // backend services. The proxy minted OIDC token attached to
  // X-Serverless-Authorization is consumed by the backend's Cloud Run
  // frontend and never reaches the backend container.
  router.post('/internal/sandbox/events', (req, res) => proxyToBackend(req, res, deps.agentServiceUrl, '/internal/sandbox/events'));
  router.get('/internal/sandbox/mcp/tools', (req, res) => proxyToBackend(req, res, deps.toolGatewayServiceUrl, '/internal/sandbox/mcp/tools'));
  router.post('/internal/sandbox/mcp/dispatch', (req, res) => proxyToBackend(req, res, deps.toolGatewayServiceUrl, '/internal/sandbox/mcp/dispatch'));
  router.post('/internal/sandbox/mcp/await-approval', (req, res) => proxyToBackend(req, res, deps.toolGatewayServiceUrl, '/internal/sandbox/mcp/await-approval'));

  return router;
}
