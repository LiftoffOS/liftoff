// Platform x402 wallet — the signer seam.
//
// The wallet's private key never exists in this process, whichever custodian
// holds it. Two custodians are supported, chosen by X402_WALLET_PROVIDER:
//
//   cdp (the default when unset) — a Coinbase CDP Server Wallet. What we hold
//     are three CDP credentials (API key id + secret, wallet secret), rotatable
//     and revocable from the CDP portal. The SDK reads them from the
//     environment (CDP_API_KEY_ID / CDP_API_KEY_SECRET / CDP_WALLET_SECRET) and
//     `fromCdpEvmAccount` bridges the server account into the
//     `ClientEvmSigner` shape `@x402/evm`'s ExactEvmScheme consumes.
//   circle — a Circle Developer-Controlled Wallet. What we hold are an API key
//     and the entity secret (CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET), plus the
//     id of the one wallet on Base (CIRCLE_X402_WALLET_ID); circle-signer.ts
//     is the bridge.
//
// The two custodians hold DIFFERENT addresses, so a provider switch is two
// settings changed together: this one, and X402_WALLET_ADDRESS on
// platform-backend, whose treasury checks watch that address on-chain.
// platform-backend reads the live signer's address back through the internal
// wallet route and logs a mismatch, so a half-flipped switch is visible.
//
// Everything here is LAZY and env-gated: resolving the signer is a custodian
// API call, and the service must boot cleanly with none of the environment
// present. A process without it can serve every non-x402 connector; only an
// actual x402 payment attempt surfaces X402NotConfiguredError, which the
// executor returns as a typed failure rather than a stub success.
//
// The exact scheme signs EIP-3009 transferWithAuthorization typed data and the
// facilitator submits it on-chain and pays gas, so this wallet holds USDC only
// and never broadcasts a transaction itself.

import type { ClientEvmSigner } from '@x402/evm';
import { CIRCLE_ENV_VARS, fromCircleWallet, readCircleConfigFromEnv } from './circle-signer.js';

/** The three CDP credentials, in the names the CDP SDK reads off the env. */
export const CDP_ENV_VARS = [
  'CDP_API_KEY_ID',
  'CDP_API_KEY_SECRET',
  'CDP_WALLET_SECRET',
] as const;

export type X402WalletProvider = 'cdp' | 'circle';

const PROVIDERS: ReadonlySet<string> = new Set<X402WalletProvider>(['cdp', 'circle']);

/** The CDP server-wallet account name. Stable: getOrCreateAccount resolves the
 *  same on-chain address for the life of the CDP project, which is what makes
 *  the wallet's USDC balance durable across deploys. */
export const X402_WALLET_ACCOUNT_NAME = 'x402-wallet';

/** Which custodian signs. Unset means CDP, so an estate deployed before the
 *  choice existed keeps its wallet. A value that names neither is reported
 *  as not configured (never silently CDP): a typo in this setting must not
 *  pay from the other custodian's wallet. */
export function x402WalletProvider(): X402WalletProvider | null {
  const raw = process.env.X402_WALLET_PROVIDER?.trim().toLowerCase();
  if (!raw) return 'cdp';
  return PROVIDERS.has(raw) ? (raw as X402WalletProvider) : null;
}

function envPresent(names: readonly string[]): boolean {
  return names.every((name) => {
    const v = process.env[name];
    return typeof v === 'string' && v.trim().length > 0;
  });
}

export class X402NotConfiguredError extends Error {
  constructor() {
    const provider = x402WalletProvider();
    const detail = provider === null
      ? `X402_WALLET_PROVIDER=${JSON.stringify(process.env.X402_WALLET_PROVIDER)} names no custodian (cdp or circle)`
      : `the ${provider} wallet credentials (${(provider === 'cdp' ? CDP_ENV_VARS : CIRCLE_ENV_VARS).join(', ')}) are not set`;
    super(`x402 payments are not configured: ${detail}, so this vendor's paid calls cannot be made`);
    this.name = 'X402NotConfiguredError';
  }
}

export function isX402Configured(): boolean {
  const provider = x402WalletProvider();
  if (provider === 'cdp') return envPresent(CDP_ENV_VARS);
  if (provider === 'circle') return envPresent(CIRCLE_ENV_VARS);
  return false;
}

/** The literal custodian credential values, for the dispatcher's secret-scrub
 *  set — so a vendor response that somehow echoes one can never leave the
 *  process. Both custodians' values, whichever is active: a mounted secret is
 *  a secret whether or not it signs today. */
export function collectX402SecretValues(): string[] {
  const values: string[] = [];
  for (const name of [...CDP_ENV_VARS, ...CIRCLE_ENV_VARS]) {
    const v = process.env[name];
    if (v && v.trim()) values.push(v);
  }
  return values;
}

let signerPromise: Promise<ClientEvmSigner> | null = null;

/**
 * The platform's x402 signer. Lazy singleton: the first call resolves the
 * custodian's account (an API call); later calls reuse it. Throws
 * (synchronously) when the custodian's env is absent so a caller can refuse
 * before any network I/O.
 */
export function getX402Signer(): Promise<ClientEvmSigner> {
  if (!isX402Configured()) throw new X402NotConfiguredError();
  signerPromise ??= buildSigner().catch((err) => {
    // A failed resolution must not poison every later call.
    signerPromise = null;
    throw err;
  });
  return signerPromise;
}

/** The active signer's address, for the wallet route platform-backend reads
 *  to check its own X402_WALLET_ADDRESS against. Resolves the signer, so it
 *  costs one custodian call the first time and nothing after. */
export async function getX402WalletAddress(): Promise<`0x${string}`> {
  return (await getX402Signer()).address;
}

async function buildSigner(): Promise<ClientEvmSigner> {
  const provider = x402WalletProvider();
  if (provider === 'circle') {
    const config = readCircleConfigFromEnv();
    // isX402Configured() has just said the env is present; this is the type
    // narrowing, not a second policy.
    if (!config) throw new X402NotConfiguredError();
    return fromCircleWallet(config);
  }
  // Imported lazily so a process that never pays keeps the CDP SDK out of its
  // module graph (and unit suites never load it).
  const { CdpClient } = await import('@coinbase/cdp-sdk');
  const { fromCdpEvmAccount } = await import('@coinbase/cdp-sdk/x402');
  const cdp = new CdpClient();
  const account = await cdp.evm.getOrCreateAccount({ name: X402_WALLET_ACCOUNT_NAME });
  return fromCdpEvmAccount(account);
}

/** Test seam: drop the cached signer so env changes take effect. */
export function resetX402SignerForTests(): void {
  signerPromise = null;
}
