// A Circle Developer-Controlled Wallet as the x402 signer.
//
// Same custody property as the CDP server wallet: the private key lives in
// Circle's infrastructure and never exists in this process. What we hold is an
// API key (revocable from the Circle console) and the ENTITY SECRET: a 32-byte
// secret Circle never stores, which authorises every signing call. It is sent
// as a fresh RSA-OAEP(SHA-256) ciphertext under the entity's public key each
// time (Circle refuses a reused ciphertext), so the secret itself never
// crosses the wire. Losing it means re-registering with the recovery file
// the setup script writes.
//
// Three REST calls cover the signer: the entity public key (once), the wallet
// record (once, for the address), and sign/typedData (per payment). The
// vendor's SDK is deliberately not used: its optional Solana peer range
// (@solana/codecs-strings ^2) conflicts with the @solana/kit 5 tree the CDP
// SDK already installs, and npm refuses the pair. The one piece of
// cryptography the SDK would have done is a single node:crypto call here.
//
// The signature Circle returns has v as 27/28, the form the facilitator's
// ecrecover expects for an EIP-3009 authorisation.

import { randomUUID, publicEncrypt, constants as cryptoConstants } from 'node:crypto';
import type { ClientEvmSigner } from '@x402/evm';

export const CIRCLE_ENV_VARS = [
  'CIRCLE_API_KEY',
  'CIRCLE_ENTITY_SECRET',
  'CIRCLE_X402_WALLET_ID',
] as const;

export const CIRCLE_API_BASE = 'https://api.circle.com/v1/w3s';

/** Circle's chain code for Base mainnet: the only chain the wallet may be on,
 *  because USDC on Base (eip155:8453) is the asset every x402 vendor charges
 *  in and the address is meaningless anywhere else. */
export const CIRCLE_BASE_MAINNET = 'BASE';

export interface CircleWalletConfig {
  apiKey: string;
  /** 32 bytes, hex-encoded (64 characters). */
  entitySecret: string;
  walletId: string;
}

export interface CircleWalletRecord {
  id: string;
  address: `0x${string}`;
  blockchain: string;
  state: string;
  accountType?: string;
}

export class CircleSignerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly circleCode?: number,
  ) {
    super(message);
    this.name = 'CircleSignerError';
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function readCircleConfigFromEnv(): CircleWalletConfig | null {
  const apiKey = process.env.CIRCLE_API_KEY?.trim();
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET?.trim();
  const walletId = process.env.CIRCLE_X402_WALLET_ID?.trim();
  if (!apiKey || !entitySecret || !walletId) return null;
  return { apiKey, entitySecret, walletId };
}

export function circleHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    // Circle's own trace id; a UUID is what their logs index on.
    'X-Request-Id': randomUUID(),
  };
}

/** RSA-OAEP(SHA-256, MGF1-SHA-256) of the raw 32 bytes under the entity's PEM
 *  public key, base64 — the exact recipe Circle's SDK applies. Fresh per call. */
export function entitySecretCiphertext(publicKeyPem: string, entitySecretHex: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(entitySecretHex)) {
    throw new CircleSignerError('the entity secret must be 32 bytes, hex-encoded');
  }
  const encrypted = publicEncrypt(
    {
      key: publicKeyPem,
      padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(entitySecretHex, 'hex'),
  );
  return encrypted.toString('base64');
}

async function circleJson<T>(
  fetchImpl: FetchLike,
  apiKey: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetchImpl(`${CIRCLE_API_BASE}${path}`, {
    method,
    headers: circleHeaders(apiKey),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text().catch(() => '');
  type Envelope = { data?: T; code?: number; message?: string };
  let parsed: Envelope | null = null;
  try {
    parsed = text ? (JSON.parse(text) as Envelope) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    throw new CircleSignerError(
      `Circle ${method} ${path} answered ${res.status}${parsed?.message ? `: ${parsed.message}` : ''}`,
      res.status,
      parsed?.code,
    );
  }
  if (!parsed?.data) throw new CircleSignerError(`Circle ${method} ${path} answered without data`, res.status);
  return parsed.data;
}

export async function fetchEntityPublicKey(apiKey: string, fetchImpl: FetchLike = fetch): Promise<string> {
  const data = await circleJson<{ publicKey?: string }>(fetchImpl, apiKey, 'GET', '/config/entity/publicKey');
  if (!data.publicKey) throw new CircleSignerError('Circle answered the public-key read without a key');
  return data.publicKey;
}

export async function getCircleWallet(
  apiKey: string,
  walletId: string,
  fetchImpl: FetchLike = fetch,
): Promise<CircleWalletRecord> {
  const data = await circleJson<{ wallet?: CircleWalletRecord }>(
    fetchImpl, apiKey, 'GET', `/wallets/${encodeURIComponent(walletId)}`,
  );
  if (!data.wallet?.address) throw new CircleSignerError(`Circle wallet ${walletId} has no address`);
  return data.wallet;
}

/** The EIP-712 field types a domain may carry, in the order the standard
 *  lists them; only the keys present in this domain are declared. */
const EIP712_DOMAIN_FIELDS: ReadonlyArray<[string, string]> = [
  ['name', 'string'],
  ['version', 'string'],
  ['chainId', 'uint256'],
  ['verifyingContract', 'address'],
  ['salt', 'bytes32'],
];

/** Circle takes the typed data as ONE JSON string, `EIP712Domain` declared
 *  in `types` (the x402 scheme hands over viem-style typed data, which
 *  leaves the domain type implicit), and every uint as a decimal string
 *  (`value`, `validAfter`, `validBefore` arrive as bigints, which JSON cannot
 *  carry). */
export function serializeTypedDataForCircle(typed: {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}): string {
  const types: Record<string, unknown> = { ...typed.types };
  if (!types.EIP712Domain) {
    types.EIP712Domain = EIP712_DOMAIN_FIELDS
      .filter(([name]) => typed.domain[name] !== undefined)
      .map(([name, type]) => ({ name, type }));
  }
  const ordered = { types, domain: typed.domain, primaryType: typed.primaryType, message: typed.message };
  return JSON.stringify(ordered, (_key, value) => (typeof value === 'bigint' ? value.toString(10) : value));
}

/**
 * The signer over one Circle developer-controlled wallet on Base mainnet.
 * The wallet record is read once (address, and the two facts that make a
 * signature from it worth anything: the chain is Base, the wallet is live);
 * each payment is one sign/typedData call carrying a fresh ciphertext.
 */
export async function fromCircleWallet(
  config: CircleWalletConfig,
  fetchImpl: FetchLike = fetch,
): Promise<ClientEvmSigner> {
  const wallet = await getCircleWallet(config.apiKey, config.walletId, fetchImpl);
  if (wallet.blockchain !== CIRCLE_BASE_MAINNET) {
    throw new CircleSignerError(
      `Circle wallet ${config.walletId} is on ${wallet.blockchain}, not ${CIRCLE_BASE_MAINNET}; x402 vendors are paid in USDC on Base`,
    );
  }
  if (wallet.state !== 'LIVE') {
    throw new CircleSignerError(`Circle wallet ${config.walletId} is ${wallet.state}, not LIVE`);
  }
  const publicKeyPem = await fetchEntityPublicKey(config.apiKey, fetchImpl);
  const address = wallet.address.toLowerCase() as `0x${string}`;

  return {
    address,
    async signTypedData(message) {
      const data = await circleJson<{ signature?: string }>(
        fetchImpl,
        config.apiKey,
        'POST',
        '/developer/sign/typedData',
        {
          walletId: config.walletId,
          data: serializeTypedDataForCircle(message),
          entitySecretCiphertext: entitySecretCiphertext(publicKeyPem, config.entitySecret),
          memo: 'x402 payment authorisation',
        },
      );
      if (!data.signature || !/^0x[0-9a-fA-F]{130}$/.test(data.signature)) {
        throw new CircleSignerError('Circle answered the signing call without a 65-byte signature');
      }
      return data.signature as `0x${string}`;
    },
  };
}
