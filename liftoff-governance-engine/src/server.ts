// HTTP server for GovernanceEngine.
//
// Mount order matters:
//   1. request-id / logging middleware
//   2. /health — public, for Cloud Run startup + load-balancer health checks
//   3. verifyServiceAuth — rejects any request without a valid X-Service-Auth
//      matching GOVERNANCE_SERVICE_TOKEN (constant-time compare)
//   4. expressConnectMiddleware — mounts every Connect-RPC route defined
//      in src/rpc/router.ts at its proto-derived path (e.g.
//      /liftoff.governance.v1.GovernanceService/Authorize)
//   5. 404 fallback — anything else

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { verifyServiceAuth } from '@liftoffos/service-client';
import { expressConnectMiddleware } from '@connectrpc/connect-express';
import type { Logger } from '@liftoffos/telemetry';
import registerGovernanceService from './rpc/router.js';
import { approvalsRouter } from './hitl-enforcement/approvals-router.js';
import { lateFeedbackRouter } from './hitl-enforcement/late-feedback-router.js';
import { actionLedgerRouter } from './action-ledger/router.js';
import { actionTrustRouter } from './action-trust/router.js';
import { calibrationRouter } from './calibration/router.js';
import { usageLedgerRouter } from './usage-ledger/router.js';
import { auditRouter } from './audit/router.js';
import { collabSkillRouter } from './collab-skill/router.js';
import { debugRouter } from './debug/router.js';

export interface ServerOptions {
  port: number;
  log: Logger;
}

export function buildApp(opts: ServerOptions): Express {
  const app = express();

  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { log: Logger }).log = opts.log.child({
      request_id: (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
      method: req.method,
      path: req.path,
    });
    next();
  });

  // Public health endpoint — Cloud Run startup probe + load balancer.
  // Must be mounted BEFORE verifyServiceAuth so the probe doesn't need the
  // service token to succeed.
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'governance-engine',
      version: process.env.SERVICE_VERSION ?? '0.1.0',
      commit: process.env.COMMIT_SHA ?? 'unknown',
    });
  });

  // Everything below requires X-Service-Auth matching GOVERNANCE_SERVICE_TOKEN.
  // Naming note: the env var is GOVERNANCE_SERVICE_TOKEN (plan convention for the
  // "governance service" name), even though the Secret Manager resource behind
  // it is still `governance-engine-token` for historical reasons.
  app.use(verifyServiceAuth({ tokenEnvVar: 'GOVERNANCE_SERVICE_TOKEN' }));

  // Connect-RPC handlers. expressConnectMiddleware parses the request body
  // itself (supports connect+json, connect+proto, gRPC-Web) so we do NOT
  // add express.json() on the connect path — that would consume the body
  // first and break Connect parsing. JSON parsing is scoped to the REST
  // routers mounted below via a sub-router.
  app.use(
    expressConnectMiddleware({
      routes: registerGovernanceService,
    }),
  );

  // REST routers — JSON body parsing applied locally so we don't interfere
  // with Connect-RPC handlers above.
  //
  // `late-feedback` is mounted as a top-level path under /api/governance
  // (NOT nested under /approvals) per Phase 3 plan — the late-feedback
  // surface is conceptually separate from the interactive approval queue
  // and Platform Backend posts to /api/governance/late-feedback directly.
  const rest = express.Router();
  rest.use(express.json({ limit: '1mb' }));
  rest.use('/late-feedback', lateFeedbackRouter);
  rest.use('/approvals', approvalsRouter);
  rest.use('/actions', actionLedgerRouter);
  // Shadow substrate: GET / trust-ledger rollup read consulted by tenant-runtime later
  // (touches no gate) + POST /decisions ingestion from PB/TR. See src/action-trust.
  rest.use('/action-trust', actionTrustRouter);
  rest.use('/calibration', calibrationRouter);
  rest.use('/usage', usageLedgerRouter);
  rest.use('/audit', auditRouter);
  // Shadow substrate: read-only CollabSkill posteriors. See src/collab-skill.
  rest.use('/collab-skill', collabSkillRouter);
  app.use('/api/governance', rest);

  // Debug endpoints — health + simulate (service-token-gated, operator-only).
  // Mounted directly on app (not inside `rest`) so they get their own
  // express.json() parsing instance and don't share the 1 mb limit.
  app.use('/api/governance', express.json(), debugRouter);

  app.use((req, res) => {
    const r = req as Request & { log?: Logger };
    r.log?.warn({}, 'route not found');
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  return app;
}

export async function startServer(opts: ServerOptions): Promise<http.Server> {
  const app = buildApp(opts);
  return new Promise<http.Server>((resolve, reject) => {
    const server = app.listen(opts.port, () => {
      opts.log.info({ port: opts.port }, 'HTTP server listening');
      resolve(server);
    });
    server.on('error', reject);
  });
}

export async function shutdownServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
