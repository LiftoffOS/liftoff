// What a custom API connection IS, as data.
//
// Five separable concerns and this file holds the first: the DESCRIPTION —
// hosts, scheme, placement, the verification call, purpose. Custody is Secret
// Manager (credentials/service.ts), authorization is the executor, operations
// are generated from the provider's own specification.
//
// Nothing here ever holds a credential. `CustomApiAuthPlacement` says WHERE the
// value goes and never what it is.

/** The API-key-shaped schemes this family supports.
 *
 *  Anything outside these four is declined BY NAME at registration rather than
 *  stored and discovered at dispatch: password-only, copied cookies, request
 *  signing, multi-secret and client-certificate schemes are all refusals with a
 *  reason the assistant can relay. */
export type CustomApiAuthScheme = 'bearer_header' | 'header' | 'query' | 'path';

export interface CustomApiAuthPlacement {
  scheme: CustomApiAuthScheme;
  /** `header`: the header name. `query`: the parameter name. `path`: the
   *  `{placeholder}` the credential fills. Unused by `bearer_header`, which is
   *  `Authorization: Bearer <value>` by definition. */
  name?: string;
  /** A literal prefix before the value on a `header` placement, e.g. `Token `.
   *  Never a credential; never anything the person types. */
  prefix?: string;
}

/** The declared read-only call that decides `active` from `error`.
 *
 *  GET or HEAD, and no other method is accepted for it. A verification that
 *  could change something at the provider is not a verification. */
export interface CustomApiVerification {
  method: 'GET' | 'HEAD';
  /** Relative to `baseUrl`, e.g. `/v1/me`. */
  path: string;
  /** Query parameters the verification call needs, if any. */
  query?: Record<string, string>;
  /** Where the provider exposes an account identity in the response body, as a
   *  dotted path (`data.account.email`). OPTIONAL and declared: an arbitrary
   *  API often exposes nothing of the kind, and the flow must not depend on
   *  it. Where it IS available it is what makes handing the capture link to a
   *  colleague safe — a key for someone's personal account shows on the
   *  connection rather than quietly working. */
  accountIdentityField?: string;
}

/** Everything the provider-documentation read produced, as one object.
 *
 *  This is what platform-backend hands connector-service at registration: the
 *  connection's description, plus the specification to generate operations
 *  from. */
export interface CustomApiSpec {
  /** A stable slug for the provider, e.g. `acme-crm`. Per instance; never
   *  added to the shared catalog. */
  providerSlug: string;
  /** What the person sees on the Connections page. */
  displayName: string;
  /** Every request is built from this, e.g. `https://api.acme.com`. */
  baseUrl: string;
  /** Every host this connection may reach. The executor refuses anything
   *  outside it. */
  apiHosts: string[];
  auth: CustomApiAuthPlacement;
  verification: CustomApiVerification;
  /** Where the OpenAPI 3.x specification was read from. */
  specSourceUrl: string;
  /** A short statement of what the connection is FOR.
   *
   *  Purpose text, not a permission. It belongs on the connection so a person
   *  reading the Connections page knows why it exists, and it is available to
   *  the responsibilities and additional-context text that drives
   *  distillation. It gates nothing. */
  purpose: string;
}

/** One generated operation, as stored on the row and served to the runtime. */
export interface CustomApiOperation {
  /** Model-facing name, from the specification's operationId or its verb and
   *  path. */
  name: string;
  description: string;
  /** `METHOD /path` — the operation template `runTemplatedRequest` parses. */
  entityType: string;
  method: string;
  path: string;
  inputSchema: Record<string, unknown>;
  /** Query parameters the specification declared `deepObject`. Written
   *  bracketed rather than repeated. */
  deepObjectParams?: string[];
  /** Query arrays written as one comma-joined value rather than repeated,
   *  because the specification declared `explode: false`. */
  joinedArrayParams?: string[];
  /** Body properties that carry a FILE: a model names one by workspace file
   *  id and the bytes are fetched at dispatch. */
  fileParams?: string[];
  /** How the body is written. Absent means JSON, which is what almost every
   *  provider wants and what a dispatcher writes without being told. */
  bodyMediaType?: string;
  /** Input properties that go in HEADERS. Everything else a read carries
   *  becomes a query parameter and everything a write carries becomes a body
   *  field, so without this a declared header silently becomes one of those. */
  headerParams?: string[];
  /** The MERGED classification: the conservative seed spec-codegen produces,
   *  unioned with the classifier's answer, never made less restrictive. Holds
   *  BOTH the effect tokens the runtime reads (read / write / destructive /
   *  outbound) and the sensitivity categories the oversight gate matches on
   *  (dataChanges / financialActions / customerCommunication / …), the same
   *  way a seeded classification row does. */
  categories: string[];
}

/** The stored row. */
export interface CustomApiConnectorRow {
  connectorId: string;
  tenantId: string;
  name: string;
  providerSlug: string;
  baseUrl: string;
  apiHosts: string[];
  authScheme: CustomApiAuthScheme;
  authPlacement: CustomApiAuthPlacement;
  verification: CustomApiVerification;
  ops: CustomApiOperation[];
  specSourceUrl: string | null;
  specHash: string;
  specFetchedAt: Date | null;
  /** The hash of the document at `specSourceUrl` as of the last sweep. Drift
   *  is this being present and DIFFERENT from `specHash`; equal means the
   *  connection is up to date. */
  specDriftHash: string | null;
  specDriftCheckedAt: Date | null;
  verifiedAt: Date | null;
  completedByAccountId: string | null;
  attemptId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Why a registration was refused, in the vocabulary the assistant relays.
 *
 *  Named rather than generic: "the specification could not be used" tells a
 *  person nothing they can act on, and the offending operations are exactly
 *  what makes the refusal actionable. */
export type CustomApiRefusalReason =
  | 'unsupported_scheme'
  | 'unsupported_specification'
  | 'host_not_consented'
  | 'too_many_operations'
  | 'no_operations';

export interface CustomApiRefusal {
  refused: CustomApiRefusalReason;
  message: string;
  /** The operations that caused it, named. Empty for a refusal that is not
   *  about operations. */
  operations?: string[];
}

/** What a verification attempt decided, and at which layer it failed.
 *
 *  A 401 is NOT proof the person typed the key wrong: placement, host,
 *  environment and scope come first, and the reason says which layer answered
 *  so the next question is the right one. */
export type CustomApiVerificationLayer =
  | 'authentication'
  | 'permission'
  | 'endpoint'
  | 'rate_limit'
  | 'blocked_host'
  | 'unreachable';

export interface CustomApiVerificationOutcome {
  ok: boolean;
  layer?: CustomApiVerificationLayer;
  /** Human-readable, already free of the credential. */
  message?: string;
  httpStatus?: number;
  /** The provider's own account label, when the specification declared where
   *  to read one and the response carried it. */
  externalAccountLabel?: string;
}
