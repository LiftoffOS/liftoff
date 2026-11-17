// A single deterministic run through the write gate, on real infrastructure.
//
// The gate's telemetry is a shadow metric, and a shadow metric is only worth
// what its denominator is worth: `would_block == 0` reads identically whether
// every write was provenanced or the gate never evaluated anything. Aggregates
// cannot tell those apart. One invocation making three KNOWN calls in a known
// order can.
//
// Three calls, one invocationId, no model in the loop:
//
//   1. a READ that declares returnsIds        → provenance_recorded
//   2. a WRITE naming an id that read returned → provenance_pass
//   3. a WRITE naming an id nothing returned   → provenance_would_block
//
// The third call's payload is deliberately incomplete so the vendor rejects it
// on arrival. The gate decides BEFORE dispatch, so its verdict is unaffected,
// and the run leaves nothing behind in a real mailbox — which matters because
// the connector this runs against is a shared support inbox, and a trace that
// marks somebody's mail read or drafts a reply into it is not a trace anyone
// should run twice.
//
// Env: TRACE_TENANT_ID, TRACE_AGENT_ID, TRACE_CONNECTOR_ID (the gmail
// connector's UUID), TRACE_CONNECTOR_TYPE (default google_mail).

import { randomUUID } from 'crypto';
import { ToolGatewayService } from '../tool-gateway/service';
import { initToolSchemaCache, getToolSchema, getToolSchemas } from '../connectors/tool-schema-cache';
import { loadSecretsToEnv } from '../infrastructure/secrets';

const OUT: string[] = [];
const say = (s: string): void => {
  OUT.push(s);
   
  console.log(s);
};

async function main(): Promise<void> {
  const tenantId = process.env.TRACE_TENANT_ID;
  const agentId = process.env.TRACE_AGENT_ID;
  const connectorId = process.env.TRACE_CONNECTOR_ID;
  const connectorType = process.env.TRACE_CONNECTOR_TYPE ?? 'google_mail';
  if (!tenantId || !agentId || !connectorId) {
    throw new Error('TRACE_TENANT_ID, TRACE_AGENT_ID and TRACE_CONNECTOR_ID are required');
  }

  // The service does this at boot; a script that skips it reaches
  // connector-service with no credential and gets [unauthenticated], which
  // surfaces as an EMPTY catalog rather than an error — and an empty catalog is
  // indistinguishable from "this connector declares nothing".
  await loadSecretsToEnv();
  await initToolSchemaCache();

  // Prove the declarations are REACHABLE before making any call. This is the
  // step that would have caught the key-space bug: the gate resolved the
  // catalog through the action-ledger's hyphenated namespace, so every
  // underscore-typed connector returned nothing and the gate silently never
  // fired. A trace that skipped straight to dispatch would have shown three
  // clean calls and no gate activity, and "no gate activity" is precisely what
  // a working gate looks like when nothing is wrong.
  const read = getToolSchema(connectorType, 'list_messages');
  const write = getToolSchema(connectorType, 'create_draft');
  say(`catalog: list_messages returnsIds=${JSON.stringify(read?.returnsIds)}`);
  say(`catalog: create_draft   idArgs=${JSON.stringify(write?.idArgs)}`);

  // Three failures look alike from here and have nothing in common, so say
  // which one it is. Guessing cost two runs: an empty catalog reads exactly
  // like a connector that declares nothing, because both answer `undefined`.
  const all = getToolSchemas(connectorType);
  if (all.length === 0) {
    throw new Error(
      `the catalog is EMPTY for ${connectorType}. That is infrastructure, not declarations: `
      + 'the schema cache could not load. Check CONNECTOR_SERVICE_URL is set and that secrets '
      + 'were hydrated — an unauthenticated ListTools yields an empty catalog rather than an error.',
    );
  }
  if (!read?.returnsIds?.length || !write?.idArgs?.length) {
    throw new Error(
      `the catalog has ${all.length} tools for ${connectorType} but the declarations are missing. `
      + 'Either this connector was never declared, or the gate is resolving the catalog in the '
      + 'wrong key space — the two are indistinguishable from a caller and the second one is a bug.',
    );
  }

  const svc = new ToolGatewayService();
  const invocationId = randomUUID();
  say(`invocationId: ${invocationId}`);

  const base = {
    tenantId,
    agentId,
    instructionVersion: 1,
    invocationId,
    connector: connectorType,
    bindingsByType: { [connectorType]: { connectorId } },
  };

  // 1. The read.
  const r1 = await svc.execute({
    ...base,
    traceId: randomUUID(),
    idempotencyKey: randomUUID(),
    entityType: 'message',
    actionType: 'list_messages',
    payload: { user_id: 'me', max_results: 3 },
  } as never);
  const items = ((r1 as { data?: { items?: Array<{ threadId?: string }> } }).data?.items) ?? [];
  const seenThread = items.find((m) => m.threadId)?.threadId;
  say(`1. list_messages success=${(r1 as { success?: boolean }).success} items=${items.length} seenThread=${seenThread ?? 'none'}`);
  if (!seenThread) throw new Error('the read returned no thread id, so there is nothing to trace');

  // 2. The write naming what the read returned. Body omitted on purpose: the
  //    gate has already decided by the time this reaches the vendor.
  const r2 = await svc.execute({
    ...base,
    traceId: randomUUID(),
    idempotencyKey: randomUUID(),
    entityType: 'thread',
    actionType: 'create_draft',
    payload: { user_id: 'me', thread_id: seenThread },
  } as never);
  say(`2. create_draft(seen ${seenThread}) success=${(r2 as { success?: boolean }).success}`);

  // 3. The write naming an id nothing returned.
  const invented = `ffffffffffffffff`;
  const r3 = await svc.execute({
    ...base,
    traceId: randomUUID(),
    idempotencyKey: randomUUID(),
    entityType: 'thread',
    actionType: 'create_draft',
    payload: { user_id: 'me', thread_id: invented },
  } as never);
  say(`3. create_draft(unseen ${invented}) success=${(r3 as { success?: boolean }).success}`);

  say('');
  say(`Now read the gate's own lines for invocationId=${invocationId}:`);
  say('  provenance_recorded  (call 1)');
  say(`  provenance_pass      (call 2, unseen=[])`);
  say(`  provenance_would_block (call 3, unseen=["${invented}"])`);
}

main().then(
  () => process.exit(0),
  (err) => {
     
    console.error('provenance-trace failed:', (err as Error).message);
    process.exit(1);
  },
);
