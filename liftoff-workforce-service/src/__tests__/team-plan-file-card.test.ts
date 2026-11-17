/**
 * Showing a file into a Chief AI Officer conversation.
 *
 * The control plane owns the file store and the act of publishing; this
 * service owns the Chief AI Officer's messages, so the card for this surface
 * has to arrive over the wire. What these pin is that the door is a service
 * door: the token is checked before anything is parsed or read, so a caller
 * without it learns nothing — not even whether the thread exists — and a
 * thread belonging to another tenant is a miss rather than a card written
 * where it does not belong.
 */
import Fastify from 'fastify';

const getThread = jest.fn();
const appendMessage = jest.fn();

jest.mock('../workforce-plans/chat-repository.js', () => ({
  createTurn: jest.fn(),
  getThread: (...a: unknown[]) => getThread(...a),
  appendMessage: (...a: unknown[]) => appendMessage(...a),
}));
jest.mock('../infrastructure/logging.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../infrastructure/config.js', () => ({
  loadConfig: () => ({ WORKFORCE_SERVICE_TOKEN: 'right-token' }),
}));

import { registerFileCardRoutes } from '../workforce-plans/file-card-router.js';

const TENANT = '00000000-0000-0000-0000-0000000000a1';
const THREAD = '00000000-0000-0000-0000-0000000000c1';

const CARD = {
  generatedFileId: 'file-1',
  filename: 'invoice_v1.pdf',
  outputType: 'pdf',
  version: 1,
  downloadUrl: null,
};


beforeEach(() => {
  jest.clearAllMocks();
  getThread.mockResolvedValue({ id: THREAD });
  appendMessage.mockResolvedValue({ id: 'msg-1' });
});

async function post(body: Record<string, unknown>, token?: string) {
  const app = Fastify();
  await registerFileCardRoutes(app);
  await app.ready();
  const res = await app.inject({
    method: 'POST',
    url: '/internal/team-plan/file-card',
    ...(token ? { headers: { 'x-service-auth': token } } : {}),
    payload: body,
  });
  await app.close();
  return { status: res.statusCode };
}

it('writes the card as a row that is a card rather than speech', async () => {
  const res = await post({ tenantId: TENANT, threadId: THREAD, file: CARD }, 'right-token');

  expect(res.status).toBe(200);
  expect(appendMessage).toHaveBeenCalledWith(expect.objectContaining({
    tenantId: TENANT,
    threadId: THREAD,
    role: 'assistant',
    content: '',
    messageType: 'file_output',
    files: [CARD],
  }));
});

it('refuses without the service token, and reads nothing first', async () => {
  const res = await post({ tenantId: TENANT, threadId: THREAD, file: CARD });

  expect(res.status).toBe(401);
  // Nothing was looked up, so an unauthenticated caller cannot learn whether
  // the thread exists by watching what this does.
  expect(getThread).not.toHaveBeenCalled();
  expect(appendMessage).not.toHaveBeenCalled();
});

it('refuses a wrong token the same way', async () => {
  const res = await post({ tenantId: TENANT, threadId: THREAD, file: CARD }, 'wrong-token');
  expect(res.status).toBe(401);
  expect(getThread).not.toHaveBeenCalled();
});

it('treats a thread of another tenant as absent', async () => {
  getThread.mockResolvedValue(null);
  const res = await post({ tenantId: TENANT, threadId: THREAD, file: CARD }, 'right-token');
  expect(res.status).toBe(404);
  expect(appendMessage).not.toHaveBeenCalled();
});

it('requires downloadUrl to be present, even as null', async () => {
  // The card hides its download button on exactly null and offers to open the
  // file where it lives; an absent key would draw a button over nothing.
  const { downloadUrl: _omitted, ...withoutUrl } = CARD;
  const res = await post({ tenantId: TENANT, threadId: THREAD, file: withoutUrl }, 'right-token');
  expect(res.status).toBe(400);
  expect(appendMessage).not.toHaveBeenCalled();
});

it('refuses a body that is not a card at all', async () => {
  const res = await post({ tenantId: TENANT, threadId: 'not-a-uuid', file: CARD }, 'right-token');
  expect(res.status).toBe(400);
  expect(appendMessage).not.toHaveBeenCalled();
});
