// The Chief AI Officer's own stream names its work in the person's terms.
//
// Every other chat surface gets this from platform-backend, which authors the
// phrase and attaches it to the frame it writes. This stream never passes
// through one of those writers: it reaches the browser through platform-backend's
// /api/team-plan proxy, which pipes the response body and cannot rewrite a frame.
// So this router attaches its own, from the SAME map
// (@liftoffos/shared-types/tool-activity-label), and the map is shared precisely
// so `team__get_config` cannot read one way here and another way in a Liftoff
// thread.
//
// Before the label existed the browser derived one from the tool's name and
// showed a person "Using Get_config".

jest.mock('../workforce-plans/chat-repository.js', () => ({
  createTurn: jest.fn(),
  getThread: jest.fn(),
  appendMessage: jest.fn(),
}));

jest.mock('../workforce-plans/chat-service.js', () => ({
  runCAIOChatTurn: jest.fn(),
}));

jest.mock('../workforce-plans/audit-log.js', () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../workforce-plans/turn-signal-repository.js', () => ({
  findLiveTurnId: jest.fn(),
  deliverUserMessage: jest.fn(),
}));

jest.mock('../workforce-plans/rate-limiter.js', () => ({
  checkAndIncrementTeamPlanRateLimit: jest.fn(),
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { appendMessage, getThread } from '../workforce-plans/chat-repository.js';
import { runCAIOChatTurn } from '../workforce-plans/chat-service.js';
import { findLiveTurnId } from '../workforce-plans/turn-signal-repository.js';
import { checkAndIncrementTeamPlanRateLimit } from '../workforce-plans/rate-limiter.js';
import { registerChatStreamRoutes } from '../workforce-plans/chat-stream-router.js';

const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';

const authHeaders = {
  'x-tenant-id': TENANT_ID,
  'x-account-id': ACCOUNT_ID,
  'x-tenant-role': 'member',
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerChatStreamRoutes(app);
  await app.ready();
  return app;
}

beforeEach(() => {
  (getThread as jest.Mock).mockReset().mockResolvedValue({ id: THREAD_ID });
  (appendMessage as jest.Mock).mockReset().mockResolvedValue({ id: 'message-1' });
  (findLiveTurnId as jest.Mock).mockReset().mockResolvedValue(null);
  (checkAndIncrementTeamPlanRateLimit as jest.Mock).mockReset().mockResolvedValue({ allowed: true });
});

async function framesFor(tools: string[]): Promise<string> {
  (runCAIOChatTurn as jest.Mock).mockReset().mockImplementation(async function* () {
    for (const tool of tools) yield { type: 'tool_call', tool };
    yield { type: 'complete', message: null };
  });
  const app = await buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/team-plan/chat-stream',
    headers: authHeaders,
    payload: { threadId: THREAD_ID, content: 'read the Watches team' },
  });
  return res.payload;
}

it('carries the authored phrase beside the tool name', async () => {
  const payload = await framesFor(['team__get_config', 'workforce_plan__draft']);
  expect(payload).toContain('event: tool_call\ndata: {"tool":"team__get_config","label":"Reading the agent"}');
  expect(payload).toContain('event: tool_call\ndata: {"tool":"workforce_plan__draft","label":"Drafting the plan"}');
});

it('sends a phrase that says nothing rather than a name it does not know', async () => {
  const payload = await framesFor(['some_future__get_config']);
  expect(payload).toContain('"label":"Working on it"');
  // The name still travels, because the browser matches on it; it is simply
  // never the thing a person is shown.
  expect(payload).toContain('"tool":"some_future__get_config"');
});
