import 'dotenv/config';
import express from 'express';
import { log } from './infrastructure/logging';
import healthRouter from './routes/health';
import pubsubRouter from './routes/pubsub';
import internalRouter from './routes/internal';

const PORT = parseInt(process.env.PORT ?? '8080', 10);

async function main() {
  // Fail fast: ENVIRONMENT scopes the Pub/Sub subscription name used elsewhere.
  // Unset in production would silently target the dev resources.
  if (!process.env.ENVIRONMENT && process.env.NODE_ENV === 'production') {
    log.error('ENVIRONMENT env var is required in production');
    process.exit(1);
  }

  const app = express();
  // Pub/Sub push bodies wrap the base64-encoded message; a large connector
  // record (e.g. a big document/thread) can exceed express.json()'s 100kb
  // default and get rejected with 413 before the handler runs. Pub/Sub caps a
  // message at 10MB (~13.3MB base64), so allow 15mb to never drop a valid push.
  app.use(express.json({ limit: '15mb' }));
  app.use('/', healthRouter);
  // Scale-to-zero consumption. Instead of always-on streaming-pull subscribers +
  // an in-process GC timer (which required min-instances>=1 to survive), the
  // service now wakes on demand:
  //   - Pub/Sub PUSH delivers each event to /pubsub/* (Cloud Run wakes, processes
  //     one message, scales back to zero when idle).
  //   - Cloud Scheduler hits /internal/dedup-gc hourly.
  app.use('/pubsub', pubsubRouter);
  app.use('/internal', internalRouter);

  const server = app.listen(PORT, () => {
    log.info({ port: PORT }, 'liftoff-harvest-service starting (push mode)');
  });

  const shutdown = (signal: string) => {
    log.info({ signal }, 'shutdown signal received');
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main().catch((err) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
