import express from 'express';
import { config } from './config';
import { logger } from './shared/logger';
import { errorMiddleware } from './shared/error-middleware';
import { eventEmitter } from './shared/event-emitter';
import { authRoutes, authSubrequestRouter } from './auth/routes';
import { shellRoutes } from './shell/routes';
import { fileRoutes } from './file/routes';
import { browserRoutes } from './browser/routes';
import { bashRoutes } from './bash/routes';
import { nodejsRoutes } from './nodejs/routes';
import { codeRoutes } from './code/routes';
import { utilRoutes } from './util/routes';
import { packagesRoutes } from './packages/routes';
import { infoRoutes } from './info/routes';
import { mcpRoutes } from './mcp/routes';
import { proxyRoutes } from './proxy/routes';
import { startForwardProxy } from './proxy/proxy-server';
import { proxyRegistry } from './proxy/registry';
import { runHealthChecks } from './health';
import { ptyManager } from './shell/pty-manager';
import { bashSessionManager } from './bash/session-manager';
import { browserContextRegistry } from './browser/context';
import { watcherRegistry } from './file/watcher';

const main = express();
// express.json only consumes the body when content-type matches JSON; other
// content-types flow through. Skip JSON parsing on /v1/file/upload so the
// upload streamer can read req as a raw stream even if a caller mis-labels
// the request as application/json.
const jsonParser = express.json({ limit: '10mb' });
main.use((req, res, next) => {
  if (req.path === '/v1/file/upload') return next();
  return jsonParser(req, res, next);
});

let shuttingDown = false;

main.use((_req, res, next) => {
  if (shuttingDown) return res.status(503).json({ error: 'sandbox_shutting_down' });
  next();
});

main.get('/health', async (_req, res) => {
  const checks = await runHealthChecks();
  const allHealthy =
    checks.xvfb.healthy &&
    checks.chromium.healthy &&
    checks.vscode.healthy &&
    checks.nginx.healthy &&
    checks.workspace.healthy;
  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'ok' : 'degraded',
    workspace: config.workspaceDir,
    sandboxId: config.sandboxId,
    checks,
  });
});

main.use('/v1/auth', authRoutes);
main.use('/v1/shell', shellRoutes);
main.use('/v1/file', fileRoutes);
main.use('/v1/browser', browserRoutes);
main.use('/v1/bash', bashRoutes);
main.use('/v1/nodejs', nodejsRoutes);
main.use('/v1/code', codeRoutes);
main.use('/v1/util', utilRoutes);
main.use('/v1/sandbox/packages', packagesRoutes);
main.use('/v1/sandbox', infoRoutes);
main.use('/v1/mcp', mcpRoutes);
main.use('/v1/proxy', proxyRoutes);

main.use(errorMiddleware);

const server = main.listen(config.port, () => {
  logger.info({ msg: 'main listening', port: config.port });
});

// Auth subrequest backend on a separate port — nginx hits authbk:8081/auth via X-Original-URI.
const authApp = express();
authApp.use(express.json({ limit: '1mb' }));
authApp.use('/auth', authSubrequestRouter);
authApp.use(errorMiddleware);
const authServer = authApp.listen(config.authPort, () => {
  logger.info({ msg: 'auth backend listening', port: config.authPort });
});

// Forward proxy — Chromium routes all HTTP through 127.0.0.1:8118.
proxyRegistry.load().catch(err => logger.warn({ msg: 'proxy load failed', err: String(err) }));
const proxyServer = startForwardProxy(8118);

process.on('SIGTERM', async () => {
  shuttingDown = true;
  logger.info({ msg: 'SIGTERM received, draining' });
  await eventEmitter.flushAll();
  await browserContextRegistry.closeAll();
  await ptyManager.killAll();
  bashSessionManager.killAll();
  await watcherRegistry.stopAll();
  proxyServer.close();
  authServer.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 25_000);
});
