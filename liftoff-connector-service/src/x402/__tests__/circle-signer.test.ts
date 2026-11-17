// The Circle bridge: a ClientEvmSigner whose every signature is one Circle
// call carrying a fresh entity-secret ciphertext. What the tests pin is the
// wire shape Circle verifies (typed data as one JSON string with the domain
// type declared and uints as decimal strings), the two facts a wallet must
// satisfy before it is trusted to sign, and that the entity secret never
// travels except encrypted.

import { generateKeyPairSync, privateDecrypt, constants as cryptoConstants } from 'node:crypto';
import {
  CIRCLE_BASE_MAINNET,
  CircleSignerError,
  entitySecretCiphertext,
  fromCircleWallet,
  serializeTypedDataForCircle,
} from '../circle-signer.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUBLIC_PEM = publicKey.export({ type: 'pkcs1', format: 'pem' }) as string;
const ENTITY_SECRET = '5e'.repeat(32);
const WALLET_ID = '7b1f2b4a-2b1a-4d5c-9e8f-0a1b2c3d4e5f';
const ADDRESS = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const SIGNATURE = `0x${'1'.repeat(128)}1b`;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Call = { url: string; init?: RequestInit };

function fakeCircle(overrides: {
  wallet?: Record<string, unknown>;
  sign?: (body: Record<string, unknown>) => Response;
} = {}) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (url.endsWith('/config/entity/publicKey')) return jsonResponse(200, { data: { publicKey: PUBLIC_PEM } });
    if (url.endsWith(`/wallets/${WALLET_ID}`)) {
      return jsonResponse(200, {
        data: { wallet: { id: WALLET_ID, address: ADDRESS, blockchain: CIRCLE_BASE_MAINNET, state: 'LIVE', ...overrides.wallet } },
      });
    }
    if (url.endsWith('/developer/sign/typedData')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return overrides.sign ? overrides.sign(body) : jsonResponse(200, { data: { signature: SIGNATURE } });
    }
    return jsonResponse(404, { code: 0, message: `no route ${url}` });
  };
  return { fetchImpl, calls };
}

const TYPED = {
  domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  types: {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'TransferWithAuthorization',
  message: {
    from: ADDRESS,
    to: '0x1111111111111111111111111111111111111111',
    value: 31000n,
    validAfter: 0n,
    validBefore: 1_800_000_000n,
    nonce: `0x${'ab'.repeat(32)}`,
  },
};

describe('serializeTypedDataForCircle', () => {
  it('declares EIP712Domain from the domain keys present and writes bigints as decimal strings', () => {
    const parsed = JSON.parse(serializeTypedDataForCircle(TYPED));
    expect(parsed.types.EIP712Domain).toEqual([
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ]);
    expect(parsed.message.value).toBe('31000');
    expect(parsed.message.validBefore).toBe('1800000000');
    expect(parsed.message.nonce).toBe(TYPED.message.nonce);
    expect(parsed.primaryType).toBe('TransferWithAuthorization');
    expect(parsed.domain.chainId).toBe(8453);
  });

  it('leaves a caller-declared EIP712Domain alone', () => {
    const declared = { ...TYPED, types: { ...TYPED.types, EIP712Domain: [{ name: 'name', type: 'string' }] } };
    const parsed = JSON.parse(serializeTypedDataForCircle(declared));
    expect(parsed.types.EIP712Domain).toEqual([{ name: 'name', type: 'string' }]);
  });
});

describe('entitySecretCiphertext', () => {
  it('is RSA-OAEP(SHA-256) of the raw 32 bytes, fresh every time', () => {
    const a = entitySecretCiphertext(PUBLIC_PEM, ENTITY_SECRET);
    const b = entitySecretCiphertext(PUBLIC_PEM, ENTITY_SECRET);
    expect(a).not.toBe(b);
    const decrypted = privateDecrypt(
      { key: privateKey, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(a, 'base64'),
    );
    expect(decrypted.toString('hex')).toBe(ENTITY_SECRET);
  });

  it('refuses a secret that is not 32 hex bytes', () => {
    expect(() => entitySecretCiphertext(PUBLIC_PEM, 'abc')).toThrow(CircleSignerError);
  });
});

describe('fromCircleWallet', () => {
  it('reads the wallet once, signs through Circle with a fresh ciphertext, and never sends the secret itself', async () => {
    const { fetchImpl, calls } = fakeCircle();
    const signer = await fromCircleWallet({ apiKey: 'k', entitySecret: ENTITY_SECRET, walletId: WALLET_ID }, fetchImpl);
    expect(signer.address).toBe(ADDRESS.toLowerCase());

    const sig = await signer.signTypedData(TYPED);
    expect(sig).toBe(SIGNATURE);

    const signCalls = calls.filter((c) => c.url.endsWith('/developer/sign/typedData'));
    expect(signCalls).toHaveLength(1);
    const body = JSON.parse(String(signCalls[0].init?.body)) as Record<string, unknown>;
    expect(body.walletId).toBe(WALLET_ID);
    expect(typeof body.data).toBe('string');
    expect(JSON.parse(body.data as string).message.value).toBe('31000');
    expect(typeof body.entitySecretCiphertext).toBe('string');
    expect(String(signCalls[0].init?.body)).not.toContain(ENTITY_SECRET);
    const headers = signCalls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer k');

    await signer.signTypedData(TYPED);
    const [first, second] = calls
      .filter((c) => c.url.endsWith('/developer/sign/typedData'))
      .map((c) => (JSON.parse(String(c.init?.body)) as { entitySecretCiphertext: string }).entitySecretCiphertext);
    expect(first).not.toBe(second);
    // The wallet and the public key were read once, not per signature.
    expect(calls.filter((c) => c.url.endsWith(`/wallets/${WALLET_ID}`))).toHaveLength(1);
    expect(calls.filter((c) => c.url.endsWith('/config/entity/publicKey'))).toHaveLength(1);
  });

  it('refuses a wallet that is not on Base mainnet, or not live', async () => {
    await expect(
      fromCircleWallet({ apiKey: 'k', entitySecret: ENTITY_SECRET, walletId: WALLET_ID }, fakeCircle({ wallet: { blockchain: 'BASE-SEPOLIA' } }).fetchImpl),
    ).rejects.toThrow(/not BASE/);
    await expect(
      fromCircleWallet({ apiKey: 'k', entitySecret: ENTITY_SECRET, walletId: WALLET_ID }, fakeCircle({ wallet: { state: 'FROZEN' } }).fetchImpl),
    ).rejects.toThrow(/FROZEN, not LIVE/);
  });

  it('surfaces a refused or malformed signing answer as a typed error, never a fabricated signature', async () => {
    const refused = fakeCircle({ sign: () => jsonResponse(401, { code: 401, message: 'Unauthorized' }) });
    const signer = await fromCircleWallet({ apiKey: 'k', entitySecret: ENTITY_SECRET, walletId: WALLET_ID }, refused.fetchImpl);
    await expect(signer.signTypedData(TYPED)).rejects.toMatchObject({ name: 'CircleSignerError', status: 401, circleCode: 401 });

    const malformed = fakeCircle({ sign: () => jsonResponse(200, { data: { signature: '0x1234' } }) });
    const signer2 = await fromCircleWallet({ apiKey: 'k', entitySecret: ENTITY_SECRET, walletId: WALLET_ID }, malformed.fetchImpl);
    await expect(signer2.signTypedData(TYPED)).rejects.toThrow(/65-byte signature/);
  });
});
