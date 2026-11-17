// collab command tests
// Verifies the MCP-only authentication flow and disconnect handling

// ── Mock external dependencies ─────────────────────────────────────────

// chalk v5+ ships ESM-only and Jest's default transform pipeline doesn't
// transform node_modules — so importing `collab.ts` (which uses chalk)
// crashes the suite with "Cannot use import statement outside a module".
// We stub chalk as identity functions; the test never asserts colour codes.
jest.mock('chalk', () => {
  const identity = (s: string) => s;
  return {
    __esModule: true,
    default: new Proxy(identity, {
      get: () => identity,
    }),
  };
});

jest.mock('../auth', () => ({
  browserAuth: jest.fn(),
}));

jest.mock('../api-client', () => ({
  exchangeSetupToken: jest.fn(),
  revokeMcpToken: jest.fn(),
  revokeProxyKey: jest.fn(),
}));

jest.mock('../claude-config', () => ({
  getMcpStatus: jest.fn(),
  setMcpConfig: jest.fn(),
  removeMcpConfig: jest.fn(),
  getProxyStatus: jest.fn(),
  readSettings: jest.fn(),
  removeProxyConfig: jest.fn(),
  setCollabInstructions: jest.fn(),
  removeCollabInstructions: jest.fn(),
}));

jest.mock('../state', () => ({
  loadState: jest.fn(),
  saveState: jest.fn(),
  deleteState: jest.fn(),
}));

// ── Import mocked modules ──────────────────────────────────────────────

import type { ProxyState } from '../state';

import { browserAuth } from '../auth';
import { exchangeSetupToken, revokeMcpToken } from '../api-client';
import {
  getMcpStatus,
  setMcpConfig,
  removeMcpConfig,
  getProxyStatus,
  readSettings,
  removeProxyConfig,
} from '../claude-config';
import { loadState, saveState, deleteState } from '../state';

const mockBrowserAuth = browserAuth as jest.MockedFunction<typeof browserAuth>;
const mockExchangeSetupToken = exchangeSetupToken as jest.MockedFunction<typeof exchangeSetupToken>;
const mockRevokeMcpToken = revokeMcpToken as jest.MockedFunction<typeof revokeMcpToken>;
const mockGetMcpStatus = getMcpStatus as jest.MockedFunction<typeof getMcpStatus>;
const mockSetMcpConfig = setMcpConfig as jest.MockedFunction<typeof setMcpConfig>;
const mockRemoveMcpConfig = removeMcpConfig as jest.MockedFunction<typeof removeMcpConfig>;
const mockLoadState = loadState as jest.MockedFunction<typeof loadState>;
const mockSaveState = saveState as jest.MockedFunction<typeof saveState>;
const mockDeleteState = deleteState as jest.MockedFunction<typeof deleteState>;
const mockGetProxyStatus = getProxyStatus as jest.MockedFunction<typeof getProxyStatus>;
const mockReadSettings = readSettings as jest.MockedFunction<typeof readSettings>;
const mockRemoveProxyConfig = removeProxyConfig as jest.MockedFunction<typeof removeProxyConfig>;

// Import commands under test after mocks are set up
import { collab } from '../commands/collab';
import { disconnect } from '../commands/disconnect';

// ── Constants ──────────────────────────────────────────────────────────

const FAKE_FIREBASE_TOKEN = 'firebase_id_token_abc';
const FAKE_TENANT_ID = 'tenant_abc123';
const FAKE_SETUP_TOKEN = 'setup_token_xyz';
const FAKE_CODE_VERIFIER = 'pkce_verifier_abc';
const FAKE_MCP_TOKEN = 'liftoff_mcp_abcdef1234';
const FAKE_TOKEN_ID = 'mcp-token-id-999';
const FAKE_BASE_URL = 'https://api.example.com';

// ── Setup / teardown ───────────────────────────────────────────────────

let consoleSpy: jest.SpyInstance;
let consoleErrorSpy: jest.SpyInstance;

beforeEach(() => {
  consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

// ── collab() — happy path ──────────────────────────────────────────────

describe('collab()', () => {
  describe('happy path', () => {
    beforeEach(() => {
      mockGetMcpStatus.mockReturnValue({ connected: false });

      mockBrowserAuth.mockResolvedValue({
        firebaseToken: FAKE_FIREBASE_TOKEN,
        tenantId: FAKE_TENANT_ID,
        setupToken: FAKE_SETUP_TOKEN,
        codeVerifier: FAKE_CODE_VERIFIER,
      });

      mockExchangeSetupToken.mockResolvedValue({
        proxyKey: FAKE_MCP_TOKEN,
        baseUrl: FAKE_BASE_URL,
        tokenId: FAKE_TOKEN_ID,
      });

      mockLoadState.mockReturnValue(null);
    });

    it('calls browserAuth with collab mode', async () => {
      await collab();
      expect(mockBrowserAuth).toHaveBeenCalledWith({ mode: 'collab' });
    });

    it('calls exchangeSetupToken with firebaseToken, setupToken, and codeVerifier', async () => {
      await collab();
      expect(mockExchangeSetupToken).toHaveBeenCalledWith(
        FAKE_FIREBASE_TOKEN,
        FAKE_SETUP_TOKEN,
        FAKE_CODE_VERIFIER,
      );
    });

    it('calls setMcpConfig with the returned MCP token', async () => {
      await collab();
      expect(mockSetMcpConfig).toHaveBeenCalledWith(FAKE_MCP_TOKEN);
    });

    it('saves state with mcpToken, mcpTokenId, and tenantId', async () => {
      await collab();
      expect(mockSaveState).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpToken: FAKE_MCP_TOKEN,
          mcpTokenId: FAKE_TOKEN_ID,
          tenantId: FAKE_TENANT_ID,
        }),
      );
    });

    it('uses baseUrl from exchange response when no existing state', async () => {
      await collab();
      expect(mockSaveState).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: FAKE_BASE_URL,
        }),
      );
    });
  });

  describe('when proxy state already exists', () => {
    it('preserves existing baseUrl, apiKey, and connectedAt from state', async () => {
      mockGetMcpStatus.mockReturnValue({ connected: false });
      mockBrowserAuth.mockResolvedValue({
        firebaseToken: FAKE_FIREBASE_TOKEN,
        tenantId: FAKE_TENANT_ID,
        setupToken: FAKE_SETUP_TOKEN,
        codeVerifier: FAKE_CODE_VERIFIER,
      });
      mockExchangeSetupToken.mockResolvedValue({
        proxyKey: FAKE_MCP_TOKEN,
        baseUrl: FAKE_BASE_URL,
        tokenId: FAKE_TOKEN_ID,
      });

      const existingState: ProxyState = {
        baseUrl: 'https://proxy.existing.com',
        apiKey: 'liftoff_sk_existingkey',
        tenantId: FAKE_TENANT_ID,
        connectedAt: '2026-01-01T00:00:00.000Z',
      };
      mockLoadState.mockReturnValue(existingState);

      await collab();

      expect(mockSaveState).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: existingState.baseUrl,
          apiKey: existingState.apiKey,
          connectedAt: existingState.connectedAt,
          mcpToken: FAKE_MCP_TOKEN,
          mcpTokenId: FAKE_TOKEN_ID,
        }),
      );
    });
  });

  describe('already connected', () => {
    it('prints a message and returns early without calling browserAuth', async () => {
      mockGetMcpStatus.mockReturnValue({
        connected: true,
        keyType: 'collab',
        keyHint: '1234',
      });

      await collab();

      expect(mockBrowserAuth).not.toHaveBeenCalled();
      expect(mockSetMcpConfig).not.toHaveBeenCalled();
    });
  });

  describe('missing setup token from browserAuth', () => {
    it('calls process.exit(1) and does not call exchangeSetupToken', async () => {
      mockGetMcpStatus.mockReturnValue({ connected: false });
      mockBrowserAuth.mockResolvedValue({
        firebaseToken: FAKE_FIREBASE_TOKEN,
        tenantId: FAKE_TENANT_ID,
        setupToken: undefined,
        codeVerifier: FAKE_CODE_VERIFIER,
      });

      const exitSpy = jest
        .spyOn(process, 'exit')
        .mockImplementation((() => { throw new Error('process.exit called'); }) as (code?: number) => never);

      await expect(collab()).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mockExchangeSetupToken).not.toHaveBeenCalled();
      exitSpy.mockRestore();
    });
  });

  describe('unexpected token type returned from exchange', () => {
    it('calls process.exit(1) when exchange returns a liftoff_sk_ token', async () => {
      mockGetMcpStatus.mockReturnValue({ connected: false });
      mockBrowserAuth.mockResolvedValue({
        firebaseToken: FAKE_FIREBASE_TOKEN,
        tenantId: FAKE_TENANT_ID,
        setupToken: FAKE_SETUP_TOKEN,
        codeVerifier: FAKE_CODE_VERIFIER,
      });
      mockExchangeSetupToken.mockResolvedValue({
        proxyKey: 'liftoff_sk_wrong_type',
        baseUrl: FAKE_BASE_URL,
      });

      const exitSpy = jest
        .spyOn(process, 'exit')
        .mockImplementation((() => { throw new Error('process.exit called'); }) as (code?: number) => never);

      await expect(collab()).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mockSetMcpConfig).not.toHaveBeenCalled();
      exitSpy.mockRestore();
    });
  });
});

// ── disconnect() with MCP-only state ──────────────────────────────────

describe('disconnect() with MCP-only state', () => {
  beforeEach(() => {
    // No proxy active
    mockGetProxyStatus.mockReturnValue({ connected: false });
    // MCP collab token is the only active connection
    mockGetMcpStatus.mockReturnValue({
      connected: true,
      keyType: 'collab',
      keyHint: FAKE_MCP_TOKEN.slice(-4),
    });
    // State holds both token and its server-side revocation ID
    mockLoadState.mockReturnValue({
      baseUrl: FAKE_BASE_URL,
      apiKey: '',
      tenantId: FAKE_TENANT_ID,
      connectedAt: '2026-01-01T00:00:00.000Z',
      mcpToken: FAKE_MCP_TOKEN,
      mcpTokenId: FAKE_TOKEN_ID,
    });
    mockRevokeMcpToken.mockResolvedValue(undefined);
    mockReadSettings.mockReturnValue({});
  });

  it('calls revokeMcpToken with the stored token and tokenId', async () => {
    await disconnect();
    expect(mockRevokeMcpToken).toHaveBeenCalledWith(FAKE_MCP_TOKEN, FAKE_TOKEN_ID);
  });

  it('calls removeMcpConfig after revoking', async () => {
    await disconnect();
    expect(mockRemoveMcpConfig).toHaveBeenCalled();
  });

  it('calls deleteState after revocation', async () => {
    await disconnect();
    expect(mockDeleteState).toHaveBeenCalled();
  });

  it('does not call removeProxyConfig when only MCP is connected', async () => {
    await disconnect();
    expect(mockRemoveProxyConfig).not.toHaveBeenCalled();
  });

  it('still removes local config and state when revokeMcpToken throws', async () => {
    mockRevokeMcpToken.mockRejectedValue(new Error('network error'));

    await disconnect();

    expect(mockRemoveMcpConfig).toHaveBeenCalled();
    expect(mockDeleteState).toHaveBeenCalled();
  });
});

// ── disconnect() when nothing is connected ─────────────────────────────

describe('disconnect() when nothing is connected', () => {
  it('prints "Not connected" and does not revoke or delete anything', async () => {
    mockGetProxyStatus.mockReturnValue({ connected: false });
    mockGetMcpStatus.mockReturnValue({ connected: false });
    mockLoadState.mockReturnValue(null);

    await disconnect();

    expect(mockRevokeMcpToken).not.toHaveBeenCalled();
    expect(mockRemoveMcpConfig).not.toHaveBeenCalled();
    expect(mockDeleteState).not.toHaveBeenCalled();
  });
});
