// The settings a person changes from their coding tool.
//
// Two properties carry the weight here. The AI provider goes through the
// existing workspace actions rather than a second implementation, so the role
// rule and the preview → confirm handshake cannot differ by surface — and an AI
// team set to the workspace's own provider FOLLOWS the workspace rather than
// pinning the same value twice. The notification write reads before it writes,
// because the store's jsonb merge replaces a top-level key wholesale: a partial
// object would turn off settings nobody touched, and browser delivery — which
// only a browser can turn on — is the one it would silently destroy.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

const mockDispatch = jest.fn();
jest.mock('../../workspace-actions/tools', () => ({
  dispatchWorkspaceAction: (...a: unknown[]) => mockDispatch(...a),
}));
const mockGetAiVendor = jest.fn();
jest.mock('../../workspace-actions/workspace', () => ({
  getAiVendor: (...a: unknown[]) => mockGetAiVendor(...a),
}));
const mockGetProviderKeys = jest.fn();
jest.mock('../../tenant-ai-provider-keys/service', () => ({
  getProviderKeys: (...a: unknown[]) => mockGetProviderKeys(...a),
}));
const mockAccounts = { getById: jest.fn(), update: jest.fn() };
jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => mockAccounts),
}));

import {
  getAiProvider,
  setAiProvider,
  getCommunicationSettings,
  setCommunicationSettings,
  getAiProviderKeys,
  CommunicationSetInput,
} from '../settings';
import type { McpActor } from '../actor';

const TENANT = '22222222-2222-2222-2222-222222222222';
const ACCOUNT = 'acct-1';
const TEAM = 'a0000000-0000-0000-0000-000000000001';

const actor = {
  tenantId: TENANT,
  accountId: ACCOUNT,
  keyId: 'key-1',
  keyType: 'oauth',
  role: 'owner',
  displayName: 'Ada',
  client: 'Claude Code',
} as unknown as McpActor;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAiVendor.mockResolvedValue({ aiVendor: 'anthropic', options: ['default', 'anthropic', 'openai'] });
  mockDispatch.mockResolvedValue('preview: anthropic -> openai (confirmationId: abc)');
  mockAccounts.getById.mockResolvedValue({ id: ACCOUNT, preferences: {} });
  mockAccounts.update.mockResolvedValue({ id: ACCOUNT });
  mockGetProviderKeys.mockResolvedValue([]);
});

describe('the AI provider', () => {
  it('reports the current provider with the options, so a change never guesses a name', async () => {
    const read = await getAiProvider(actor);
    expect(read.workspaceProvider).toBe('anthropic');
    expect(read.options).toEqual(['default', 'anthropic', 'openai']);
    // "default" reads like an absent value; it is a choice, and it has a name.
    expect(read.note).toContain('Liftoff Managed');
  });

  it('acts as the person on the dashboard, over MCP, with the credential named', async () => {
    await setAiProvider({ vendor: 'openai' }, actor);
    const [, , passedActor] = mockDispatch.mock.calls[0] as [string, unknown, Record<string, unknown>];
    expect(passedActor).toMatchObject({
      tenantId: TENANT, accountId: ACCOUNT, role: 'owner',
      surface: 'dashboard', via: 'mcp', client: 'Claude Code', credentialId: 'key-1',
    });
  });

  it('previews without a confirmationId and commits with it, never sending a handle it was not given', async () => {
    await setAiProvider({ vendor: 'openai' }, actor);
    expect(mockDispatch).toHaveBeenCalledWith('workspace_ai_vendor', { vendor: 'openai' }, expect.anything());

    await setAiProvider({ vendor: 'openai', confirmationId: 'abc' }, actor);
    expect(mockDispatch).toHaveBeenLastCalledWith(
      'workspace_ai_vendor', { vendor: 'openai', confirmationId: 'abc' }, expect.anything(),
    );
  });

  it('carries the action\'s own words back in a field, unaltered', async () => {
    const out = await setAiProvider({ vendor: 'openai' }, actor);
    expect(out).toEqual({ result: 'preview: anthropic -> openai (confirmationId: abc)' });
  });

  it('an agent\'s override rides team_update, and the workspace\'s own provider CLEARS it', async () => {
    await setAiProvider({ vendor: 'openai', agentId: TEAM }, actor);
    expect(mockDispatch).toHaveBeenLastCalledWith(
      'team_update', { agentId: TEAM, aiVendorOverride: 'openai' }, expect.anything(),
    );

    // The workspace runs on anthropic, so asking for anthropic means "follow the
    // workspace" — pinning it would leave two places describing one state, and
    // the agent would stay on anthropic after the workspace moved off it.
    await setAiProvider({ vendor: 'anthropic', agentId: TEAM }, actor);
    expect(mockDispatch).toHaveBeenLastCalledWith(
      'team_update', { agentId: TEAM, aiVendorOverride: null }, expect.anything(),
    );
  });
});

describe('communication settings', () => {
  it('reports all four types with their defaults, whatever the account has saved', async () => {
    mockAccounts.getById.mockResolvedValue({ id: ACCOUNT, preferences: { notificationTypes: { escalations: false } } });
    const read = await getCommunicationSettings(actor);
    expect(read.notificationTypes).toEqual({
      taskUpdates: true, teamActivity: true, escalations: false, weeklyDigest: true,
    });
    expect(read.notificationFrequency).toBe('realtime');
    expect(read.frequencyOptions).toEqual(['realtime', 'daily', 'weekly', 'none']);
  });

  it('reports browser delivery and marks it unwritable, with the reason', async () => {
    mockAccounts.getById.mockResolvedValue({ id: ACCOUNT, preferences: { notificationDelivery: { email: false, browser: true } } });
    const read = await getCommunicationSettings(actor);
    expect(read.delivery).toMatchObject({ email: false, browser: true, browserWritable: false });
    expect(read.delivery.browserNote).toMatch(/browser/i);
  });

  it('turning email on PRESERVES browser delivery, which the shallow jsonb merge would otherwise drop', async () => {
    mockAccounts.getById.mockResolvedValue({ id: ACCOUNT, preferences: { notificationDelivery: { email: false, browser: true } } });
    await setCommunicationSettings({ emailDelivery: true }, actor);
    const [, input] = mockAccounts.update.mock.calls[0] as [string, { preferences: Record<string, unknown> }];
    expect(input.preferences.notificationDelivery).toEqual({ email: true, browser: true });
  });

  it('a single toggle keeps every other type, which the same merge would otherwise erase', async () => {
    mockAccounts.getById.mockResolvedValue({
      id: ACCOUNT,
      preferences: { notificationTypes: { taskUpdates: false, teamActivity: false, escalations: false, weeklyDigest: false } },
    });
    await setCommunicationSettings({ notificationTypes: { escalations: true } }, actor);
    const [, input] = mockAccounts.update.mock.calls[0] as [string, { preferences: Record<string, unknown> }];
    expect(input.preferences.notificationTypes).toEqual({
      taskUpdates: false, teamActivity: false, escalations: true, weeklyDigest: false,
    });
  });

  it('writes only the keys asked for, so an untouched setting is not restated', async () => {
    await setCommunicationSettings({ notificationFrequency: 'daily' }, actor);
    const [, input] = mockAccounts.update.mock.calls[0] as [string, { preferences: Record<string, unknown> }];
    expect(Object.keys(input.preferences)).toEqual(['notificationFrequency']);
  });

  it('reads the settings back rather than assuming the write, and says what changed', async () => {
    const out = await setCommunicationSettings({ notificationFrequency: 'weekly' }, actor);
    expect(out).toMatchObject({ changed: ['notificationFrequency'] });
    expect(out).toHaveProperty('settings.notificationFrequency');
  });

  it('refuses rather than writing when the account cannot be read', async () => {
    mockAccounts.getById.mockResolvedValue(null);
    const out = await setCommunicationSettings({ emailDelivery: true }, actor);
    expect(out).toHaveProperty('refused');
    expect(mockAccounts.update).not.toHaveBeenCalled();
  });

  it('reports the newsletter, defaulting subscribed the way the page does', async () => {
    expect((await getCommunicationSettings(actor)).newsletter).toBe(true);
    mockAccounts.getById.mockResolvedValue({ id: ACCOUNT, preferences: { newsletter: false } });
    expect((await getCommunicationSettings(actor)).newsletter).toBe(false);
  });

  it('unsubscribes the newsletter on its own, touching no notification setting', async () => {
    mockAccounts.getById.mockResolvedValue({
      id: ACCOUNT,
      preferences: { notificationTypes: { taskUpdates: false }, notificationDelivery: { email: true, browser: true } },
    });
    await setCommunicationSettings({ newsletter: false }, actor);
    const [, input] = mockAccounts.update.mock.calls[0] as [string, { preferences: Record<string, unknown> }];
    expect(input.preferences).toEqual({ newsletter: false });
  });

  // The newsletter is a mailing list, not a channel for the notifications above.
  // Silencing every notification must not unsubscribe it, and unsubscribing must
  // not silence anything — the page keeps them in separate sections for that
  // reason, and one tool writing both could quietly couple them.
  it('keeps the newsletter and the notifications independent in one call', async () => {
    await setCommunicationSettings(
      { notificationTypes: { taskUpdates: false, teamActivity: false, escalations: false, weeklyDigest: false }, newsletter: true },
      actor,
    );
    const [, input] = mockAccounts.update.mock.calls[0] as [string, { preferences: Record<string, unknown> }];
    expect(input.preferences.newsletter).toBe(true);
    expect(input.preferences.notificationTypes).toEqual({
      taskUpdates: false, teamActivity: false, escalations: false, weeklyDigest: false,
    });
  });

  // The Communication tab has four sections. Three are writable here and the
  // fourth, browser delivery, is readable with a reason. The newsletter was
  // missed on the first pass precisely because nothing enumerated the page, so
  // this asserts the whole surface rather than each field that happens to exist.
  it('covers every control the Communication page has', async () => {
    const read = await getCommunicationSettings(actor);
    expect(Object.keys(read.notificationTypes).sort())
      .toEqual(['escalations', 'taskUpdates', 'teamActivity', 'weeklyDigest']);
    expect(read).toHaveProperty('notificationFrequency');
    expect(read).toHaveProperty('delivery.email');
    expect(read).toHaveProperty('newsletter');
    // Reported so a person sees the whole picture, and marked so a model does
    // not offer to change what a coding tool cannot.
    expect(read.delivery.browser).toBeDefined();
    expect(read.delivery.browserWritable).toBe(false);

    const writable = CommunicationSetInput._def.schema.shape;
    expect(Object.keys(writable).sort())
      .toEqual(['emailDelivery', 'newsletter', 'notificationFrequency', 'notificationTypes']);
  });

  it('refuses an empty change and an unknown notification type at the schema', () => {
    expect(CommunicationSetInput.safeParse({}).success).toBe(false);
    expect(CommunicationSetInput.safeParse({ notificationTypes: { taskCompleted: true } }).success).toBe(false);
    expect(CommunicationSetInput.safeParse({ notificationFrequency: 'hourly' }).success).toBe(false);
    expect(CommunicationSetInput.safeParse({ notificationTypes: { escalations: false } }).success).toBe(true);
    expect(CommunicationSetInput.safeParse({ newsletter: false }).success).toBe(true);
  });
});


describe('the workspace\'s own provider keys', () => {
  const asRole = (role: string) => ({ ...actor, role } as unknown as McpActor);

  it('lists every vendor, including the ones with no key', async () => {
    const out = await getAiProviderKeys(actor) as { providers: { vendor: string; hasKey: boolean; paidBy: string }[] };
    expect(out.providers.map((p) => p.vendor)).toEqual(['anthropic', 'google', 'openai', 'xai']);
    // Absent is an answer. A list of only what exists cannot say what is missing,
    // and "which providers am I NOT covering" is the question being asked.
    for (const p of out.providers) {
      expect(p.hasKey).toBe(false);
      expect(p.paidBy).toBe('liftoff_managed');
    }
  });

  it('reports a working key by its redaction, and says the workspace is paying', async () => {
    mockGetProviderKeys.mockResolvedValue([
      { vendor: 'anthropic', hint: 'sk-ant••••3f2x', status: 'valid', updatedAt: '2026-09-01T00:00:00Z', lastVerifiedAt: '2026-09-20T00:00:00Z' },
    ]);
    const out = await getAiProviderKeys(actor) as { providers: Record<string, unknown>[] };
    expect(out.providers[0]).toMatchObject({
      vendor: 'anthropic', hasKey: true, status: 'valid',
      keyHint: 'sk-ant••••3f2x', paidBy: 'workspace_own_key',
    });
  });

  // A revoked key has NOT stopped the work: calls fall back to the managed pool.
  // Reporting only "revoked" would read as an outage and send someone hunting.
  it('a revoked key says the calls moved to the managed pool, not that they stopped', async () => {
    mockGetProviderKeys.mockResolvedValue([
      { vendor: 'openai', hint: 'sk••••9a1b', status: 'revoked', updatedAt: null, lastVerifiedAt: null },
    ]);
    const out = await getAiProviderKeys(actor) as { providers: Record<string, unknown>[] };
    const openai = out.providers.find((p) => p.vendor === 'openai')!;
    expect(openai).toMatchObject({ hasKey: true, status: 'revoked', paidBy: 'liftoff_managed' });
    expect(openai.note).toMatch(/managed pool/);
  });

  it('hands back the page the key is entered on, on the tab the card is on', async () => {
    const out = await getAiProviderKeys(actor) as { page: string; howToChange: string };
    expect(out.page).toBe(`${process.env.FRONTEND_URL}/dashboard/settings/workspace`);
    expect(out.howToChange).toMatch(/never through a tool/);
  });

  it('is owner and admin only, matching the dashboard route, and reads nothing otherwise', async () => {
    for (const role of ['owner', 'admin']) {
      expect(await getAiProviderKeys(asRole(role))).not.toHaveProperty('refused');
    }
    for (const role of ['member', 'viewer']) {
      mockGetProviderKeys.mockClear();
      expect(await getAiProviderKeys(asRole(role))).toHaveProperty('refused');
      expect(mockGetProviderKeys).not.toHaveBeenCalled();
    }
  });

  // The whole point of the tool is that a secret never travels this way. Nothing
  // it returns may be usable as a credential: a redaction is recognisable, not
  // usable, and the estate's redaction uses U+2022 bullets.
  it('returns no usable secret anywhere in its result', async () => {
    mockGetProviderKeys.mockResolvedValue([
      { vendor: 'anthropic', hint: 'sk-ant••••3f2x', status: 'valid', updatedAt: null, lastVerifiedAt: null },
    ]);
    const serialized = JSON.stringify(await getAiProviderKeys(actor));
    const hints = (JSON.parse(serialized) as { providers: { keyHint?: string }[] }).providers
      .map((p) => p.keyHint).filter(Boolean) as string[];
    expect(hints).not.toHaveLength(0);
    for (const hint of hints) expect(hint).toContain('•');
  });
});
