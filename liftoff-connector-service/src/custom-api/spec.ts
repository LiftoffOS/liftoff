// The declared connection description, validated, and the OpenAPI document,
// checked against what the dispatcher can actually execute.
//
// "Every operation the API offers" is a promise about the CONNECTION, not about
// every OpenAPI document in existence. The contract is:
//
//   Every SUPPORTED operation in an accepted OpenAPI 3.x specification becomes
//   available. Registration REFUSES a specification containing unsupported
//   operation shapes rather than silently generating tools that cannot
//   dispatch.
//
// Refusing is the honest outcome. The alternative is a connector whose tiles
// look right and whose calls fail, which is invariant 4 in a new costume.
// Widening the subset later means widening `clients/templated-dispatch.ts`
// deliberately, not discovering the gap in production.

import { z } from 'zod';
import { resolveRef } from '../catalog/json-pointer.js';
import type {
  CustomApiRefusal,
  CustomApiSpec,
} from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

/** The most operations one connection may carry. */
export const MAX_CUSTOM_API_OPERATIONS = 200;

/** What `runTemplatedRequest` can build a request for today. */
const SUPPORTED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** The primitive JSON types a path or query parameter may carry.
 *
 *  `templated-dispatch` interpolates a path parameter with
 *  `encodeURIComponent(String(v))` and a query parameter with `String(v)`, so
 *  an array or object parameter is serialised as `[object Object]` — a call
 *  that looks correct and reaches the vendor wrong. */
const PRIMITIVE_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

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
  // GET or HEAD, and no other method is accepted. A verification that could
  // change something at the provider is not a verification.
  method: z.enum(['GET', 'HEAD']),
  path: z.string().min(1).max(2000).startsWith('/'),
  query: z.record(z.string(), z.string()).optional(),
  accountIdentityField: z.string().min(1).max(200).optional(),
});

export const customApiSpecSchema = z.object({
  providerSlug: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9_-]*$/),
  displayName: z.string().min(1).max(200),
  baseUrl: z.string().min(1).max(2000).url(),
  apiHosts: z.array(z.string().min(1).max(253)).min(1).max(20),
  auth: authPlacementSchema,
  verification: verificationSchema,
  specSourceUrl: z.string().min(1).max(2000).url(),
  purpose: z.string().min(1).max(2000),
});

export type ParsedCustomApiSpec = z.infer<typeof customApiSpecSchema>;

/** The host of a URL, lowercased, or null when it is not a URL at all. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Is this host one the person consented to?
 *
 *  Exact match only. A suffix match would let `evil-api.com` through for a
 *  consented `api.com`, and a leading-dot wildcard is not something an
 *  assistant reading documentation has any reason to produce. */
export function hostAllowed(host: string, apiHosts: readonly string[]): boolean {
  const needle = host.toLowerCase();
  return apiHosts.some((h) => h.toLowerCase() === needle);
}

/** Every host the declared servers and the base URL point at, checked against
 *  the hosts the person consented to. */
export function checkDeclaredHosts(
  spec: CustomApiSpec,
  document: Json,
): CustomApiRefusal | null {
  const offenders: string[] = [];
  const baseHost = hostOf(spec.baseUrl);
  if (!baseHost) {
    return {
      refused: 'host_not_consented',
      message: `The base URL ${spec.baseUrl} is not a URL we can read a host from.`,
    };
  }
  if (!hostAllowed(baseHost, spec.apiHosts)) offenders.push(baseHost);

  for (const server of (document.servers ?? []) as Json[]) {
    const raw = typeof server?.url === 'string' ? server.url : '';
    if (!raw) continue;
    // A relative server URL ("/v1") is resolved against the base URL, so its
    // host is the base host and is already checked above.
    if (raw.startsWith('/')) continue;
    const host = hostOf(raw);
    if (!host) {
      offenders.push(raw);
      continue;
    }
    if (!hostAllowed(host, spec.apiHosts)) offenders.push(host);
  }

  if (offenders.length === 0) return null;
  return {
    refused: 'host_not_consented',
    message:
      'The specification points at hosts outside the ones this connection was described with: '
      + `${[...new Set(offenders)].join(', ')}. The hosts consented to are ${spec.apiHosts.join(', ')}.`,
  };
}

/** One unsupported thing found on one operation. */
interface Offence {
  operation: string;
  reason: string;
}

function operationLabel(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/** A `$ref` may name ANY node, not only one under `#/components`. Resolving
 *  only the latter hands back the ref object itself, which the caller then
 *  reads as the thing it points at: no name, no location, no schema. */
function derefLocal(node: Json | undefined, document: Json): Json | undefined {
  return resolveRef(node, document) ?? node;
}

/** A composed schema describes a primitive when EVERY branch does. A branch
 *  with no type of its own is read as a string, the same reading an untyped
 *  parameter gets. `null` is ignored: it makes a value optional, not
 *  structured. */
function everyBranchIsPrimitive(branches: Json[], document: Json): boolean {
  if (!Array.isArray(branches) || branches.length === 0) return false;
  return branches.every((rawBranch) => {
    const branch = (resolveRef(rawBranch, document) ?? rawBranch) as Json;
    if (branch.allOf || branch.oneOf || branch.anyOf) {
      return everyBranchIsPrimitive(
        (branch.allOf ?? branch.oneOf ?? branch.anyOf) as Json[],
        document,
      );
    }
    const type = Array.isArray(branch.type)
      ? branch.type.find((t: unknown) => t && t !== 'null')
      : branch.type;
    return type === undefined || PRIMITIVE_TYPES.has(String(type));
  });
}

/**
 * Headers an operation may NOT declare a parameter for.
 *
 * Two kinds, and neither is about being cautious for its own sake. The
 * transport ones are the connection's, not the request's: a model choosing
 * `Host` picks a different server than the one consented to, and
 * `Content-Length` or `Transfer-Encoding` that disagrees with the body is a
 * request smuggling primitive. `Authorization` and `Cookie` are where
 * credentials live, and a parameter is a value a MODEL fills in.
 *
 * Everything else a provider declares is ordinary and is sent: an API version,
 * an idempotency key, a request id, `Accept`. What the dispatcher owns it sets
 * after these, so a declared header can never displace the credential or
 * contradict the encoding of a body we wrote.
 */
const HEADERS_THE_CONNECTION_OWNS = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding', 'upgrade',
  'keep-alive', 'te', 'trailer', 'expect',
  'authorization', 'cookie', 'set-cookie',
  'proxy-authorization', 'proxy-authenticate', 'proxy-connection',
]);

/** The header the credential itself goes in, when it goes in one. A parameter
 *  that names it would be a model writing the place the key is written. */
function credentialHeaderName(spec: CustomApiSpec): string | undefined {
  if (spec.auth.scheme === 'bearer_header') return 'authorization';
  if (spec.auth.scheme === 'header' && spec.auth.name) return spec.auth.name.toLowerCase();
  return undefined;
}

function checkParameters(
  op: Json,
  document: Json,
  label: string,
  offences: Offence[],
  spec: CustomApiSpec,
): void {
  for (const rawParam of (op.parameters ?? []) as Json[]) {
    const param = derefLocal(rawParam, document) ?? rawParam;
    const where = param?.in;
    const name = param?.name ?? '(unnamed)';
    if (where === 'header') {
      const lower = String(name).toLowerCase();
      if (lower === credentialHeaderName(spec)) {
        offences.push({
          operation: label,
          reason: `header parameter "${name}" is where this connection's key goes`,
        });
        continue;
      }
      if (HEADERS_THE_CONNECTION_OWNS.has(lower)) {
        offences.push({
          operation: label,
          reason: `header parameter "${name}" is the connection's to set, not the operation's`,
        });
        continue;
      }
      // An ordinary declared header. It is checked for shape below exactly as
      // a query parameter is.
    } else if (where === 'cookie') {
      offences.push({ operation: label, reason: `cookie parameter "${name}" (the dispatcher sends none)` });
      continue;
    } else if (where !== 'query' && where !== 'path') {
      offences.push({ operation: label, reason: `parameter "${name}" in an unsupported location "${String(where)}"` });
      continue;
    }
    // `deepObject` says the value is written bracketed — `a[b]=c`, an array
    // indexed as `a[0]=v`. It is a provider DECLARING that this parameter
    // carries structure, so it is checked before the rules that ask whether a
    // value is primitive: those exist because a structured value has no agreed
    // form on the wire, and this is the declaration of one. Stripe writes both
    // `expand` and every range filter this way, and it is not alone.
    if (where === 'query' && param.style === 'deepObject') continue;

    const schema = (param.schema ?? {}) as Json;
    const declared = Array.isArray(schema.type)
      ? schema.type.find((t: unknown) => t && t !== 'null')
      : schema.type;
    // An untyped parameter is read as a string, which is what the dispatcher
    // sends. A composed one is a primitive when every branch of it is: GitHub
    // types `workflow_id` as `oneOf: [integer, string]`, which is a number or
    // a word either way and goes on the wire identically. Refusing it was this
    // check reading the SHAPE of the schema rather than what it describes, and
    // it cost the whole provider.
    const composed = schema.allOf || schema.oneOf || schema.anyOf;
    if (composed && !everyBranchIsPrimitive(composed as Json[], document)) {
      offences.push({
        operation: label,
        reason: `${where} parameter "${name}" is not primitive (composed schema)`,
      });
      continue;
    }
    // An array of primitives IS dispatchable: a query one goes on the wire as
    // the parameter repeated, a path one as its elements joined by commas,
    // which are OpenAPI's own defaults for `form`/explode and `simple`.
    // Refusing them cost TfL its entire API — 53 offences, every one an array
    // and nothing else wrong — and was the last thing standing between Asana
    // and GitHub and a connection.
    if (!composed && String(declared) === 'array') {
      const items = (resolveRef(schema.items as Json, document) ?? {}) as Json;
      if (items.allOf || items.oneOf || items.anyOf) {
        if (!everyBranchIsPrimitive((items.allOf ?? items.oneOf ?? items.anyOf) as Json[], document)) {
          offences.push({ operation: label, reason: `${where} parameter "${name}" is an array of composed values` });
          continue;
        }
      } else {
        const itemType = Array.isArray(items.type)
          ? items.type.find((t: unknown) => t && t !== 'null')
          : items.type;
        if (itemType !== undefined && !PRIMITIVE_TYPES.has(String(itemType))) {
          offences.push({
            operation: label,
            reason: `${where} parameter "${name}" is an array of ${String(itemType)}, not of primitives`,
          });
          continue;
        }
      }
    } else if (!composed && declared !== undefined && !PRIMITIVE_TYPES.has(String(declared))) {
      offences.push({
        operation: label,
        reason: `${where} parameter "${name}" is not primitive (${composed ? 'composed schema' : String(declared)})`,
      });
      continue;
    }
    // Serialisation styles. `templated-dispatch` implements exactly one shape
    // per location: `simple` un-exploded for a path parameter, `form` exploded
    // for a query one — which are the OpenAPI defaults. Anything else changes
    // how the value must be written on the wire.
    const style = param.style;
    if (where === 'header') {
      // A header is written as its value and nothing else; the style rules
      // below are about how a value is put into a URL.
      continue;
    }
    if (where === 'path' && style !== undefined && style !== 'simple') {
      offences.push({ operation: label, reason: `path parameter "${name}" declares style "${String(style)}"` });
      continue;
    }
    if (where === 'query' && style !== undefined && style !== 'form') {
      offences.push({ operation: label, reason: `query parameter "${name}" declares style "${String(style)}"` });
      continue;
    }
    if (where === 'path' && param.explode === true) {
      offences.push({ operation: label, reason: `path parameter "${name}" declares explode` });
      continue;
    }
    // `explode: false` on a query parameter is the elements joined by commas
    // rather than the parameter repeated — one value instead of several, which
    // is a form the builder writes. Asana declares it on `opt_fields` and was
    // refused for it after everything else about that API became connectable.
    if (where === 'query' && param.explode === false) {
      const declaredType = Array.isArray(schema.type)
        ? schema.type.find((t: unknown) => t && t !== 'null')
        : schema.type;
      if (declaredType !== undefined && String(declaredType) !== 'array') {
        offences.push({
          operation: label,
          reason: `query parameter "${name}" declares explode: false on something that is not a list`,
        });
      }
    }
  }
}

function checkRequestBody(op: Json, document: Json, label: string, offences: Offence[], method: string): void {
  // A body declared on a GET or a HEAD is never sent — the dispatcher writes
  // one only for a write — so whatever it says cannot stop the operation
  // working. Trakt declares a scalar body on four reads and lost its whole API
  // to it. Refusing a payload we would not put on the wire is refusing
  // something that does not happen.
  if (method === 'GET' || method === 'HEAD') return;
  const body = derefLocal(op.requestBody as Json | undefined, document);
  if (!body) return;
  const content = (body.content ?? {}) as Record<string, Json>;
  const mediaTypes = Object.keys(content);
  if (mediaTypes.length === 0) return;
  // Four encodings are written from what a model sends. JSON and the form
  // encoding carry an object; multipart and a raw binary body carry a FILE,
  // which a model names rather than holds — the id of something already in
  // the workspace, whose bytes are fetched at dispatch and never pass through
  // a model. JSON wins when a provider offers it, because it carries structure
  // and types without a convention standing in for them.
  const json = mediaTypes.find((m) => m === 'application/json' || m.endsWith('+json'));
  const form = mediaTypes.find((m) => m === 'application/x-www-form-urlencoded');
  const multipart = mediaTypes.find((m) => m === 'multipart/form-data');
  const binary = mediaTypes.find((m) => {
    const schema = (content[m]?.schema ?? {}) as Json;
    return schema.format === 'binary' || (schema.type === 'string' && m !== 'text/plain');
  });
  const chosen = json ?? form ?? multipart ?? binary;
  if (!chosen) {
    offences.push({
      operation: label,
      reason: `request body is ${mediaTypes.join(', ')} and not JSON`,
    });
    return;
  }
  const schema = (content[chosen]?.schema ?? {}) as Json;
  // A body that is a bare scalar is still refused on the encodings that carry
  // an object: there is no field to put it in and no convention for one.
  if ((chosen === json || chosen === form)
    && (schema.format === 'binary' || schema.type === 'string')) {
    offences.push({ operation: label, reason: 'request body is a binary or scalar payload, not a JSON object' });
  }
}

/**
 * Check an OpenAPI document against what the dispatcher can execute.
 *
 * Returns a refusal naming the offending operations, or null when every
 * operation in it is one we can build a real request for.
 */
/** One operation that will not be connected, and why. */
export interface SkippedOperation {
  operation: string;
  reason: string;
}

/** What a specification gives, and what it does not. */
export interface SpecificationReview {
  /** A problem with the DOCUMENT. Nothing in it can be connected. */
  refusal: CustomApiRefusal | null;
  /** Operations left out. The connection is made without them. */
  skipped: SkippedOperation[];
}

export function checkSupportedSubset(
  spec: CustomApiSpec,
  document: Json,
): SpecificationReview {
  // OpenAPI 3.x only. A Swagger 2.0 document describes parameters and bodies
  // differently enough that reading it as 3.x produces operations that look
  // right and dispatch wrong.
  const version = typeof document.openapi === 'string' ? document.openapi : '';
  if (!version.startsWith('3.')) {
    return {
      refusal: {
        refused: 'unsupported_specification',
        message: document.swagger
          ? 'That is a Swagger 2.0 document. This connects an OpenAPI 3.x specification.'
          : 'That document does not declare an OpenAPI 3.x version.',
      },
      skipped: [],
    };
  }

  const hostRefusal = checkDeclaredHosts(spec, document);
  if (hostRefusal) return { refusal: hostRefusal, skipped: [] };

  const offences: Offence[] = [];

  const paths = (document.paths ?? {}) as Record<string, Json>;
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue;
    if (!path.startsWith('/')) {
      offences.push({ operation: path, reason: 'the path is not relative to the server' });
      continue;
    }
    if (item.servers) {
      offences.push({ operation: path, reason: 'the path declares its own servers, overriding the hosts consented to' });
      continue;
    }
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']) {
      const op = item[method] as Json | undefined;
      if (!op) continue;
      const label = operationLabel(method, path);
      if (!SUPPORTED_METHODS.has(method.toUpperCase())) {
        offences.push({ operation: label, reason: `${method.toUpperCase()} is not a method the dispatcher sends` });
        continue;
      }
      if (op.servers) {
        offences.push({ operation: label, reason: 'the operation declares its own servers, overriding the hosts consented to' });
        continue;
      }
      if (op.callbacks && Object.keys(op.callbacks as Json).length > 0) {
        offences.push({ operation: label, reason: 'the operation declares callbacks, which this connection cannot receive' });
        continue;
      }
      checkParameters(op, document, label, offences, spec);
      checkRequestBody(op, document, label, offences, method.toUpperCase());
    }
  }

  return { refusal: null, skipped: offences };
}

/**
 * What a specification would give this connection, and what it would not.
 *
 * A `refusal` is about the DOCUMENT: not OpenAPI 3.x, or describing servers
 * the person never consented to. Nothing in such a document can be connected
 * and there is nothing to choose between.
 *
 * `skipped` is per operation, and it is not a refusal. A provider is not its
 * worst endpoint: DocuSign has three operations that upload a PNG, a PDF and a
 * multipart form out of 393, GitHub eleven out of 845, Asana four out of 167 —
 * and refusing the specification meant a person asking for an API got nothing
 * because a handful of its endpoints are shapes we do not send. They get the
 * rest, and they are told exactly what they did not get.
 */
export function reviewSpecification(
  spec: CustomApiSpec,
  document: Json,
): SpecificationReview {
  return checkSupportedSubset(spec, document);
}

/**
 * Is the connection that an EDIT would produce one that can still reach
 * anything?
 *
 * Pure, and checked on the MERGED result rather than field by field, because
 * the two fields only mean something together: a new base URL against the old
 * hosts, and new hosts that no longer contain the old base URL, are the same
 * mistake from opposite directions and both produce a connection whose every
 * call its own host check refuses.
 *
 * The base URL's host is the only one that has to be in the list. Registration
 * refuses an absolute path and an operation-level `servers` override, so every
 * operation is relative to the base URL and there is no second host an
 * operation could be on.
 */
export function checkEditedConnection(
  current: { baseUrl: string; apiHosts: readonly string[] },
  changes: { baseUrl?: string; apiHosts?: string[] },
): CustomApiRefusal | null {
  const baseUrl = changes.baseUrl ?? current.baseUrl;
  const apiHosts = changes.apiHosts ?? [...current.apiHosts];
  if (!baseUrl.startsWith('https://')) {
    return {
      refused: 'host_not_consented',
      message: 'The connection must be over https. A plain address would put the credential on the wire in the clear.',
    };
  }
  const host = hostOf(baseUrl);
  if (!host) {
    return {
      refused: 'host_not_consented',
      message: `${baseUrl} is not an address a request can be built from.`,
    };
  }
  if (apiHosts.length === 0) {
    return {
      refused: 'host_not_consented',
      message: 'A connection with no hosts can reach nothing. List the hosts it may call.',
    };
  }
  if (!hostAllowed(host, apiHosts)) {
    return {
      refused: 'host_not_consented',
      message: `The base address would be on ${host}, which is not one of the hosts this connection would then list (${apiHosts.join(', ')}).`,
    };
  }
  return null;
}
