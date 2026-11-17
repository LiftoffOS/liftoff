// The saved-login contract without a vault: the matching rule per website
// setting, ambiguity, archived items, the field extraction from an Item
// fixture (the TOTP details and their error case), the rate-limit memo, the
// auth failure taking the BYOK path, and the guarantee that no overview
// carries a secret.

jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetWebToolCredential = jest.fn();
class VendorNotConnected extends Error {
  constructor(public readonly vendor: string) { super(`No connected ${vendor} connector for tenant`); this.name = 'VendorNotConnected'; }
}
class VendorConnectorErrored extends Error {
  constructor(public readonly vendor: string, public readonly errorCode: string) { super(`${vendor} connector in error state: ${errorCode}`); this.name = 'VendorConnectorErrored'; }
}
jest.mock('../../web-fetch/web-tool-secrets', () => ({
  getWebToolCredential: (...a: unknown[]) => mockGetWebToolCredential(...a),
  VendorNotConnected,
  VendorConnectorErrored,
}));
jest.mock('../../web-fetch/credential-scope', () => ({ ANY_CONNECTOR: Object.freeze({ connectorIds: null }) }));
const mockMarkConnectorErrored = jest.fn();
jest.mock('../../web-fetch/byok-error-handler', () => ({
  markConnectorErrored: (...a: unknown[]) => mockMarkConnectorErrored(...a),
}));
const mockClientFor = jest.fn();
const mockDropClient = jest.fn();
jest.mock('../client', () => ({
  clientFor: (...a: unknown[]) => mockClientFor(...a),
  dropOnePasswordClient: (...a: unknown[]) => mockDropClient(...a),
}));

import {
  credentialsOf, findLoginForUrl, isLoginSourceAvailable, listSavedLogins, matchLogins, parseWebsite, resolveLogin,
  usernameOf, _resetSavedLoginsForTesting, type SavedLogin,
} from '../logins';

class RateLimitExceededError extends Error { constructor(message: string) { super(); this.message = message; } }
class AuthExpiredError extends Error { constructor(message: string) { super(); this.message = message; } }

const site = (url: string, autofillBehavior = 'AnywhereOnWebsite') => parseWebsite(url, autofillBehavior);
const login = (itemId: string, websites: SavedLogin['websites'], title = itemId): SavedLogin => ({ vaultId: 'v1', itemId, title, websites, username: null });

/** A fake SDK client over a fixture vault. */
function fakeClient(items: Array<Record<string, unknown>>, full: Record<string, Record<string, unknown>> = {}) {
  return {
    vaults: { list: jest.fn(async () => [{ id: 'v1', title: 'Shared with Liftoff' }]) },
    items: {
      list: jest.fn(async () => items),
      get: jest.fn(async (_vaultId: string, itemId: string) => full[itemId] ?? { id: itemId, fields: [] }),
      getAll: jest.fn(async (_vaultId: string, itemIds: string[]) => ({
        individualResponses: itemIds.map((id) => (full[id] ? { content: full[id] } : { error: { type: 'notFound' } })),
      })),
    },
  };
}

const PASSWORD_FIELD = { id: 'password', title: 'password', fieldType: 'Concealed', value: 'hunter2-secret' };
const USERNAME_FIELD = { id: 'username', title: 'username', fieldType: 'Text', value: 'jane@a.test' };

beforeEach(() => {
  jest.clearAllMocks();
  _resetSavedLoginsForTesting();
  mockGetWebToolCredential.mockResolvedValue({ apiKey: 'ops_x', connectorId: 'c1', extra: {} });
});

describe('the matching rule', () => {
  it('AnywhereOnWebsite: the page host equals the website host or the website host is a dot-suffix of it', () => {
    const logins = [login('a', [site('https://example.com')])];
    expect(matchLogins(logins, 'https://example.com/login')).toMatchObject({ itemId: 'a' });
    expect(matchLogins(logins, 'https://login.example.com/')).toMatchObject({ itemId: 'a' });
    expect(matchLogins(logins, 'https://example.com:8443/')).toMatchObject({ itemId: 'a' });
    // A different host that merely contains the name is not the website.
    expect(matchLogins(logins, 'https://notexample.com/')).toBeNull();
    expect(matchLogins(logins, 'https://example.com.evil.test/')).toBeNull();
    // The website is a subdomain: the parent is not part of it.
    expect(matchLogins([login('b', [site('https://app.example.com')])], 'https://example.com/')).toBeNull();
  });

  it('ExactDomain: the host and port must both match, defaults resolved per scheme', () => {
    const logins = [login('a', [site('https://example.com', 'ExactDomain')])];
    expect(matchLogins(logins, 'https://example.com/login')).toMatchObject({ itemId: 'a' });
    expect(matchLogins(logins, 'https://login.example.com/')).toBeNull();
    expect(matchLogins(logins, 'https://example.com:8443/')).toBeNull();
    expect(matchLogins(logins, 'http://example.com/')).toBeNull();
    const withPort = [login('p', [site('https://example.com:8443', 'ExactDomain')])];
    expect(matchLogins(withPort, 'https://example.com:8443/')).toMatchObject({ itemId: 'p' });
    expect(matchLogins(withPort, 'https://example.com/')).toBeNull();
  });

  it('Never: the website never matches', () => {
    const logins = [login('a', [site('https://example.com', 'Never')])];
    expect(matchLogins(logins, 'https://example.com/login')).toBeNull();
    // One Never entry does not cancel another website on the same item.
    const two = [login('b', [site('https://example.com', 'Never'), site('https://other.test')])];
    expect(matchLogins(two, 'https://other.test/')).toMatchObject({ itemId: 'b' });
  });

  it('a website with no scheme is read as its host, a host:port pair included', () => {
    expect(site('example.com')).toMatchObject({ host: 'example.com', port: '443' });
    expect(site('EXAMPLE.com/path')).toMatchObject({ host: 'example.com' });
    // "example.com:8443" parses as a URL with the scheme "example.com:".
    expect(site('example.com:8443')).toMatchObject({ host: 'example.com', port: '8443' });
    expect(site('localhost:3000', 'ExactDomain')).toMatchObject({ host: 'localhost', port: '3000' });
    expect(matchLogins([login('p', [site('localhost:3000', 'ExactDomain')])], 'https://localhost:3000/login')).toMatchObject({ itemId: 'p' });
    expect(site('http://example.com')).toMatchObject({ host: 'example.com', port: '80' });
    expect(site('')).toMatchObject({ host: '' });
    // An explicit scheme that is not the web's names no website.
    expect(site('ftp://files.example.com/')).toMatchObject({ host: '' });
    expect(matchLogins([login('a', [site('')])], 'https://example.com/')).toBeNull();
  });

  it('exactly one match is the login; two are ambiguous; none is null', () => {
    const logins = [login('a', [site('https://example.com')]), login('b', [site('https://example.com')]), login('c', [site('https://other.test')])];
    expect(matchLogins(logins, 'https://example.com/')).toBe('ambiguous');
    expect(matchLogins(logins, 'https://other.test/')).toMatchObject({ itemId: 'c' });
    expect(matchLogins(logins, 'https://nothing.test/')).toBeNull();
    expect(matchLogins(logins, 'not a url')).toBeNull();
    expect(matchLogins(logins, 'file:///etc/passwd')).toBeNull();
  });
});

describe('the overview list', () => {
  it('keeps active Login items only, never a secret, and reads the username lazily', async () => {
    const client = fakeClient([
      { id: 'i1', title: 'Example', category: 'Login', vaultId: 'v1', state: 'active', websites: [{ url: 'https://example.com', label: 'website', autofillBehavior: 'AnywhereOnWebsite' }] },
      { id: 'i2', title: 'Old', category: 'Login', vaultId: 'v1', state: 'archived', websites: [{ url: 'https://old.test', label: 'website', autofillBehavior: 'AnywhereOnWebsite' }] },
      { id: 'i3', title: 'Card', category: 'CreditCard', vaultId: 'v1', state: 'active', websites: [] },
    ], { i1: { id: 'i1', fields: [USERNAME_FIELD, PASSWORD_FIELD] } });
    mockClientFor.mockResolvedValue({ client, connectorId: 'c1' });

    const logins = await listSavedLogins('t1');
    expect(logins).toHaveLength(1);
    expect(logins[0]).toEqual({ vaultId: 'v1', itemId: 'i1', title: 'Example', websites: [{ host: 'example.com', port: '443', autofillBehavior: 'AnywhereOnWebsite' }], username: null });
    expect(JSON.stringify(logins)).not.toContain('hunter2');
    expect(client.items.get).not.toHaveBeenCalled();
    // The list asked for archived items to be left out at the source too.
    expect(client.items.list).toHaveBeenCalledWith('v1', { type: 'ByState', content: { active: true, archived: false } });

    const withUsernames = await listSavedLogins('t1', { withUsernames: true });
    expect(withUsernames[0].username).toBe('jane@a.test');
    expect(client.items.get).not.toHaveBeenCalled();
    expect(client.items.getAll).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(withUsernames)).not.toContain('hunter2');
    // Cached: a second list within the minute reads nothing.
    await listSavedLogins('t1');
    expect(client.vaults.list).toHaveBeenCalledTimes(1);
  });

  it('findLoginForUrl matches over the cached overviews', async () => {
    const client = fakeClient([
      { id: 'i1', title: 'Example', category: 'Login', vaultId: 'v1', state: 'active', websites: [{ url: 'https://example.com', label: 'website', autofillBehavior: 'AnywhereOnWebsite' }] },
    ]);
    mockClientFor.mockResolvedValue({ client, connectorId: 'c1' });
    expect(await findLoginForUrl('t1', 'https://login.example.com/session/new')).toMatchObject({ itemId: 'i1' });
    expect(await findLoginForUrl('t1', 'https://other.test/')).toBeNull();
    expect(client.vaults.list).toHaveBeenCalledTimes(1);
  });

  it('a workspace with no connector, or with every key set aside by the pool, has no logins and no error', async () => {
    mockClientFor.mockRejectedValueOnce(new VendorNotConnected('onepassword'));
    expect(await listSavedLogins('t1')).toEqual([]);
    mockClientFor.mockRejectedValueOnce(new VendorConnectorErrored('onepassword', 'byok_invalid_key'));
    expect(await resolveLogin('t1', { vaultId: 'v1', itemId: 'i1' })).toBeNull();
    expect(mockMarkConnectorErrored).not.toHaveBeenCalled();
  });
});

describe('the usernames for the listing', () => {
  const vaultOf = (count: number) => Array.from({ length: count }, (_, i) => ({
    id: `i${i}`, title: `Item ${i}`, category: 'Login', vaultId: 'v1', state: 'active',
    websites: [{ url: `https://s${i}.test`, label: 'website', autofillBehavior: 'AnywhereOnWebsite' }],
  }));
  const fullOf = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [
    `i${i}`, { id: `i${i}`, fields: [{ id: 'username', fieldType: 'Text', value: `user${i}@a.test` }, PASSWORD_FIELD] },
  ]));

  it('reads a whole vault in batches of fifty, not one read per item, and matches each answer by item id', async () => {
    const client = fakeClient(vaultOf(120), fullOf(120));
    mockClientFor.mockResolvedValue({ client, connectorId: 'c1' });
    const logins = await listSavedLogins('t1', { withUsernames: true });
    expect(logins).toHaveLength(120);
    expect(client.items.getAll).toHaveBeenCalledTimes(3);
    expect((client.items.getAll.mock.calls[0] as unknown[])[1]).toHaveLength(50);
    expect((client.items.getAll.mock.calls[2] as unknown[])[1]).toHaveLength(20);
    expect(logins[0].username).toBe('user0@a.test');
    expect(logins[119].username).toBe('user119@a.test');
    // Asked again within the minute: the cache answers, nothing is read.
    await listSavedLogins('t1', { withUsernames: true });
    expect(client.items.getAll).toHaveBeenCalledTimes(3);
  });

  it('an item the batch could not return is listed without a username rather than with another item\'s', async () => {
    const client = fakeClient(vaultOf(2), { i0: { id: 'i0', fields: [USERNAME_FIELD, PASSWORD_FIELD] } });
    mockClientFor.mockResolvedValue({ client, connectorId: 'c1' });
    const logins = await listSavedLogins('t1', { withUsernames: true });
    expect(logins.map((l) => l.username)).toEqual(['jane@a.test', '']);
  });

  it('a failed batch leaves the rest unread and routes the failure', async () => {
    const client = fakeClient(vaultOf(2), fullOf(2));
    client.items.getAll.mockRejectedValueOnce(new AuthExpiredError('session expired'));
    mockClientFor.mockResolvedValue({ client, connectorId: 'c1' });
    const logins = await listSavedLogins('t1', { withUsernames: true });
    expect(logins.map((l) => l.username)).toEqual([null, null]);
    expect(mockMarkConnectorErrored).toHaveBeenCalledWith('t1', 'onepassword', 'c1', 'invalid_key', expect.any(String));
  });
});

describe('the field extraction', () => {
  it('reads the username and password by id, the TOTP code from the Otp details', () => {
    const out = credentialsOf({
      fields: [
        USERNAME_FIELD, PASSWORD_FIELD,
        { id: 'totp', title: 'one-time password', fieldType: 'Totp', value: 'otpauth://totp/x', details: { type: 'Otp', content: { code: '123456' } } },
      ],
    } as never);
    expect(out).toEqual({ username: 'jane@a.test', password: 'hunter2-secret', totpCode: '123456' });
  });

  it('falls back to the first Text/Email and the first Concealed field', () => {
    const out = credentialsOf({
      fields: [
        { id: 'x1', title: 'Email', fieldType: 'Email', value: 'j@a.test' },
        { id: 'x2', title: 'Secret', fieldType: 'Concealed', value: 'pw' },
      ],
    } as never);
    expect(out).toEqual({ username: 'j@a.test', password: 'pw' });
  });

  it('an Otp errorMessage means no code, and says why', () => {
    const out = credentialsOf({
      fields: [
        USERNAME_FIELD, PASSWORD_FIELD,
        { id: 'totp', title: 'one-time password', fieldType: 'Totp', value: 'bad', details: { type: 'Otp', content: { errorMessage: 'invalid otp secret' } } },
      ],
    } as never);
    expect(out).toEqual({ username: 'jane@a.test', password: 'hunter2-secret', totpError: 'invalid otp secret' });
  });

  it('an item without a usable pair resolves to nothing', () => {
    expect(credentialsOf({ fields: [USERNAME_FIELD] } as never)).toBeNull();
    expect(credentialsOf({ fields: [] } as never)).toBeNull();
  });

  it('an EMPTY field value is no value: a password-only item has no pair, and nothing is ever typed as an empty string', () => {
    // The shape a Login item takes when the person saved a password alone:
    // the username field is present and empty. Typing that clears the box on
    // the page and submits it.
    expect(credentialsOf({ fields: [{ id: 'username', fieldType: 'Text', value: '' }, PASSWORD_FIELD] } as never)).toBeNull();
    expect(credentialsOf({ fields: [USERNAME_FIELD, { id: 'password', fieldType: 'Concealed', value: '' }] } as never)).toBeNull();
    // An empty built-in field falls through to the next field that holds one.
    expect(credentialsOf({
      fields: [
        { id: 'username', fieldType: 'Text', value: '' },
        { id: 'x', title: 'Email', fieldType: 'Email', value: 'jane@a.test' },
        PASSWORD_FIELD,
      ],
    } as never)).toEqual({ username: 'jane@a.test', password: 'hunter2-secret' });
    expect(usernameOf([{ id: 'username', fieldType: 'Text', value: '' }] as never)).toBeNull();
  });

  it('resolveLogin is one items.get and nothing is cached', async () => {
    const client = fakeClient([], { i1: { id: 'i1', fields: [USERNAME_FIELD, PASSWORD_FIELD] } });
    mockClientFor.mockResolvedValue({ client, connectorId: 'c1' });
    expect(await resolveLogin('t1', { vaultId: 'v1', itemId: 'i1' })).toEqual({ username: 'jane@a.test', password: 'hunter2-secret' });
    expect(await resolveLogin('t1', { vaultId: 'v1', itemId: 'i1' })).toEqual({ username: 'jane@a.test', password: 'hunter2-secret' });
    expect(client.items.get).toHaveBeenCalledTimes(2);
  });

  it('resolveLogin says an item without a username and password pair is unusable, apart from a failed read', async () => {
    const client = fakeClient([], { i2: { id: 'i2', fields: [USERNAME_FIELD] } });
    mockClientFor.mockResolvedValue({ client, connectorId: 'c1' });
    expect(await resolveLogin('t1', { vaultId: 'v1', itemId: 'i2' })).toBe('unusable');
    expect(mockMarkConnectorErrored).not.toHaveBeenCalled();
  });
});

describe('failures', () => {
  it('a rate limit memoises "unavailable" for ten minutes: the matcher answers null and the source is unavailable', async () => {
    const client = fakeClient([]);
    client.vaults.list.mockRejectedValueOnce(new RateLimitExceededError('rate limit exceeded'));
    mockClientFor.mockResolvedValue({ client, connectorId: 'c1' });
    expect(await findLoginForUrl('t1', 'https://example.com/')).toBeNull();
    expect(await isLoginSourceAvailable('t1')).toBe(false);
    expect(await resolveLogin('t1', { vaultId: 'v1', itemId: 'i1' })).toBeNull();
    // Nothing is read again while the memo stands.
    expect(await findLoginForUrl('t1', 'https://example.com/')).toBeNull();
    expect(client.vaults.list).toHaveBeenCalledTimes(1);
    expect(mockMarkConnectorErrored).not.toHaveBeenCalled();
  });

  it('an auth failure takes the BYOK path: the connector is marked errored with invalid_key and the client dropped', async () => {
    const client = fakeClient([]);
    client.vaults.list.mockRejectedValueOnce(new AuthExpiredError('session expired'));
    mockClientFor.mockResolvedValue({ client, connectorId: 'c1' });
    expect(await listSavedLogins('t1')).toEqual([]);
    expect(mockMarkConnectorErrored).toHaveBeenCalledWith('t1', 'onepassword', 'c1', 'invalid_key', expect.any(String));
    expect(mockDropClient).toHaveBeenCalledWith('t1');
  });

  it('the core\'s own token message is an auth failure too', async () => {
    const client = fakeClient([]);
    client.items.get.mockRejectedValueOnce(new Error('bad service account token, please rotate it: revoked'));
    mockClientFor.mockResolvedValue({ client, connectorId: 'c1' });
    expect(await resolveLogin('t1', { vaultId: 'v1', itemId: 'i1' })).toBeNull();
    expect(mockMarkConnectorErrored).toHaveBeenCalledWith('t1', 'onepassword', 'c1', 'invalid_key', expect.any(String));
  });

  it('any other failure answers no login and marks nothing', async () => {
    const client = fakeClient([]);
    client.vaults.list.mockRejectedValueOnce(new Error('request timeout'));
    mockClientFor.mockResolvedValue({ client, connectorId: 'c1' });
    expect(await listSavedLogins('t1')).toEqual([]);
    expect(mockMarkConnectorErrored).not.toHaveBeenCalled();
  });
});

describe('the availability rule', () => {
  it('is an active onepassword connector the pool will hand out, read as the workspace, cached a minute either way', async () => {
    expect(await isLoginSourceAvailable('t1')).toBe(true);
    expect(await isLoginSourceAvailable('t1')).toBe(true);
    expect(mockGetWebToolCredential).toHaveBeenCalledTimes(1);
    expect(mockGetWebToolCredential).toHaveBeenCalledWith('t1', 'onepassword', { connectorIds: null });
    mockGetWebToolCredential.mockRejectedValue(new VendorNotConnected('onepassword'));
    expect(await isLoginSourceAvailable('t2')).toBe(false);
    expect(await isLoginSourceAvailable('t2')).toBe(false);
    expect(mockGetWebToolCredential).toHaveBeenCalledTimes(2);
    // Every key cooling (an invalid token the pool set aside) is unavailable too.
    mockGetWebToolCredential.mockRejectedValue(new VendorConnectorErrored('onepassword', 'byok_invalid_key'));
    expect(await isLoginSourceAvailable('t4')).toBe(false);
  });

  it('an unreadable connector is unavailable, not an error', async () => {
    mockGetWebToolCredential.mockRejectedValue(new Error('connector-service down'));
    expect(await isLoginSourceAvailable('t3')).toBe(false);
  });
});
