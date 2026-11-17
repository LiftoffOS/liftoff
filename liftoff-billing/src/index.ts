// Entry point.
import { start } from './server.js';

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('liftoff-billing startup failed', err);
  process.exit(1);
});
