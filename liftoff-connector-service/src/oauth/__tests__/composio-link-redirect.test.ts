// Contract guard for how a composio_managed connect is started.
//
// `link.create` is the only non-retired, non-deprecated endpoint that yields an
// OAuth URL, and its hosted Connect Link page is the only surface that carries
// our `callbackUrl` onto the connection. Skipping that page by calling the
// deprecated `connectedAccounts.refresh()` ourselves is fragile: if Composio
// stops inheriting the link's callbackUrl, every connect dead-ends on their
// page — live, billed connections with no Liftoff row. See ADR-050.
//
// So this asserts two requirements:
//   1. we hand the user the HOSTED page, not a shortlink we derived ourselves
//   2. we never call the deprecated refresh endpoint on the connect path

const mockRefresh = jest.fn();
const mockLink = jest.fn();

jest.mock('@composio/core', () => ({
  Composio: jest.fn().mockImplementation(() => ({
    connectedAccounts: { link: mockLink },
    client: { connectedAccounts: { refresh: mockRefresh } },
  })),
}));

import { linkComposioAccount } from '../composio-client.js';

const CALLBACK_URL =
  'https://api.example.com/api/connectors/oauth/callback?state=cmp_deadbeef';
const HOSTED_PAGE = 'https://connect.composio.dev/link/lk_abc123';

describe('linkComposioAccount', () => {
  beforeEach(() => {
    process.env.COMPOSIO_API_KEY = 'test-key';
    mockLink.mockReset();
    mockRefresh.mockReset();
    mockLink.mockResolvedValue({ id: 'ca_test123', redirectUrl: HOSTED_PAGE });
  });

  it('returns the hosted Connect Link page as the popup destination', async () => {
    const result = await linkComposioAccount({
      authConfigId: 'ac_test',
      tenantId: 'tenant_xyz',
      callbackUrl: CALLBACK_URL,
    });

    expect(result).toEqual({
      redirectUrl: HOSTED_PAGE,
      connectedAccountId: 'ca_test123',
    });
  });

  it('never touches the deprecated refresh endpoint', async () => {
    await linkComposioAccount({
      authConfigId: 'ac_test',
      tenantId: 'tenant_xyz',
      callbackUrl: CALLBACK_URL,
    });

    // Reintroducing the bypass here strands connects on Composio's page.
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('passes callbackUrl and allowMultiple to link()', async () => {
    await linkComposioAccount({
      authConfigId: 'ac_test',
      tenantId: 'tenant_xyz',
      callbackUrl: CALLBACK_URL,
    });

    // callbackUrl is how the browser gets back to us; allowMultiple is what
    // lets one tenant hold several accounts for the same toolkit.
    expect(mockLink).toHaveBeenCalledWith('tenant_xyz', 'ac_test', {
      callbackUrl: CALLBACK_URL,
      allowMultiple: true,
    });
  });

  it('throws when link() yields no redirect URL', async () => {
    mockLink.mockResolvedValue({ id: 'ca_test123', redirectUrl: undefined });

    await expect(
      linkComposioAccount({
        authConfigId: 'ac_test',
        tenantId: 'tenant_xyz',
        callbackUrl: CALLBACK_URL,
      }),
    ).rejects.toThrow(/returned no redirectUrl/);
  });
});
