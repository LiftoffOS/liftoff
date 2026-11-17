import { start } from './server.js';

start().catch((err) => {
  console.error('liftoff-developer-proxy startup failed', err);
  process.exit(1);
});
