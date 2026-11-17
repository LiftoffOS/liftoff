// The conversation half of a custom API connection: the mint, and the submit.
//
// THE MINT gives three answers and never a fourth — already connected,
// unsupported scheme, or a capture link — and writes a capture-token row and
// NOTHING ELSE. No connector row yet, so an abandoned flow leaves no tile to
// clean up. This deliberately differs from `custom-mcp-servers/service.ts`,
// which creates the connector first and compensates on failure.
//
// THE SUBMIT claims the token atomically, hands the credential and the attempt
// id to connector-service, and writes the connector id back onto the claim. The
// idempotency runs end to end or it only moves the duplicate one service along.

import { randomBytes } from 'crypto';
import { log } from '../infrastructure/logging';
import {
  isCustomApiRefusal,
  listConnectorsForTenant,
  listCustomApiConnections,
  registerCustomApiConnection,
} from '../connectors/connector-service-client';
import { hashToken } from '../tenant-members/tokens';
import {
  CAPTURE_ATTEMPT_STALE_SECONDS,
  CAPTURE_TOKEN_TTL_SECONDS,
  claimCaptureToken,
  createCaptureToken,
  findCaptureTokenByHash,
  recordCaptureConnector,
  releaseCaptureClaim,
} from './repository';
import { checkSpec, hashSpec } from './spec';
import {
  UNSUPPORTED_SCHEME_MESSAGES,
  type CaptureToken,
  type CustomApiSpec,
  type RequestApiAccessResult,
  type UnsupportedSchemeReason,
} from './types';

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';

/** The connector type the shared catalog gained. ONE generic type: the
 *  provider a workspace connects is never added to it. */
export const CUSTOM_API_CONNECTOR_TYPE = 'custom_api_connector';

function captureUrl(token: string): string {
  return `${FRONTEND_URL}/connections/capture/${token}`;
}

/** A capture token is a 256-bit secret; only its hash is stored. */
function mintCaptureToken(): string {
  return `liftoff_cap_${randomBytes(32).toString('base64url')}`;
}

/** A shape a person reads, not the row. The page renders from this, and there
 *  is nothing on it to disclose — a capture token stores no value. */
export interface CaptureView {
  provider: string;
  purpose: string;
  apiHosts: string[];
  /** What the person is being asked for, in one line: which scheme and where
   *  the value goes. */
  credentialLabel: string;
  placementSummary: string;
  verificationSummary: string;
  expiresAt: string;
  /** True once this link has been spent. The page says so rather than taking a
   *  key it will refuse. */
  spent: boolean;
  reconnect: boolean;
}

function placementSummary(spec: CustomApiSpec): string {
  switch (spec.auth.scheme) {
    case 'bearer_header':
      return 'Sent as a bearer token in the Authorization header.';
    case 'header':
      return `Sent in the ${spec.auth.name} header.`;
    case 'query':
      return `Sent as the ${spec.auth.name} query parameter.`;
    case 'path':
      return `Sent as the ${spec.auth.name} segment of the address.`;
  }
}

/** Is this link spent?
 *
 *  It has to answer the SAME question the claim answers, or the page and the
 *  submit disagree: a claim whose attempt died is re-drivable after
 *  CAPTURE_ATTEMPT_STALE_SECONDS, and a page that called it spent would send
 *  the person back to the conversation for a link they already have. Spent
 *  means a connector came out of it, or an attempt is still running. */
function isSpent(token: CaptureToken): boolean {
  if (token.connectorId !== null) return true;
  if (token.claimedAt === null) return false;
  return (Date.now() - token.claimedAt.getTime()) / 1000 <= CAPTURE_ATTEMPT_STALE_SECONDS;
}

function captureViewOf(token: CaptureToken): CaptureView {
  const spec = token.spec;
  return {
    provider: spec.displayName,
    purpose: spec.purpose,
    apiHosts: spec.apiHosts,
    credentialLabel: `${spec.displayName} API key`,
    placementSummary: placementSummary(spec),
    verificationSummary: `Checked with ${spec.verification.method} ${spec.verification.path} before the connection is switched on.`,
    expiresAt: token.expiresAt.toISOString(),
    spent: isSpent(token),
    reconnect: token.reconnectConnectorId !== null,
  };
}

export interface RequestApiAccessInput {
  tenantId: string;
  accountId: string;
  spec: CustomApiSpec;
  /** An assistant that met a scheme this family declines says which one, and
   *  gets the named refusal rather than a link. */
  unsupportedScheme?: UnsupportedSchemeReason;
  /** Reconnecting an existing connection in place, keeping its id, so every
   *  bound team recovers at once. */
  reconnectConnectorId?: string;
}

/**
 * Mint a capture link — or say why there will not be one.
 *
 * Three answers, never a fourth.
 */
export async function requestApiAccess(
  input: RequestApiAccessInput,
): Promise<RequestApiAccessResult> {
  // 1. Unsupported scheme, named. Taken first: an assistant that already knows
  //    the provider cannot be connected must not be made to produce a
  //    description it will then be refused for.
  if (input.unsupportedScheme) {
    return {
      kind: 'unsupported_scheme',
      reason: input.unsupportedScheme,
      message: UNSUPPORTED_SCHEME_MESSAGES[input.unsupportedScheme],
    };
  }

  // Defence in depth, and deliberately a THROW rather than a fourth answer.
  //
  // The tool refuses an unusable description at preview, before anything is
  // minted, so by here it has already been checked. Returning
  // `unsupported_scheme` for it would name a reason that is not true — a
  // malformed description is not a password-only or multi-secret provider —
  // and a refusal that says the wrong thing sends the assistant to fix the
  // wrong thing. Three answers, never a fourth: this is not one of them.
  const check = checkSpec(input.spec);
  if (!check.ok) {
    throw new Error(check.message ?? 'That connection description is not one this family can hold.');
  }

  // 2. Already connected. Name the existing connection rather than minting a
  //    second one beside it — unless this is a deliberate reconnect.
  if (!input.reconnectConnectorId) {
    const existing = await findExistingConnection(input.tenantId, input.accountId, input.spec);
    if (existing) return existing;
  }

  // 3. A capture link.
  const raw = mintCaptureToken();
  const specHash = hashSpec(input.spec);
  const token = await createCaptureToken({
    tenantId: input.tenantId,
    requestedByAccountId: input.accountId,
    tokenHash: hashToken(raw),
    spec: input.spec,
    specHash,
    ...(input.reconnectConnectorId ? { reconnectConnectorId: input.reconnectConnectorId } : {}),
  });

  log.info(
    {
      tenantId: input.tenantId,
      accountId: input.accountId,
      provider: input.spec.providerSlug,
      captureTokenId: token.id,
      reconnect: Boolean(input.reconnectConnectorId),
    },
    'custom api capture link minted',
  );

  return {
    kind: 'capture_link',
    url: captureUrl(raw),
    expiresAt: token.expiresAt.toISOString(),
    provider: input.spec.displayName,
    apiHosts: input.spec.apiHosts,
    // The specification has not been read yet — connector-service fetches it
    // at registration — so the count is genuinely unknown here rather than
    // guessed. Stated as null rather than as a number nobody measured.
    operationCount: null,
    message:
      `Open this link within the hour and enter the ${input.spec.displayName} key. `
      + 'Anyone in the workspace who can manage connections may complete it, so it can go to whoever holds the key.',
  };
}

/** Is this provider already connected in this workspace? */
async function findExistingConnection(
  tenantId: string,
  accountId: string,
  spec: CustomApiSpec,
): Promise<RequestApiAccessResult | null> {
  let connections;
  try {
    connections = await listCustomApiConnections(tenantId, accountId);
  } catch (err) {
    // A connector-service that cannot be reached is not evidence that nothing
    // is connected. Minting a link is the recoverable outcome — a duplicate
    // connection can be removed; a refusal to connect at all cannot be undone
    // from the conversation.
    log.warn(
      { tenantId, provider: spec.providerSlug, error: (err as Error).message },
      'custom api: could not read existing connections before minting a link',
    );
    return null;
  }
  const hosts = new Set(spec.apiHosts.map((h) => h.toLowerCase()));
  const match = connections.find(
    (c) =>
      c.providerSlug === spec.providerSlug
      || c.apiHosts.some((h) => hosts.has(h.toLowerCase())),
  );
  if (!match) return null;

  const rows = await listConnectorsForTenant(tenantId, accountId).catch(() => []);
  const row = rows.find((r) => r.id === match.connectorId);
  const status = row?.status ?? 'active';
  return {
    kind: 'already_connected',
    connectorId: match.connectorId,
    name: match.name,
    status,
    message:
      status === 'error'
        ? `${match.name} is already connected in this workspace and is currently in error. Reconnect it rather than adding a second connection.`
        : `${match.name} is already connected in this workspace, with ${match.operationCount} operations available.`,
  };
}

export type CaptureSubmitResult =
  | {
      kind: 'connected';
      connectorId: string;
      status: 'active' | 'error';
      operationCount: number;
      externalAccountLabel?: string;
      verification?: { ok: boolean; layer?: string; message?: string; httpStatus?: number };
    }
  | { kind: 'in_progress'; message: string }
  | { kind: 'expired'; message: string }
  | { kind: 'not_found'; message: string }
  | { kind: 'refused'; reason: string; message: string; operations?: string[] };

/**
 * Complete a capture: claim the token, register, write the connector id back.
 *
 * The permission is re-checked by the ROUTE at submit — a role can change
 * inside the hour, and the mint's check is an hour old by construction.
 */
export async function submitCapture(args: {
  tenantId: string;
  accountId: string;
  token: string;
  credential: string;
}): Promise<CaptureSubmitResult> {
  const tokenHash = hashToken(args.token);
  const claim = await claimCaptureToken({
    tenantId: args.tenantId,
    tokenHash,
    accountId: args.accountId,
  });

  if (claim.kind === 'not_found') {
    return { kind: 'not_found', message: 'That link is not one this workspace issued.' };
  }
  if (claim.kind === 'expired') {
    return {
      kind: 'expired',
      message: 'That link has expired. Ask for a new one in the conversation where it came from.',
    };
  }
  if (claim.kind === 'in_progress') {
    return {
      kind: 'in_progress',
      message: 'This link is already being completed. Give it a moment and reload the page.',
    };
  }
  if (claim.kind === 'already_connected') {
    // The first submit finished and this is a repeat. Return ITS result rather
    // than producing a second connection — read back rather than assumed, so
    // a repeat submit says the same thing the first one said, including when
    // the first one ended in `error`.
    const connectorId = claim.token.connectorId as string;
    const [connections, rows] = await Promise.all([
      listCustomApiConnections(args.tenantId, args.accountId).catch(() => []),
      listConnectorsForTenant(args.tenantId, args.accountId).catch(() => []),
    ]);
    const connection = connections.find((c) => c.connectorId === connectorId);
    const row = rows.find((r) => r.id === connectorId);
    return {
      kind: 'connected',
      connectorId,
      status: row?.status === 'error' ? 'error' : 'active',
      operationCount: connection?.operationCount ?? 0,
    };
  }

  // 'claimed' (this submit owns the attempt) and 'redrive' (an earlier one
  // claimed it and died) both register, against the SAME attempt id — which is
  // what makes the re-drive find the first connector rather than create a
  // second.
  const token = claim.token;
  let result;
  try {
    result = await registerCustomApiConnection({
      tenantId: args.tenantId,
      accountId: args.accountId,
      attemptId: token.attemptId,
      spec: token.spec as unknown as Record<string, unknown>,
      credential: args.credential,
      ...(token.reconnectConnectorId ? { reconnectConnectorId: token.reconnectConnectorId } : {}),
    });
  } catch (err) {
    // Connector-service was not reached, or answered something that is not a
    // refusal. The claim is released so the same link can be used again: past
    // this point a retry is safe on the attempt id, and before it there is
    // nothing to be idempotent about.
    await releaseCaptureClaim({ tenantId: args.tenantId, tokenHash });
    log.error(
      { tenantId: args.tenantId, captureTokenId: token.id, error: (err as Error).message },
      'custom api capture submit failed',
    );
    return {
      kind: 'refused',
      reason: 'registration_failed',
      message: 'The connection could not be set up just now. Try the link again in a moment.',
    };
  }

  if (isCustomApiRefusal(result)) {
    // A named refusal about the SPECIFICATION. The link is released so a
    // corrected description can be tried without asking for a new one.
    await releaseCaptureClaim({ tenantId: args.tenantId, tokenHash });
    return {
      kind: 'refused',
      reason: result.refused,
      message: result.message,
      ...(result.operations ? { operations: result.operations } : {}),
    };
  }

  await recordCaptureConnector({
    tenantId: args.tenantId,
    tokenHash,
    connectorId: result.connectorId,
  });

  log.info(
    {
      tenantId: args.tenantId,
      accountId: args.accountId,
      connectorId: result.connectorId,
      status: result.status,
      operationCount: result.operationCount,
      reused: result.reused,
    },
    'custom api connection completed',
  );

  return {
    kind: 'connected',
    connectorId: result.connectorId,
    status: result.status,
    operationCount: result.operationCount,
    ...(result.externalAccountLabel ? { externalAccountLabel: result.externalAccountLabel } : {}),
    ...(result.verification ? { verification: result.verification } : {}),
  };
}

/** The capture page's read. Discloses nothing: a capture token stores no
 *  value, and this returns the declared description and the state of the
 *  link. */
export async function readCapture(args: {
  tenantId: string;
  token: string;
}): Promise<CaptureView | null> {
  const row = await findCaptureTokenByHash(args.tenantId, hashToken(args.token));
  if (!row) return null;
  return captureViewOf(row);
}

export { CAPTURE_TOKEN_TTL_SECONDS };
