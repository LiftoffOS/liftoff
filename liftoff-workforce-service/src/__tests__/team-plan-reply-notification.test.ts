// Telling somebody the Chief AI Officer answered them.
//
// The team plan is the one chat surface whose messages live in this database
// rather than platform-backend's, so it is the one surface that cannot notify
// in-process. It asks over the internal API instead — and the tests that matter
// are the ones that stop that call being made when it should not be: a person
// watching the reply arrive must not be interrupted, and no failure here may
// reach the turn that already succeeded.

jest.mock('../infrastructure/logging.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockIsAccountPresent = jest.fn();
jest.mock('../workforce-plans/presence-repository.js', () => ({
  isAccountPresent: (...a: unknown[]) => mockIsAccountPresent(...a),
}));

jest.mock('../infrastructure/config.js', () => ({
  loadConfig: () => ({
    PLATFORM_BACKEND_URL: 'https://api.example.com/',
    WORKFORCE_SERVICE_TOKEN: 'token-123',
  }),
}));

const mockAuthHeaders = jest.fn();
jest.mock('../infrastructure/service-auth.js', () => ({
  getServiceAuthHeaders: (...a: unknown[]) => mockAuthHeaders(...a),
}));

import { notifyTeamPlanReply } from '../workforce-plans/reply-notification.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const THREAD = '22222222-2222-2222-2222-222222222222';
const ACCOUNT = '33333333-3333-3333-3333-333333333333';

const fetchMock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  mockIsAccountPresent.mockResolvedValue(false);
  mockAuthHeaders.mockResolvedValue({ Authorization: 'Bearer oidc', 'X-Service-Auth': 'token-123' });
  fetchMock.mockResolvedValue({ ok: true, status: 202 });
  global.fetch = fetchMock as unknown as typeof fetch;
});

function call(overrides: { text?: string; via?: 'mcp' | 'slack' | 'teams' | null } = {}) {
  return notifyTeamPlanReply({
    tenantId: TENANT, accountId: ACCOUNT, threadId: THREAD,
    text: overrides.text ?? 'Here is the plan.',
    ...(overrides.via !== undefined ? { via: overrides.via } : {}),
  });
}

describe('notifyTeamPlanReply', () => {
  it('posts the reply to the internal notify route', async () => {
    await call();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    // The trailing slash on the configured base must not survive into the path.
    expect(url).toBe('https://api.example.com/api/internal/chat-notify/team-plan-reply');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      tenantId: TENANT,
      accountId: ACCOUNT,
      threadId: THREAD,
      text: 'Here is the plan.',
      via: null,
    });
  });

  it('says nothing for a turn that came through a chat workspace: it was answered there', async () => {
    await call({ via: 'slack' });
    await call({ via: 'teams' });
    expect(mockIsAccountPresent).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('carries a coding-tool origin through to the route', async () => {
    await call({ via: 'mcp' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).via).toBe('mcp');
  });

  it('proves it is workforce-service calling', async () => {
    await call();
    expect(mockAuthHeaders).toHaveBeenCalledWith('https://api.example.com', 'token-123');
    expect(fetchMock.mock.calls[0][1].headers['X-Service-Auth']).toBe('token-123');
  });

  // Notifying somebody about a message they are watching arrive is noise, and
  // the fastest way to teach them to turn notifications off. Checking here also
  // means the common case costs no cross-service request at all.
  it('says nothing, and calls nothing, when the reader is on the thread', async () => {
    mockIsAccountPresent.mockResolvedValue(true);
    await call();
    expect(mockIsAccountPresent).toHaveBeenCalledWith(TENANT, THREAD, ACCOUNT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The route caps the body at 4000 characters. Trimming here rather than
  // letting it 400 keeps a long answer notifying instead of failing validation.
  it('trims a long reply to what the route accepts', async () => {
    await call({ text: 'x'.repeat(9000) });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).text).toHaveLength(4000);
  });

  it('sends nothing for an empty reply', async () => {
    await call({ text: '' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The reply is committed before this runs, so nothing here may throw back
  // into the turn that produced it.
  it('never throws when the route rejects the call', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    await expect(call()).resolves.toBeUndefined();
  });

  it('never throws when the call itself fails', async () => {
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(call()).resolves.toBeUndefined();
  });

  it('never throws when the presence read fails', async () => {
    mockIsAccountPresent.mockRejectedValue(new Error('pool exhausted'));
    await expect(call()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
