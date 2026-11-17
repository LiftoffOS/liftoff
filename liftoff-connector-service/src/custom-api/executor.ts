// The executor — which is where the credential boundary already is.
//
// The dispatcher this registers with (`rpc/execute-dispatcher.ts`) already
// resolves the connector's credentials, already routes by connector type, and
// already runs `redactResponseSecrets` over what comes back. So the boundary
// this needs is the one it has, and the executor's own job is small: build the
// request, apply the recorded placement, refuse a destination outside
// `api_hosts`.
//
// NOT the BYOK gateway. `src/byok-gateway` in platform-backend is an LLM
// gateway: usage parsing is not optional there and a vendor path that cannot
// report token usage is not shippable (INV-PB-013, enforced by an enumerating
// test). A REST vendor has no token usage, so a generic lane there would mean
// either breaking that invariant or writing a usage parser that reports
// nothing, which is worse.

import type { JsonObject } from '@bufbuild/protobuf';
import { logger } from '../infra/logging.js';
import {
  registerConnectorExecutor,
  type ExecutorContext,
  type ExecutorResult,
} from '../rpc/execute-dispatcher.js';
import { runTemplatedRequest } from '../clients/templated-dispatch.js';
import { markConnectorReconnectRequired } from '../oauth/connector-ops.js';
import { BlockedHostError, buildCustomApiRequest } from './request.js';
import { encodeBody } from './body.js';
import { storeWorkspaceFile } from './workspace-files.js';
import { buildFileBody } from './file-body.js';
import { isFileResponse, filenameFor } from './file-response.js';
import { getCustomApiConnector } from './repository.js';
import { CUSTOM_API_CONNECTOR_TYPE } from './service.js';
import type { CustomApiConnectorRow } from './types.js';

const CALL_TIMEOUT_MS = 60_000;

function failure(message: string, vendorLatencyMs?: number): ExecutorResult {
  return { result: {}, failure: { message }, ...(vendorLatencyMs !== undefined ? { vendorLatencyMs } : {}) };
}

/** One operation's request, sent. Exported for the executor and for nothing
 *  else; kept separate so the placement and host rules are readable on their
 *  own. */
/** Take the operation's declared header inputs out of what the model sent.
 *
 *  Values are stringified here and nowhere else, so a header always goes on
 *  the wire as one value: a list in a header has no agreed serialisation and a
 *  comma-joined one would be a guess. */
function splitDeclaredHeaders(
  input: Record<string, unknown>,
  headerParams: readonly string[] | undefined,
): { headers: Record<string, string> | undefined; rest: Record<string, unknown> } {
  if (!headerParams?.length) return { headers: undefined, rest: input };
  const headers: Record<string, string> = {};
  const rest: Record<string, unknown> = {};
  const declared = new Set(headerParams);
  for (const [key, value] of Object.entries(input)) {
    if (!declared.has(key) || value === undefined || value === null) {
      if (value !== undefined) rest[key] = value;
      continue;
    }
    headers[key] = Array.isArray(value) ? value.map((v) => String(v)).join(',') : String(value);
  }
  return { headers: Object.keys(headers).length ? headers : undefined, rest };
}

async function callOperation(
  row: CustomApiConnectorRow,
  credential: string,
  agentId: string | undefined,
  method: string,
  path: string,
  body: Record<string, unknown> | undefined,
  query: Record<string, string | string[]> | undefined,
  operationHeaders: Record<string, string> | undefined,
  bodyMediaType: string | undefined,
  deepObjectParams: readonly string[] | undefined,
  joinedArrayParams: readonly string[] | undefined,
  fileParams: readonly string[] | undefined,
): Promise<unknown> {
  const built = buildCustomApiRequest({
    baseUrl: row.baseUrl,
    path,
    query,
    apiHosts: row.apiHosts,
    placement: row.authPlacement,
    credential,
    operationHeaders,
    deepObjectParams,
    joinedArrayParams,
  });

  const headers: Record<string, string> = { ...built.headers };
  let payload: string | FormData | Buffer | undefined;
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    if (fileParams?.length) {
      // The body carries a FILE. A model named one and the bytes are fetched
      // here, from the workspace store, and put on the wire — they never pass
      // through a model and never enter its context.
      const built = await buildFileBody({
        tenantId: row.tenantId,
        body,
        fileParams,
        mediaType: bodyMediaType,
      });
      payload = built.payload;
      // FormData sets its own content type, boundary and all; anything we
      // wrote would be missing the boundary and the provider would reject it.
      if (built.contentType) headers['content-type'] = built.contentType;
      else delete headers['content-type'];
    } else {
      // The encoding the specification declared, and the content type that
      // goes with it. Set here rather than merged, so an operation's own
      // declared `Content-Type` header cannot contradict how the payload was
      // written.
      const encoded = encodeBody(body, bodyMediaType);
      headers['content-type'] = encoded.contentType;
      payload = encoded.payload;
    }
  }

  const response = await fetch(built.url, {
    method,
    headers,
    ...(payload !== undefined ? { body: payload as BodyInit } : {}),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    // `loggableUrl`, never `built.url`: a query-parameter or path-segment
    // placement puts the credential in the URL, and an error message is a
    // place a request gets recorded.
    const err = new Error(
      `${method} ${built.loggableUrl} answered ${response.status}: ${text.slice(0, 500)}`,
    ) as Error & { status: number };
    err.status = response.status;
    throw err;
  }

  if (method === 'HEAD' || response.status === 204) return {};

  // A provider answers with bytes as readily as with JSON, and bytes must not
  // take the JSON path: read as text they reach a model as mangled UTF-8, a
  // successful call that looks like corrupt data. They go to the workspace's
  // one file store and what comes back here is a HANDLE.
  const contentType = response.headers.get('content-type') ?? '';
  if (isFileResponse(contentType)) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) return {};
    const stored = await storeWorkspaceFile({
      tenantId: row.tenantId,
      agentId,
      filename: filenameFor(response, path, contentType),
      mimeType: contentType.split(';')[0]!.trim(),
      bytes,
    });
    return { file: stored };
  }

  const text = await response.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    // A provider that answered 200 with something that is not JSON still
    // answered. Hand it over as text rather than turning a successful call
    // into a failure.
    return { text };
  }
}

export async function customApiExecutor(ctx: ExecutorContext): Promise<ExecutorResult> {
  const row = await getCustomApiConnector(ctx.tenantId, ctx.connectorId);
  if (!row) {
    return failure(
      `custom_api: connection ${ctx.connectorId} has no stored description, so no operation can be dispatched. Reconnect it.`,
    );
  }

  const operation = row.ops.find((op) => op.name === ctx.functionName);
  if (!operation) {
    return failure(
      `custom_api: ${row.name} has no operation named ${ctx.functionName}. Its operations come from the provider's specification, so a name that is not there is not one this connection offers.`,
    );
  }

  const credential = ctx.credentials.apiKey;
  if (!credential) {
    return failure(
      `custom_api: ${row.name} holds no credential. Reconnect it to enter one.`,
    );
  }

  // A declared header is pulled out BEFORE the split, because the split has
  // only two destinations: a read puts everything left into the query and a
  // write puts it into the body. A header left in would silently become one of
  // those and the provider would never see it where it was declared.
  const { headers, rest } = splitDeclaredHeaders(
    ctx.input as Record<string, unknown>,
    operation.headerParams,
  );

  const started = Date.now();
  try {
    const result = await runTemplatedRequest(
      (method: string, path: string, body?: Record<string, unknown>, query?: Record<string, string | string[]>) =>
        callOperation(row, credential, ctx.agentId, method, path, body, query, headers, operation.bodyMediaType, operation.deepObjectParams, operation.joinedArrayParams, operation.fileParams),
      operation.entityType,
      rest,
    );
    const vendorLatencyMs = Date.now() - started;
    const asObject: JsonObject =
      result === null || result === undefined
        ? {}
        : typeof result === 'object'
          ? (JSON.parse(JSON.stringify(result)) as JsonObject)
          : ({ value: result as never } as JsonObject);
    // A bare array is not a JsonObject on the wire; wrap it the way the other
    // executors do so the shape the runtime reads is stable.
    const wrapped: JsonObject = Array.isArray(asObject) ? ({ items: asObject as never } as JsonObject) : asObject;
    return { result: wrapped, vendorLatencyMs };
  } catch (err) {
    const vendorLatencyMs = Date.now() - started;
    if (err instanceof BlockedHostError) {
      logger.warn(
        { tenantId: ctx.tenantId, connectorId: ctx.connectorId, host: err.host },
        'custom_api_blocked_host',
      );
      return failure(`custom_api: ${err.message}`, vendorLatencyMs);
    }
    const status = (err as { status?: number }).status;
    if (status === 401) {
      // The connection is broken until somebody enters a new key, and the
      // Connections page is where they will see that. `error` is what makes
      // the card show and the reconnect available; a connector left `active`
      // with a dead key is the failure this whole flow exists to prevent.
      await markConnectorReconnectRequired(ctx.tenantId, ctx.connectorId, row.providerSlug);
      return failure(
        `custom_api: ${row.name} refused the stored credential (401). The connection is marked as needing a reconnect. A 401 is not proof the key is wrong — placement, host, environment and scope all produce it.`,
        vendorLatencyMs,
      );
    }
    return failure(`custom_api: ${(err as Error).message}`, vendorLatencyMs);
  }
}

registerConnectorExecutor(CUSTOM_API_CONNECTOR_TYPE, customApiExecutor);
