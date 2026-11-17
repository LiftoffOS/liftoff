// Tests for bot-token-service. Covers:
//   - secret-id naming convention (short, deterministic, collision-resistant)
//   - storeWorkspaceBotToken: createSecret + addSecretVersion + ALREADY_EXISTS handling
//   - readBotTokenFromSecretManager: cache hit + miss
//   - resolveWorkspaceBotToken: reads from Secret Manager; null on failure / missing path
//
// Secret Manager is fully mocked.

import { jest } from '@jest/globals';

const accessSecretVersionMock = jest.fn<() => Promise<unknown>>();
const createSecretMock = jest.fn<() => Promise<unknown>>();
const addSecretVersionMock = jest.fn<() => Promise<unknown>>();

jest.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: jest.fn().mockImplementation(() => ({
    accessSecretVersion: accessSecretVersionMock,
    createSecret: createSecretMock,
    addSecretVersion: addSecretVersionMock,
  })),
}));

jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GCP_PROJECT_ID = 'test-project';
});

describe('buildWorkspaceSecretId (one token per tenant+workspace)', () => {
  it('truncates UUIDs to 12 chars and embeds slack team id verbatim', async () => {
    const { buildWorkspaceSecretId } = await import('../bot-token-service');
    const id = buildWorkspaceSecretId(
      'dd7d80bd-3b77-4677-817c-053fdb8668cd',
      'T0ABC123',
    );
    expect(id).toBe('slack-ws-bot-dd7d80bd3b77-T0ABC123');
  });
});

describe('storeWorkspaceBotToken', () => {
  it('creates the secret container then adds a version and returns the latest path', async () => {
    addSecretVersionMock.mockResolvedValueOnce([
      { name: 'projects/test-project/secrets/slack-bot-aa-bb-T1/versions/3' },
    ]);

    const { storeWorkspaceBotToken, _clearBotTokenCache } = await import('../bot-token-service');
    _clearBotTokenCache();
    const path = await storeWorkspaceBotToken(
      '00000000-0000-0000-0000-000000000aaa',
      'T1',
      'xoxb-test',
    );

    expect(createSecretMock).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: 'projects/test-project',
        secretId: 'slack-ws-bot-000000000000-T1',
      }),
    );
    expect(addSecretVersionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: 'projects/test-project/secrets/slack-ws-bot-000000000000-T1',
        payload: { data: Buffer.from('xoxb-test', 'utf-8') },
      }),
    );
    expect(path).toBe(
      'projects/test-project/secrets/slack-ws-bot-000000000000-T1/versions/latest',
    );
  });

  it('swallows ALREADY_EXISTS on createSecret and still adds a new version', async () => {
    createSecretMock.mockRejectedValueOnce(Object.assign(new Error('exists'), { code: 6 }));
    addSecretVersionMock.mockResolvedValueOnce([{ name: 'projects/test-project/secrets/y/versions/4' }]);

    const { storeWorkspaceBotToken } = await import('../bot-token-service');
    await expect(
      storeWorkspaceBotToken('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'T2', 'xoxb-new'),
    ).resolves.toMatch(/\/versions\/latest$/);
    expect(addSecretVersionMock).toHaveBeenCalled();
  });

  it('throws on non-AlreadyExists createSecret errors', async () => {
    createSecretMock.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 7 }));
    const { storeWorkspaceBotToken } = await import('../bot-token-service');
    await expect(
      storeWorkspaceBotToken('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'T3', 'x'),
    ).rejects.toThrow(/Failed to create Secret Manager secret/);
  });
});

describe('readBotTokenFromSecretManager', () => {
  it('returns the payload string on first read and caches on second', async () => {
    accessSecretVersionMock.mockResolvedValueOnce([
      { payload: { data: Buffer.from('xoxb-cached') } },
    ]);
    const { readBotTokenFromSecretManager, _clearBotTokenCache } =
      await import('../bot-token-service');
    _clearBotTokenCache();
    const path = 'projects/test-project/secrets/slack-bot-x/versions/latest';
    const a = await readBotTokenFromSecretManager(path);
    const b = await readBotTokenFromSecretManager(path);
    expect(a).toBe('xoxb-cached');
    expect(b).toBe('xoxb-cached');
    expect(accessSecretVersionMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a bare secret id and resolves to /versions/latest', async () => {
    accessSecretVersionMock.mockResolvedValueOnce([
      { payload: { data: Buffer.from('xoxb-bare') } },
    ]);
    const { readBotTokenFromSecretManager, _clearBotTokenCache } =
      await import('../bot-token-service');
    _clearBotTokenCache();
    const v = await readBotTokenFromSecretManager('slack-bot-only-id');
    expect(v).toBe('xoxb-bare');
    expect(accessSecretVersionMock).toHaveBeenCalledWith({
      name: 'projects/test-project/secrets/slack-bot-only-id/versions/latest',
    });
  });
});

describe('resolveWorkspaceBotToken', () => {
  const baseInput = {
    tenantId: '11111111-1111-1111-1111-111111111111',
    agentId: '22222222-2222-2222-2222-222222222222',
    slackTeamId: 'T9',
    installId: '99999999-9999-9999-9999-999999999999',
  };

  it('reads from the Secret Manager path', async () => {
    accessSecretVersionMock.mockResolvedValueOnce([
      { payload: { data: Buffer.from('xoxb-from-sm') } },
    ]);
    const { resolveWorkspaceBotToken, _clearBotTokenCache } =
      await import('../bot-token-service');
    _clearBotTokenCache();
    const tok = await resolveWorkspaceBotToken({
      ...baseInput,
      slackBotTokenSecretPath: 'projects/test-project/secrets/slack-bot-aa/versions/latest',
    });
    expect(tok).toBe('xoxb-from-sm');
  });

  it('returns null on SM read failure', async () => {
    accessSecretVersionMock.mockRejectedValueOnce(new Error('NotFound'));
    const { resolveWorkspaceBotToken, _clearBotTokenCache } =
      await import('../bot-token-service');
    _clearBotTokenCache();
    const tok = await resolveWorkspaceBotToken({
      ...baseInput,
      slackBotTokenSecretPath: 'projects/test-project/secrets/x/versions/latest',
    });
    expect(tok).toBeNull();
  });

  it('returns null when slackBotTokenSecretPath is null (revoked / broken install)', async () => {
    const { resolveWorkspaceBotToken } = await import('../bot-token-service');
    const tok = await resolveWorkspaceBotToken({
      ...baseInput,
      slackBotTokenSecretPath: null,
    });
    expect(tok).toBeNull();
    expect(accessSecretVersionMock).not.toHaveBeenCalled();
  });
});
