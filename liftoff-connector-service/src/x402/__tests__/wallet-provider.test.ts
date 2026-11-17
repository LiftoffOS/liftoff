// Which custodian signs is one setting, and its failure modes are the point:
// unset keeps the wallet an estate already has (CDP); a value that names
// neither custodian is NOT configured rather than silently the other one;
// each custodian is configured by its own credentials only; and every
// mounted credential is scrubbed from vendor responses whether or not it
// signs today.

const fromCircleWalletMock = jest.fn();
jest.mock('../circle-signer.js', () => {
  const actual = jest.requireActual('../circle-signer.js');
  return { ...actual, fromCircleWallet: (...a: unknown[]) => fromCircleWalletMock(...a) };
});

import {
  CDP_ENV_VARS,
  X402NotConfiguredError,
  collectX402SecretValues,
  getX402Signer,
  getX402WalletAddress,
  isX402Configured,
  resetX402SignerForTests,
  x402WalletProvider,
} from '../wallet.js';
import { CIRCLE_ENV_VARS } from '../circle-signer.js';
import { describeX402Wallet } from '../wallet-router.js';

const ALL_VARS = [...CDP_ENV_VARS, ...CIRCLE_ENV_VARS, 'X402_WALLET_PROVIDER'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of ALL_VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
  resetX402SignerForTests();
  fromCircleWalletMock.mockReset();
});

afterEach(() => {
  for (const v of ALL_VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

function setCdp(): void {
  process.env.CDP_API_KEY_ID = 'id';
  process.env.CDP_API_KEY_SECRET = 'secret';
  process.env.CDP_WALLET_SECRET = 'wallet';
}

function setCircle(): void {
  process.env.CIRCLE_API_KEY = 'ck';
  process.env.CIRCLE_ENTITY_SECRET = 'ab'.repeat(32);
  process.env.CIRCLE_X402_WALLET_ID = 'wid';
}

describe('x402 wallet provider', () => {
  it('is CDP when unset, and configured only by the CDP credentials', () => {
    expect(x402WalletProvider()).toBe('cdp');
    expect(isX402Configured()).toBe(false);
    setCircle();
    expect(isX402Configured()).toBe(false);
    setCdp();
    expect(isX402Configured()).toBe(true);
  });

  it('is Circle when set so, and configured only by the Circle credentials', () => {
    process.env.X402_WALLET_PROVIDER = 'circle';
    expect(x402WalletProvider()).toBe('circle');
    setCdp();
    expect(isX402Configured()).toBe(false);
    setCircle();
    expect(isX402Configured()).toBe(true);
  });

  it('names neither custodian for a typo, and says which setting is wrong', () => {
    process.env.X402_WALLET_PROVIDER = 'coinbase';
    setCdp();
    setCircle();
    expect(x402WalletProvider()).toBeNull();
    expect(isX402Configured()).toBe(false);
    expect(() => getX402Signer()).toThrow(X402NotConfiguredError);
    expect(() => getX402Signer()).toThrow(/X402_WALLET_PROVIDER="coinbase" names no custodian/);
  });

  it('names the missing credentials of the chosen custodian', () => {
    process.env.X402_WALLET_PROVIDER = 'circle';
    expect(() => getX402Signer()).toThrow(/circle wallet credentials \(CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_X402_WALLET_ID\)/);
    delete process.env.X402_WALLET_PROVIDER;
    expect(() => getX402Signer()).toThrow(/cdp wallet credentials \(CDP_API_KEY_ID/);
  });

  it('builds the Circle signer from the Circle env, once, and exposes its address', async () => {
    process.env.X402_WALLET_PROVIDER = 'circle';
    setCircle();
    fromCircleWalletMock.mockResolvedValue({ address: '0xabc', signTypedData: jest.fn() });
    const signer = await getX402Signer();
    expect(signer.address).toBe('0xabc');
    expect(fromCircleWalletMock).toHaveBeenCalledWith({ apiKey: 'ck', entitySecret: 'ab'.repeat(32), walletId: 'wid' });
    await getX402Signer();
    expect(fromCircleWalletMock).toHaveBeenCalledTimes(1);
    expect(await getX402WalletAddress()).toBe('0xabc');
  });

  it('scrubs both custodians\' credentials whichever one signs', () => {
    setCdp();
    setCircle();
    expect(collectX402SecretValues()).toEqual(['id', 'secret', 'wallet', 'ck', 'ab'.repeat(32), 'wid']);
  });
});

describe('describeX402Wallet', () => {
  it('reports the custodian and address, or that nothing is configured, always as a 200-shaped answer', async () => {
    expect(await describeX402Wallet()).toEqual({ provider: 'cdp', configured: false });

    process.env.X402_WALLET_PROVIDER = 'circle';
    setCircle();
    fromCircleWalletMock.mockResolvedValue({ address: '0xabc', signTypedData: jest.fn() });
    expect(await describeX402Wallet()).toEqual({ provider: 'circle', configured: true, address: '0xabc' });
  });

  it('reports a custodian that cannot be reached without throwing', async () => {
    process.env.X402_WALLET_PROVIDER = 'circle';
    setCircle();
    fromCircleWalletMock.mockRejectedValue(new Error('Circle GET /wallets/wid answered 401'));
    expect(await describeX402Wallet()).toEqual({ provider: 'circle', configured: true, error: 'signer_unavailable' });
  });
});
