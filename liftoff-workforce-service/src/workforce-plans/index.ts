import { FastifyInstance } from 'fastify';
import { registerWorkforcePlanRoutes } from './router.js';
import { registerChatRoutes } from './chat-router.js';
import { registerChatStreamRoutes } from './chat-stream-router.js';

export async function registerAllWorkforceRoutes(app: FastifyInstance): Promise<void> {
  await registerWorkforcePlanRoutes(app);
  await registerChatRoutes(app);
  await registerChatStreamRoutes(app);
}
