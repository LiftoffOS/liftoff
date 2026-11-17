// Tier-2 evidence for found-file cards: one download_file through the gateway
// under a real thread id, then the card exists as a file_output row on that
// thread — read back through the same door the chat page reads.
//
// Env: TRACE_TENANT_ID, TRACE_AGENT_ID, TRACE_CONNECTOR_ID (google_drive
// instance UUID), TRACE_FILE_ID (a Drive file the connector can read),
// TRACE_THREAD_ID (an existing chat thread the agent owns).

import { randomUUID } from 'crypto';
import { ToolGatewayService } from '../tool-gateway/service';
import { initToolSchemaCache, getToolSchema } from '../connectors/tool-schema-cache';
import { loadSecretsToEnv } from '../infrastructure/secrets';

const say = (s: string): void => {
   
  console.log(s);
};

async function main(): Promise<void> {
  const tenantId = process.env.TRACE_TENANT_ID!;
  const agentId = process.env.TRACE_AGENT_ID!;
  const connectorId = process.env.TRACE_CONNECTOR_ID!;
  const fileId = process.env.TRACE_FILE_ID!;
  const threadId = process.env.TRACE_THREAD_ID!;
  for (const [k, v] of Object.entries({ tenantId, agentId, connectorId, fileId, threadId })) {
    if (!v) throw new Error(`${k} is required`);
  }
  await loadSecretsToEnv();
  await initToolSchemaCache();
  if (!getToolSchema('google_drive', 'download_file')) throw new Error('google_drive.download_file is not in the catalog');

  const alias = `google-drive-${connectorId.slice(0, 8)}`;
  const invocationId = randomUUID();
  say(`invocationId: ${invocationId}  thread: ${threadId}  alias: ${alias}`);

  const svc = new ToolGatewayService();
  const r = await svc.execute({
    tenantId, agentId, instructionVersion: 1, invocationId, threadId,
    connector: alias,
    bindingsByType: { [alias]: { connectorId } },
    traceId: randomUUID(), idempotencyKey: randomUUID(),
    entityType: 'file', actionType: 'download_file',
    payload: { file_id: fileId },
  } as never);
  const d = (r as { success?: boolean; data?: { id?: string; name?: string; mimeType?: string } });
  say(`1. download_file success=${d.success} id=${d.data?.id} name=${JSON.stringify(d.data?.name)} mime=${d.data?.mimeType}`);
  if (!d.success) throw new Error(`download_file failed: ${(r as { error?: string }).error}`);

  // The registration is fire-and-forget; give it a moment to land before the
  // process exits, so the row exists to be read.
  await new Promise((res) => setTimeout(res, 3000));
  say('2. registration dispatched; read platform-backend for the file_output row on this thread.');
  say('Now read the gateway line: event=found_file_carded for this invocationId.');
}

main().then(() => process.exit(0), (err) => {
   
  console.error('found-file-card-trace failed:', (err as Error).message);
  process.exit(1);
});
