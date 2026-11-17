// Registering and repairing a custom API connection.
//
// This service owns the connector id, the credential write, the verification
// call, the generated operations and the executor — which is why the metadata
// table is here and not in platform-backend, whose invariant 12 says its local
// `connectors` table is a pre-cutover remnant that must not be referenced.
// Platform-backend owns the conversation half: the workspace action, the
// confirmation, the capture tokens and the capture page.
//
// The order is deliberate and is the whole of Phase 3: claim the attempt,
// write the secret, create the connector row, run the declared verification.
// `pending` only while the submit and the verification are in flight; `active`
// after verification succeeds; `error`, carrying the structured reason, when it
// fails. A failed verification must NOT be left `pending` — the Connections
// page filters to `active` and `error` precisely so a broken connector is
// visible and reconnectable, and a `pending` row would be hidden.

import { logger } from '../infra/logging.js';
import { credentialService } from '../credentials/service.js';
import { emitCredentialsStored } from '../events/publisher.js';
import { publishAuditEvent } from '../events/audit-publisher.js';
import {
  createConnector,
  getConnectorById,
  mergeConnectorConfig,
  updateApiKeyHint,
  updateConnectorStatus,
} from '../oauth/connector-ops.js';
import { classifyOperations } from './classify.js';
import {
  applyClassifierAnswers,
  generateOperations,
  rebaseOperationPaths,
  isRefusal,
} from './operations.js';
import {
  findByAttemptId,
  getCustomApiConnector,
  markVerified,
  updateCustomApiConnection,
  upsertCustomApiConnector,
  replaceCustomApiOperations,
} from './repository.js';
import { checkEditedConnection, checkSupportedSubset, customApiSpecSchema } from './spec.js';
import { fetchOpenApiDocument, SpecFetchError } from './spec-fetch.js';
import { runVerification } from './verification.js';
import type {
  CustomApiAuthPlacement,
  CustomApiConnectorRow,
  CustomApiRefusal,
  CustomApiSpec,
  CustomApiVerification,
  CustomApiVerificationOutcome,
} from './types.js';

export const CUSTOM_API_CONNECTOR_TYPE = 'custom_api_connector';

export interface RegisterCustomApiInput {
  tenantId: string;
  /** Who entered the credential. Not always who asked for the link. */
  accountId: string;
  /** Minted by platform-backend on the capture claim. Creation is keyed on it. */
  attemptId: string;
  spec: CustomApiSpec;
  credential: string;
  /** A reconnect targets an existing connection and KEEPS its id, so every
   *  bound team recovers at once. Never delete-and-recreate. */
  reconnectConnectorId?: string;
}

export interface RegisterCustomApiResult {
  connectorId: string;
  status: 'active' | 'error';
  operationCount: number;
  externalAccountLabel?: string;
  /** Present when the status is `error`: which layer answered, and what it
   *  means. */
  verification?: CustomApiVerificationOutcome;
  /** True when this call found an earlier attempt's connector rather than
   *  creating one. */
  reused: boolean;
}

function hintFor(credential: string): string | null {
  return credential.length >= 4 ? `•••${credential.slice(-4)}` : null;
}

/**
 * Register (or reconnect) a custom API connection.
 *
 * Returns a refusal rather than throwing for everything the person can act on:
 * an unsupported specification, a host outside the ones consented to, a
 * specification with more operations than a connection carries.
 */
export async function registerCustomApiConnection(
  input: RegisterCustomApiInput,
): Promise<RegisterCustomApiResult | CustomApiRefusal> {
  const parsed = customApiSpecSchema.safeParse(input.spec);
  if (!parsed.success) {
    return {
      refused: 'unsupported_scheme',
      message:
        'That connection description is not one this family can hold: '
        + parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')} ${i.message}`).join('; '),
    };
  }
  const spec = parsed.data;

  // The attempt id is what makes the idempotency END TO END. Platform-backend
  // claims the capture token atomically, but if this service creates the
  // connector and the response is lost, a retry with the same token would ask
  // it to create a second one. Keyed here, the retry gets the first back.
  const existingAttempt = await findByAttemptId(input.tenantId, input.attemptId);
  if (existingAttempt) {
    const connector = await getConnectorById(input.tenantId, existingAttempt.connectorId);
    logger.info(
      { tenantId: input.tenantId, connectorId: existingAttempt.connectorId, attemptId: input.attemptId },
      'custom_api_register_reused_attempt',
    );
    return {
      connectorId: existingAttempt.connectorId,
      status: connector?.status === 'active' ? 'active' : 'error',
      operationCount: existingAttempt.ops.length,
      reused: true,
    };
  }

  // The specification. Fetched here rather than carried through the
  // conversation, and hashed so Phase 8's change job has something to compare.
  let fetched;
  try {
    fetched = await fetchOpenApiDocument(spec.specSourceUrl);
  } catch (err) {
    if (err instanceof SpecFetchError) {
      return { refused: 'unsupported_specification', message: err.message };
    }
    throw err;
  }

  // A problem with the DOCUMENT refuses; an operation that cannot be
  // dispatched is left out and named. A person asking to connect an API meant
  // the API, not only the endpoints that happen to be shapes we send.
  const review = checkSupportedSubset(spec, fetched.document);
  if (review.refusal) return review.refusal;

  const generated = generateOperations(
    fetched.document,
    spec.baseUrl,
    review.skipped.map((s) => s.operation),
  );
  if (isRefusal(generated)) return generated;

  // ── Everything above this line refuses without creating anything. ──

  let connectorId: string;
  if (input.reconnectConnectorId) {
    const existing = await getConnectorById(input.tenantId, input.reconnectConnectorId);
    if (!existing || existing.type !== CUSTOM_API_CONNECTOR_TYPE) {
      return {
        refused: 'unsupported_scheme',
        message: 'That connection does not exist in this workspace, so there is nothing to reconnect.',
      };
    }
    connectorId = existing.id;
    await updateConnectorStatus(input.tenantId, connectorId, 'pending');
    // The same config the created row carries. A reconnect takes this branch,
    // so writing it only on create left every reconnected connection without
    // the address its card is identified by.
    await mergeConnectorConfig(input.tenantId, connectorId, {
      providerSlug: spec.providerSlug,
      purpose: spec.purpose,
      baseUrl: spec.baseUrl,
    });
  } else {
    const created = await createConnector({
      tenantId: input.tenantId,
      // The catalog type. `custom_api_connector` is the ONE generic type; the
      // provider lives on the row this service writes next.
      type: CUSTOM_API_CONNECTOR_TYPE as never,
      name: spec.displayName,
      // `baseUrl` is on the connector row as well as this service's own,
      // because it is what the Connections card shows underneath the name:
      // one catalog card serves every custom API, so the address a connection
      // calls is what tells two of them apart. The card falls back to the
      // key's masked hint without it, which identifies nothing.
      config: { providerSlug: spec.providerSlug, purpose: spec.purpose, baseUrl: spec.baseUrl },
    });
    connectorId = created.id;
  }

  // Classification, before the row is written, so the stored operations are
  // the ones the oversight gate will read. A classifier that is unreachable
  // leaves every operation on the conservative seed.
  const answers = await classifyOperations({
    tenantId: input.tenantId,
    connectorId,
    operations: generated.operations,
  });
  const ops = applyClassifierAnswers(generated, answers);

  await upsertCustomApiConnector({
    tenantId: input.tenantId,
    connectorId,
    name: spec.displayName,
    providerSlug: spec.providerSlug,
    baseUrl: spec.baseUrl,
    apiHosts: spec.apiHosts,
    authPlacement: spec.auth,
    verification: spec.verification,
    ops,
    specSourceUrl: spec.specSourceUrl,
    specHash: fetched.hash,
    completedByAccountId: input.accountId,
    attemptId: input.attemptId,
  });

  // Custody: the credential goes to Secret Manager through the same path every
  // connector credential takes, and is never held by a model or written to a
  // row.
  await credentialService.storeCredentials(
    input.tenantId,
    connectorId,
    'api_key',
    {
      apiKey: input.credential,
      metadata: { authType: 'custom_api', connectorType: CUSTOM_API_CONNECTOR_TYPE },
    },
    [],
  );

  const outcome = await runVerification({
    baseUrl: spec.baseUrl,
    apiHosts: spec.apiHosts,
    placement: spec.auth,
    verification: spec.verification,
    credential: input.credential,
  });

  const hint = hintFor(input.credential);
  if (hint) await updateApiKeyHint(input.tenantId, connectorId, hint);

  // What this connection IS, beside the provider's own account label: read by
  // the Connections page and by anything that asks why the connection exists.
  await mergeConnectorConfig(input.tenantId, connectorId, {
    providerSlug: spec.providerSlug,
    purpose: spec.purpose,
    // Who finished it, recorded beside the provider's own account label so the
    // person who asked can see who entered the key.
    completedByAccountId: input.accountId,
  });

  // The ONE place a verification outcome becomes a connection's state, shared
  // with re-verification and the edit path so the three cannot disagree about
  // what `active` means — and so a failed verification is `error` on all three
  // rather than `pending` on one. A row left pending is hidden from the
  // Connections page, which is the failure this step exists to prevent.
  await applyVerificationOutcome(input.tenantId, connectorId, outcome);

  // The runtime builds its manifest (and therefore the alias its tools are
  // called by) off this event, so it is emitted whichever way verification
  // went: a connection in `error` is one a person can see and reconnect, and a
  // reconnect that had to re-derive the alias would rename every bound tool.
  emitCredentialsStored({
    tenantId: input.tenantId,
    connectorId,
    connectorType: CUSTOM_API_CONNECTOR_TYPE,
  });

  try {
    await publishAuditEvent({
      tenantId: input.tenantId,
      userId: input.accountId,
      eventType: 'connector.custom_api_connected',
      resourceId: connectorId,
      newState: {
        providerSlug: spec.providerSlug,
        apiHosts: spec.apiHosts,
        operationCount: ops.length,
        status: outcome.ok ? 'active' : 'error',
      },
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message, connectorId }, 'custom_api_audit_publish_failed');
  }

  logger.info(
    {
      tenantId: input.tenantId,
      connectorId,
      providerSlug: spec.providerSlug,
      operationCount: ops.length,
      status: outcome.ok ? 'active' : 'error',
      layer: outcome.layer,
    },
    'custom_api_registered',
  );

  return {
    connectorId,
    status: outcome.ok ? 'active' : 'error',
    operationCount: ops.length,
    ...(outcome.externalAccountLabel ? { externalAccountLabel: outcome.externalAccountLabel } : {}),
    ...(outcome.ok ? {} : { verification: outcome }),
    reused: false,
  };
}

// ── Phase 7: repair and removal ──────────────────────────────────────────
//
// FOUR SEPARATE CONTROLS, AND NONE OF THEM IMPLIES ANOTHER.
//
//   reconnect          a new key on the SAME connector id, so every bound AI
//                      team recovers at once. That is the capture flow above
//                      with `reconnectConnectorId` set; it never creates a
//                      second connection and never renames a tool.
//   revoke             discard OUR copy of the key. The connection, its
//                      description and every binding survive; the connection
//                      goes to `error` and asks for a reconnect. It does NOT
//                      revoke anything at the provider — no API-key scheme has
//                      a revocation endpoint we could call — and saying so is
//                      the point: a person who discards our copy believing
//                      they have revoked the key has revoked nothing.
//   remove             delete the connection (the ordinary disconnect). The
//                      `custom_api_connectors` row cascades with it.
//   remove the schedule   a property of the AI teams bound to it, changed
//                      where schedules are changed. Removing a connection does
//                      not touch a schedule, and stopping a schedule does not
//                      remove a connection.
//
// Hosts, placement and verification are editable in place, without a new key.

/**
 * Re-run the declared verification for a connection whose credential is
 * already in custody.
 *
 * The repair that needs no new key: a connection that went to `error` on a 429,
 * or against an endpoint that was briefly gone, recovers without anybody being
 * asked for anything. It is also what decides the status after an edit — a
 * description that has changed is not a verified one until it has been proven
 * again.
 */
export async function reverifyCustomApiConnection(args: {
  tenantId: string;
  connectorId: string;
}): Promise<CustomApiVerificationOutcome> {
  const row = await getCustomApiConnector(args.tenantId, args.connectorId);
  if (!row) {
    return {
      ok: false,
      layer: 'endpoint',
      message: 'There is no custom API connection with that id in this workspace.',
    };
  }
  let credential: string | undefined;
  try {
    const creds = await credentialService.getCredentials(args.tenantId, args.connectorId);
    credential = creds.apiKey;
  } catch (err) {
    // A credential that cannot be resolved is the same situation as one that
    // was never there, and it is reported as such rather than as a crash.
    logger.warn(
      { tenantId: args.tenantId, connectorId: args.connectorId, err: (err as Error).message },
      'custom_api_reverify_credential_unavailable',
    );
  }
  if (!credential) {
    await updateConnectorStatus(args.tenantId, args.connectorId, 'error');
    return {
      ok: false,
      layer: 'authentication',
      message: 'This connection holds no credential, so there is nothing to verify. Reconnect it to enter one.',
    };
  }
  const outcome = await runVerification({
    baseUrl: row.baseUrl,
    apiHosts: row.apiHosts,
    placement: row.authPlacement,
    verification: row.verification,
    credential,
  });
  await applyVerificationOutcome(args.tenantId, args.connectorId, outcome);
  return outcome;
}

/** The one place a verification outcome becomes a connection's state.
 *
 *  Shared by registration, re-verification and the edit path so the three
 *  cannot disagree about what `active` means. Never `pending`: a row left
 *  pending is hidden from the Connections page, which is the failure this whole
 *  step exists to prevent. */
async function applyVerificationOutcome(
  tenantId: string,
  connectorId: string,
  outcome: CustomApiVerificationOutcome,
): Promise<void> {
  if (outcome.ok) {
    await markVerified(tenantId, connectorId);
    await updateConnectorStatus(tenantId, connectorId, 'active');
  } else {
    await updateConnectorStatus(tenantId, connectorId, 'error');
  }
  await mergeConnectorConfig(tenantId, connectorId, {
    ...(outcome.externalAccountLabel
      ? { externalAccountId: outcome.externalAccountLabel, externalAccountLabel: outcome.externalAccountLabel }
      : {}),
    ...(outcome.ok
      ? { lastVerificationError: null }
      : { lastVerificationError: { layer: outcome.layer, message: outcome.message, httpStatus: outcome.httpStatus } }),
  });
}

/**
 * Edit a connection's description in place, then prove it.
 *
 * Never delete-and-recreate: the connector id is what every bound AI team
 * holds. The verification runs afterwards so an edit that made the connection
 * worse says so on the Connections page rather than sitting green — and an
 * edit that FIXED a broken connection brings it back to `active` with no key
 * re-entered.
 */
/** What re-reading a provider's specification found, and whether it was
 *  taken. */
export interface CustomApiSpecRefresh {
  /** The document at the same address is not the one this connection was
   *  built from. */
  changed: boolean;
  /** The operations were replaced. False on a look, and on a look-alike
   *  document that turned out to be identical. */
  applied: boolean;
  specHash: string;
  previousSpecHash: string;
  /** Operations the provider has since added, and ones it no longer offers.
   *  A removed operation is the one that matters: an AI team bound to it
   *  loses it, which is why nothing is replaced without being said first. */
  added: string[];
  removed: string[];
  operationCount: number;
}

/**
 * Read the provider's specification again.
 *
 * A connection is built from a document fetched once, and nothing has ever
 * read it again: an API that adds an endpoint never offers it here, and one
 * that renames or drops an endpoint leaves a connection whose tools call a
 * place that is not there. The key is fine throughout, so verifying says
 * nothing about it — that answers "is the key still good", and this answers
 * "is this still the API we connected".
 *
 * Two steps on purpose. `apply: false` says what changed and writes nothing,
 * because replacing the operations can REMOVE one and an AI team bound to it
 * loses it; a person is told before that happens. The description stays as it
 * was either way: this reads what the API offers, not where it lives.
 */
export async function refreshCustomApiSpec(args: {
  tenantId: string;
  connectorId: string;
  apply: boolean;
}): Promise<CustomApiSpecRefresh | CustomApiRefusal | null> {
  const row = await getCustomApiConnector(args.tenantId, args.connectorId);
  if (!row) return null;
  if (!row.specSourceUrl) {
    return {
      refused: 'unsupported_specification',
      message:
        'This connection was not set up from a published specification, so there is nothing to read again.',
    };
  }

  let fetched;
  try {
    fetched = await fetchOpenApiDocument(row.specSourceUrl);
  } catch (err) {
    if (err instanceof SpecFetchError) {
      return { refused: 'unsupported_specification', message: err.message };
    }
    throw err;
  }

  // The same document, so the same operations. Nothing to say and nothing to
  // write, whether or not the caller asked to apply.
  if (fetched.hash === row.specHash) {
    return {
      changed: false,
      applied: false,
      specHash: fetched.hash,
      previousSpecHash: row.specHash,
      added: [],
      removed: [],
      operationCount: row.ops.length,
    };
  }

  // A specification that has drifted out of what a connection can dispatch is
  // refused rather than applied. The connection keeps the operations it has,
  // which still work, instead of being replaced with ones that cannot.
  const asSpec: CustomApiSpec = {
    providerSlug: row.providerSlug,
    displayName: row.name,
    baseUrl: row.baseUrl,
    apiHosts: row.apiHosts,
    auth: row.authPlacement,
    verification: row.verification,
    specSourceUrl: row.specSourceUrl,
    purpose: '',
  };
  const review = checkSupportedSubset(asSpec, fetched.document);
  if (review.refusal) return review.refusal;

  const generated = generateOperations(
    fetched.document,
    row.baseUrl,
    review.skipped.map((s) => s.operation),
  );
  if (isRefusal(generated)) return generated;

  const before = new Set(row.ops.map((op) => op.name));
  const after = new Set(generated.operations.map((op) => op.name));
  const added = generated.operations.map((op) => op.name).filter((n) => !before.has(n));
  const removed = row.ops.map((op) => op.name).filter((n) => !after.has(n));

  if (!args.apply) {
    return {
      changed: true,
      applied: false,
      specHash: fetched.hash,
      previousSpecHash: row.specHash,
      added,
      removed,
      operationCount: generated.operations.length,
    };
  }

  // Classified like a registration's: an operation that arrives from a changed
  // document is as new as one that arrives from a first read, and the
  // oversight gate reads what is stored.
  const answers = await classifyOperations({
    tenantId: args.tenantId,
    connectorId: args.connectorId,
    operations: generated.operations,
  });
  const ops = applyClassifierAnswers(generated, answers);
  await replaceCustomApiOperations({
    tenantId: args.tenantId,
    connectorId: args.connectorId,
    ops,
    specHash: fetched.hash,
  });
  // The connection IS the document now, so the card stops saying otherwise.
  await mergeConnectorConfig(args.tenantId, args.connectorId, { specDrifted: false });

  logger.info(
    {
      tenantId: args.tenantId,
      connectorId: args.connectorId,
      added: added.length,
      removed: removed.length,
      operationCount: ops.length,
    },
    'custom_api_spec_reread',
  );

  return {
    changed: true,
    applied: true,
    specHash: fetched.hash,
    previousSpecHash: row.specHash,
    added,
    removed,
    operationCount: ops.length,
  };
}

export async function updateCustomApiConnectionAndVerify(args: {
  tenantId: string;
  connectorId: string;
  changes: {
    name?: string;
    baseUrl?: string;
    apiHosts?: string[];
    authPlacement?: CustomApiAuthPlacement;
    verification?: CustomApiVerification;
  };
}): Promise<
  | { row: CustomApiConnectorRow; verification: CustomApiVerificationOutcome }
  | CustomApiRefusal
  | null
> {
  const current = await getCustomApiConnector(args.tenantId, args.connectorId);
  if (!current) return null;

  // The edited description has to hold together as a WHOLE, not field by
  // field. Pure and tested on its own: this is the rule that decides whether
  // an edit leaves a connection that can reach anything.
  const incoherent = checkEditedConnection(current, args.changes);
  if (incoherent) return incoherent;

  // An operation's path is relative to the base address, so moving the base
  // moves every operation with it. Re-expressed against the new base, an
  // operation that already sits under the new prefix keeps the endpoint it
  // names; one that does not goes where the base was pointed, and a base that
  // only changes host leaves every path untouched.
  const movedBase = typeof args.changes.baseUrl === 'string' && args.changes.baseUrl !== current.baseUrl;
  const row = await updateCustomApiConnection(args.tenantId, args.connectorId, {
    ...args.changes,
    ...(movedBase
      ? { ops: rebaseOperationPaths(current.ops, current.baseUrl, args.changes.baseUrl as string) }
      : {}),
  });
  if (!row) return null;
  const verification = await reverifyCustomApiConnection({
    tenantId: args.tenantId,
    connectorId: args.connectorId,
  });
  logger.info(
    {
      tenantId: args.tenantId,
      connectorId: args.connectorId,
      fields: Object.keys(args.changes),
      verified: verification.ok,
    },
    'custom_api_connection_edited_in_place',
  );
  return { row, verification };
}

