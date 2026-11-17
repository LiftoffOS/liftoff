// AES-256-GCM signing-secret envelope tests.

import {
  encryptSecret,
  decryptSecret,
  EventSourceKeyMissingError,
  EventSourceCiphertextError,
  _setKeyForTesting,
} from '../secret-encryption';

const TEST_KEY = 'a'.repeat(64);

describe('encryptSecret / decryptSecret', () => {
  beforeEach(() => _setKeyForTesting(TEST_KEY));
  afterAll(() => _setKeyForTesting(undefined));

  it('round-trips the plaintext signing secret', () => {
    const plain = 'f'.repeat(64);
    const ct = encryptSecret(plain);
    expect(decryptSecret(ct)).toBe(plain);
  });

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    const plain = 'hello';
    expect(encryptSecret(plain).equals(encryptSecret(plain))).toBe(false);
  });

  it('throws EventSourceCiphertextError on bit-flip in the auth tag', () => {
    const ct = encryptSecret('secret');
    ct[1 + 12] ^= 0x01; // first byte of auth tag (after version+iv)
    expect(() => decryptSecret(ct)).toThrow(EventSourceCiphertextError);
  });

  it('throws EventSourceCiphertextError on truncated ciphertext', () => {
    const ct = encryptSecret('secret');
    expect(() => decryptSecret(ct.slice(0, 5))).toThrow(EventSourceCiphertextError);
  });

  it('throws EventSourceCiphertextError on unknown version byte', () => {
    const ct = encryptSecret('secret');
    ct[0] = 0xff;
    expect(() => decryptSecret(ct)).toThrow(/unsupported ciphertext version/);
  });

  it('throws EventSourceCiphertextError when decryption uses a different key', () => {
    const ct = encryptSecret('secret');
    _setKeyForTesting('b'.repeat(64));
    expect(() => decryptSecret(ct)).toThrow(EventSourceCiphertextError);
  });

  it('throws EventSourceKeyMissingError when the env var is unset', () => {
    _setKeyForTesting(undefined);
    expect(() => encryptSecret('secret')).toThrow(EventSourceKeyMissingError);
  });

  it('throws EventSourceCiphertextError when the key is malformed', () => {
    _setKeyForTesting('not-hex');
    expect(() => encryptSecret('secret')).toThrow(EventSourceCiphertextError);
  });
});
