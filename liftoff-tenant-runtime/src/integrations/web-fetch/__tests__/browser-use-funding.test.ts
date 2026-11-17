/**
 * Whose account pays for a Browser Use call, decided in one place.
 *
 * The precedence rule is the whole feature: a workspace that connected its own
 * key uses that key and is billed by Browser Use directly, and a workspace that
 * connected nothing browses on the platform key and is billed by us. Everything
 * downstream — the tool palette, the pane, the OU ledger — reads the answer
 * this function produced, so a second derivation anywhere else is a second
 * answer that can disagree.
 */

const getWebToolCredentialMock = jest.fn();
const getWebToolSecretMock = jest.fn();

class VendorNotConnected extends Error {
  constructor(public readonly vendor: string) {
    super(`No connected ${vendor} connector for tenant`);
    this.name = 'VendorNotConnected';
  }
}
class VendorConnectorErrored extends Error {
  constructor(public readonly vendor: string, public readonly errorCode: string) {
    super(`${vendor} connector in error state: ${errorCode}`);
    this.name = 'VendorConnectorErrored';
  }
}

jest.mock('../web-tool-secrets', () => ({
  getWebToolCredential: (...a: unknown[]) => getWebToolCredentialMock(...a),
  getWebToolSecret: (...a: unknown[]) => getWebToolSecretMock(...a),
  VendorNotConnected,
  VendorConnectorErrored,
}));

jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { BrowserUseClient, fundingOf } from '../browser-use-client';

const client = new BrowserUseClient();

beforeEach(() => {
  jest.clearAllMocks();
  getWebToolSecretMock.mockResolvedValue('platform-key');
});

describe('the precedence rule', () => {
  it("uses the workspace's OWN key when it has one", async () => {
    getWebToolCredentialMock.mockResolvedValue({
      apiKey: 'tenant-key', connectorId: 'conn-1', extra: {},
    });

    const cred = await client.resolveCredential('t1');

    expect(cred.apiKey).toBe('tenant-key');
    expect(cred.connectorId).toBe('conn-1');
    expect(fundingOf(cred)).toBe('tenant_key');
    // The platform key is not even read, so a workspace on its own account can
    // never be quietly moved onto ours.
    expect(getWebToolSecretMock).not.toHaveBeenCalled();
  });

  it('falls back to the platform key when nothing is connected', async () => {
    getWebToolCredentialMock.mockRejectedValue(new VendorNotConnected('browser_use'));

    const cred = await client.resolveCredential('t1');

    expect(cred.apiKey).toBe('platform-key');
    // The absent connector id IS the funding signal. There is no second flag to
    // fall out of step with it.
    expect(cred.connectorId).toBeNull();
    expect(fundingOf(cred)).toBe('platform');
    expect(getWebToolSecretMock).toHaveBeenCalledWith('browser-use-api-key');
  });

  it('keeps FAILING when the workspace key is cooling, rather than failing over', async () => {
    // Deliberate. Moving a workspace onto our key here would hide that their
    // own Browser Use account is out of credit or holding a dead key, and would
    // start charging them for a browser they are already paying for. They get
    // the error that names the real cause instead.
    getWebToolCredentialMock.mockRejectedValue(
      new VendorConnectorErrored('browser_use', 'byok_insufficient_funds'),
    );

    await expect(client.resolveCredential('t1')).rejects.toThrow(VendorConnectorErrored);
    expect(getWebToolSecretMock).not.toHaveBeenCalled();
  });

  it('does not swallow an unrelated failure into a platform fallback', async () => {
    // A Secret Manager outage or a bad response must surface, not silently put
    // every workspace on the platform key.
    getWebToolCredentialMock.mockRejectedValue(new Error('connector-service timeout'));

    await expect(client.resolveCredential('t1')).rejects.toThrow(/connector-service timeout/);
    expect(getWebToolSecretMock).not.toHaveBeenCalled();
  });
});

describe("reading the vendor's money fields", () => {
  // Browser Use sends these as JSON STRINGS, not numbers, to keep full
  // precision. TypeScript declaring them `number` did not make them one, and
  // `(a ?? 0) + (b ?? 0)` concatenated instead of adding — a plausible-looking
  // figure that became NaN at the first arithmetic and silently billed nobody.
  const client2 = new BrowserUseClient();

  beforeEach(() => {
    // The block above leaves the resolver rejecting; these cases are about
    // reading the vendor's numbers, not about resolving a credential.
    getWebToolCredentialMock.mockResolvedValue({
      apiKey: 'k', connectorId: 'conn-1', extra: {},
    });
  });

  const details = (over: Record<string, unknown>) => {
    const call = jest.fn().mockResolvedValue({
      id: 'vs-1', status: 'stopped', startedAt: 'x', finishedAt: 'y', ...over,
    });
    (client2 as unknown as { call: unknown }).call = call;
    return client2.getSessionDetails('vs-1', 't1');
  };

  it('ADDS two string costs rather than concatenating them', async () => {
    await expect(details({
      browserCost: '0.0006666666666666666', proxyCost: '0.0000028964132070541',
    })).resolves.toMatchObject({ costUsd: expect.closeTo(0.000669563, 9) });
  });

  it('handles real numbers too, since the vendor may send either', async () => {
    await expect(details({ browserCost: 0.001, proxyCost: 0.002 }))
      .resolves.toMatchObject({ costUsd: 0.003 });
  });

  it('treats an absent meter as a genuine zero', async () => {
    await expect(details({ browserCost: '0.005' })).resolves.toMatchObject({ costUsd: 0.005 });
  });

  it('reports 0 rather than NaN when a figure cannot be read at all', async () => {
    await expect(details({ browserCost: 'not-a-number' })).resolves.toMatchObject({ costUsd: 0 });
  });
});
