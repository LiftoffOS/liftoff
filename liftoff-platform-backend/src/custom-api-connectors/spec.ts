// The declared auth spec: a zod schema over what the provider-documentation
// read produces, plus the canonical hash the capture token is bound to.
//
// Validated HERE as well as in connector-service. The two are not duplicates of
// one decision: this one refuses a description the assistant produced before a
// link is ever minted, so the person is never handed a page for a connection
// that cannot be registered; connector-service validates what arrives on its
// own wire, because a service that trusts its caller's validation has none.

import { createHash } from 'crypto';
import { z } from 'zod';
import type { CustomApiSpec, UnsupportedSchemeReason } from './types';

const authPlacementSchema = z.discriminatedUnion('scheme', [
  z.object({ scheme: z.literal('bearer_header') }),
  z.object({
    scheme: z.literal('header'),
    name: z.string().min(1).max(100),
    prefix: z.string().max(40).optional(),
  }),
  z.object({ scheme: z.literal('query'), name: z.string().min(1).max(100) }),
  z.object({ scheme: z.literal('path'), name: z.string().min(1).max(100) }),
]);

const verificationSchema = z.object({
  method: z.enum(['GET', 'HEAD']),
  path: z.string().min(1).max(2000).startsWith('/'),
  query: z.record(z.string(), z.string()).optional(),
  accountIdentityField: z.string().min(1).max(200).optional(),
});

export const customApiSpecSchema = z.object({
  providerSlug: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9_-]*$/, 'must be a lowercase slug'),
  displayName: z.string().min(1).max(200),
  baseUrl: z.string().url().max(2000),
  apiHosts: z.array(z.string().min(1).max(253)).min(1).max(20),
  auth: authPlacementSchema,
  verification: verificationSchema,
  specSourceUrl: z.string().url().max(2000),
  purpose: z.string().min(1).max(2000),
});

/**
 * The hash the capture token is bound to.
 *
 * Canonical (keys sorted, at every depth) so the same description always
 * hashes the same way whatever order the model happened to emit its fields in.
 * A token bound to this cannot be replayed against a different description
 * than the one the person was shown before they confirmed.
 */
export function hashSpec(spec: CustomApiSpec): string {
  return createHash('sha256').update(canonicalJson(spec)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export interface SpecCheck {
  ok: boolean;
  /** Present when `ok` is false: what to say, in words a person reads. */
  message?: string;
}

/**
 * Is this description one this family can hold?
 *
 * The schema answers the shape. This answers the two things a valid-looking
 * description can still get wrong: a base URL that is not https, and a base URL
 * whose host is not among the hosts the connection declares.
 */
export function checkSpec(spec: CustomApiSpec): SpecCheck {
  const parsed = customApiSpecSchema.safeParse(spec);
  if (!parsed.success) {
    return {
      ok: false,
      message:
        'That connection description is not one this family can hold: '
        + parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')} ${i.message}`).join('; '),
    };
  }
  let base: URL;
  try {
    base = new URL(spec.baseUrl);
  } catch {
    return { ok: false, message: `${spec.baseUrl} is not an address a request can be built from.` };
  }
  if (base.protocol !== 'https:') {
    return {
      ok: false,
      message: 'The connection must be over https. A plain address would put the credential on the wire in the clear.',
    };
  }
  const hosts = spec.apiHosts.map((h) => h.toLowerCase());
  if (!hosts.includes(base.host.toLowerCase())) {
    return {
      ok: false,
      message: `The base address is on ${base.host}, which is not one of the hosts this connection lists (${spec.apiHosts.join(', ')}).`,
    };
  }
  return { ok: true };
}

/** The scheme names an assistant may declare it met. Kept beside the schema so
 *  the tool's own input vocabulary and the refusal messages cannot drift. */
export const UNSUPPORTED_SCHEME_REASONS: readonly UnsupportedSchemeReason[] = [
  'password_only',
  'copied_cookies',
  'request_signing',
  'multi_secret',
  'client_certificate',
];
