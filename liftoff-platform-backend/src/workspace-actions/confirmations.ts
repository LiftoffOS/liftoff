// Confirmation handles: consent in chat, made structural.
//
// A mutating tool called without a confirmationId answers with a preview and
// a handle; called with the handle it applies — and only against the exact
// payload that was previewed. The handle is a stateless AES-256-GCM token, the
// way capability handles are minted: bound to the tenant, the person, the
// action and a hash of the canonical payload, with a ten-minute life. A model
// cannot forge one, reuse one for another person, or apply a payload other
// than the one the person saw.
//
// Consumption on first use is the dispatcher's job (claim/settle on
// idempotency_keys); this module only mints and verifies.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { deriveHandleKey } from '../capability-discovery/handles';
import type { Actor } from './actor';

export const CONFIRMATION_PREFIX = 'cfm_';
export const CONFIRMATION_TTL_MS = 10 * 60_000;
const IV_LEN = 12;
const TAG_LEN = 16;

const KEY: Buffer = deriveHandleKey('workspace-confirmation');

/** JSON with sorted keys at every level, so the same payload hashes the same
 *  whatever order a model happened to spell its fields in. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

interface ConfirmationPlaintext {
  t: string;
  a: string;
  k: string;
  h: string;
  e: number;
}

export function mintConfirmation(actor: Actor, action: string, payload: unknown): string {
  const plaintext: ConfirmationPlaintext = {
    t: actor.tenantId,
    a: actor.accountId,
    k: action,
    h: payloadHash(payload),
    e: Date.now() + CONFIRMATION_TTL_MS,
  };
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return CONFIRMATION_PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64url');
}

export type ConfirmationVerdict =
  | { ok: true }
  | { ok: false; reason: 'malformed' | 'expired' | 'wrong_person' | 'wrong_action' | 'payload_changed' };

export function verifyConfirmation(actor: Actor, action: string, payload: unknown, id: string): ConfirmationVerdict {
  if (typeof id !== 'string' || !id.startsWith(CONFIRMATION_PREFIX)) return { ok: false, reason: 'malformed' };
  let plaintext: ConfirmationPlaintext;
  try {
    const raw = Buffer.from(id.slice(CONFIRMATION_PREFIX.length), 'base64url');
    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ciphertext = raw.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    plaintext = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')) as ConfirmationPlaintext;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof plaintext.e !== 'number' || plaintext.e < Date.now()) return { ok: false, reason: 'expired' };
  if (plaintext.t !== actor.tenantId || plaintext.a !== actor.accountId) return { ok: false, reason: 'wrong_person' };
  if (plaintext.k !== action) return { ok: false, reason: 'wrong_action' };
  if (plaintext.h !== payloadHash(payload)) return { ok: false, reason: 'payload_changed' };
  return { ok: true };
}
