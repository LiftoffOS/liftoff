// The declared connection description, as this repo holds it.
//
// Platform-backend owns the CONVERSATION half of a custom API connection: the
// workspace action, the confirmation, the capture-token rows and the capture
// page. Connector-service owns the metadata table, the credential write, the
// verification call, the generated operations and the executor — it already
// owns connector ids, credential storage and vendor traffic, and invariant 12
// says this repo's local `connectors` table is a pre-cutover remnant that must
// not be referenced (`custom_mcp_servers` is the documented sole exception, not
// a pattern to copy).
//
// Nothing in this file ever holds a credential. The placement says WHERE the
// value goes and never what it is.

/** The API-key-shaped schemes this family supports. Anything else is declined
 *  BY NAME, with a reason the assistant can relay. */
export type CustomApiAuthScheme = 'bearer_header' | 'header' | 'query' | 'path';

export interface CustomApiAuthPlacement {
  scheme: CustomApiAuthScheme;
  /** `header`: the header name. `query`: the parameter name. `path`: the
   *  `{placeholder}` the credential fills. Unused by `bearer_header`. */
  name?: string;
  /** A literal prefix before the value on a `header` placement, e.g. `Token `. */
  prefix?: string;
}

export interface CustomApiVerification {
  /** A verification is a read. GET or HEAD, and no other method is accepted. */
  method: 'GET' | 'HEAD';
  path: string;
  query?: Record<string, string>;
  /** Where the provider exposes an account identity, as a dotted path.
   *  Optional and declared: an arbitrary API often exposes nothing of the
   *  kind, and the flow must not depend on it. */
  accountIdentityField?: string;
}

export interface CustomApiSpec {
  providerSlug: string;
  displayName: string;
  baseUrl: string;
  apiHosts: string[];
  auth: CustomApiAuthPlacement;
  verification: CustomApiVerification;
  specSourceUrl: string;
  /** What the connection is FOR.
   *
   *  Purpose text, not a permission. It belongs on the connection so a person
   *  reading the Connections page knows why it exists, and it is available to
   *  the responsibilities and additional-context text that drives
   *  distillation. It gates nothing: oversight and the distiller shape what an
   *  agent does with a connection, not a per-operation allow-list. */
  purpose: string;
}

/** A capture-token row, as the service reads it. Never carries the raw token
 *  (only its hash is stored) and never a credential. */
export interface CaptureToken {
  id: string;
  tenantId: string;
  requestedByAccountId: string;
  spec: CustomApiSpec;
  specHash: string;
  attemptId: string;
  reconnectConnectorId: string | null;
  claimedAt: Date | null;
  claimedByAccountId: string | null;
  connectorId: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** The three answers the mint gives, and never a fourth. */
export type RequestApiAccessResult =
  | {
      kind: 'already_connected';
      connectorId: string;
      name: string;
      status: string;
      message: string;
    }
  | {
      kind: 'unsupported_scheme';
      reason: UnsupportedSchemeReason;
      message: string;
    }
  | {
      kind: 'capture_link';
      url: string;
      expiresAt: string;
      provider: string;
      apiHosts: string[];
      operationCount: number | null;
      message: string;
    };

/** The schemes this family declines, by name, so the assistant can say which
 *  one it met rather than "unsupported". */
export type UnsupportedSchemeReason =
  | 'password_only'
  | 'copied_cookies'
  | 'request_signing'
  | 'multi_secret'
  | 'client_certificate';

export const UNSUPPORTED_SCHEME_MESSAGES: Record<UnsupportedSchemeReason, string> = {
  password_only:
    'That service signs in with a username and password rather than issuing a key. A password is a person\'s own credential, so this connection is not one we can hold on their behalf.',
  copied_cookies:
    'That service has no API credential: reaching it would mean copying a browser session. A copied session belongs to one person and one browser, and it stops working without warning.',
  request_signing:
    'That service signs each request with a secret rather than sending it, which needs a signing implementation written for that provider. This family carries a key and places it; it does not sign.',
  multi_secret:
    'That service needs more than one secret together (for example a key and a separate shared secret). This family holds one credential per connection.',
  client_certificate:
    'That service authenticates with a client certificate rather than a key. That is a transport-level credential and is not something this family can place on a request.',
};
