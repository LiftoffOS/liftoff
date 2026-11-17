// Tier-2 evidence for the stage/apply protocol (ADR-052 rule 5), on the first
// pair a person actually lives in: Gmail create_draft → send_draft.
//
// One invocation walks five of the protocol's nine clauses, every step through
// the production functions — the gateway's execute, the HITL service's real
// ask and approve, the repository only ever READ for evidence:
//
//   1. STAGE    create_draft → the batch is minted with a digest over the
//               canonical arguments plus the vendor-returned draft id.
//   2. REFUSE   send_draft before any approval → the apply refuses; nothing
//               is sent.
//   3. GRANT    a real hitl_approval_requests row, approved through
//               approveRequest — which binds the batch (clauses 5 and 6).
//   4. APPLY    send_draft again → claim, ONE real vendor send, settle;
//               the batch is `applied` with the result recorded.
//   5. REPLAY   send_draft a third time → the recorded result, no second
//               send (clause 8).
//
// The email is addressed to the workspace's OWN address (read from
// get_profile), so the one real send this trace performs lands in the inbox
// that ran it. Durable evidence outlives the stdout: the staged_write_batches
// row, the approval row, and one self-addressed email whose subject carries
// the invocation id.
//
// Env: TRACE_TENANT_ID, TRACE_AGENT_ID, TRACE_CONNECTOR_ID (the gmail
// connector's UUID), TRACE_CONNECTOR_TYPE (default google_mail).

import { randomUUID } from 'crypto';
import { ToolGatewayService } from '../tool-gateway/service';
import { stagedBatchRepository } from '../tool-gateway/staged-batches';
import { hitlEnforcementService } from '../hitl-enforcement/service';
import { initToolSchemaCache, getToolSchema, getToolSchemas } from '../connectors/tool-schema-cache';
import { loadSecretsToEnv } from '../infrastructure/secrets';

const say = (s: string): void => {
   
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

  await loadSecretsToEnv();
  await initToolSchemaCache();

  // Prove the PAIR is reachable before dispatching anything. This is the
  // version-skew check: a consumer still on overlays < 0.5.1 serves gmail
  // with no send_draft and no writeRole, and every step below would then
  // "pass" as ordinary unpaired writes — the exact outcome this protocol
  // exists to prevent reading as success.
  const all = getToolSchemas(connectorType);
  if (all.length === 0) {
    throw new Error(
      `the catalog is EMPTY for ${connectorType} — infrastructure, not protocol. `
      + 'Check CONNECTOR_SERVICE_URL and secret hydration first.',
    );
  }
  const stage = getToolSchema(connectorType, 'create_draft');
  const apply = getToolSchema(connectorType, 'send_draft');
  say(`catalog: create_draft writeRole=${stage?.writeRole} paired_apply=${stage?.paired_apply}`);
  say(`catalog: send_draft   writeRole=${apply?.writeRole} idArgs=${JSON.stringify(apply?.idArgs)}`);
  if (stage?.writeRole !== 'stage' || stage?.paired_apply !== 'send_draft' || apply?.writeRole !== 'apply') {
    throw new Error(
      'the pair is not declared in the catalog this runtime sees. Either the consumers have not '
      + 'taken overlays 0.5.1, or the declaration did not survive the merge — read the catalog, '
      + 'not this script, to tell which.',
    );
  }

  const svc = new ToolGatewayService();
  const invocationId = randomUUID();
  say(`invocationId: ${invocationId}`);

  // Dispatch under the INSTANCE alias a real run uses — `<type-with-hyphens>-
  // <first 8 of the connector id>` — not the bare catalog type. The permission
  // validator matches the instruction's allowed connectors exactly, and those
  // are instance aliases; the gateway resolves the alias back to the catalog
  // type itself (catalogTypeFor), so every declaration below still applies.
  const connectorAlias = `${connectorType.replace(/_/g, '-')}-${connectorId.slice(0, 8)}`;
  say(`connector alias: ${connectorAlias}`);

  const base = {
    tenantId,
    agentId,
    instructionVersion: 1,
    invocationId,
    connector: connectorAlias,
    // Keyed on the alias, the same key `resolveBinding` reads `input.connector`
    // under — a map keyed on the bare type is a map the alias is absent from.
    bindingsByType: { [connectorAlias]: { connectorId } },
  };
  const call = (actionType: string, entityType: string, payload: Record<string, unknown>) =>
    svc.execute({
      ...base,
      traceId: randomUUID(),
      idempotencyKey: randomUUID(),
      entityType,
      actionType,
      payload,
    } as never);

  // 0. Self-address: the one real send goes to the inbox that runs the trace.
  const prof = await call('get_profile', 'profile', { user_id: 'me' });
  const selfAddress = ((prof as { data?: { emailAddress?: string } }).data?.emailAddress) ?? '';
  say(`0. get_profile success=${(prof as { success?: boolean }).success} self=${selfAddress || 'MISSING'}`);
  if (!selfAddress) throw new Error('get_profile returned no address; refusing to draft to anybody else');

  // 1. STAGE. The batch mint rides the output-guardrail path the gateway runs
  //    on every route, so a successful create_draft here proves the mint too.
  const r1 = await call('create_draft', 'draft', {
    recipient_email: selfAddress,
    subject: `Stage/apply trace ${invocationId}`,
    body: 'This draft was staged, approved, and sent by stage-apply-trace. One send, to self.',
  });
  const draftId = (r1 as { data?: { id?: string } }).data?.id ?? '';
  say(`1. create_draft success=${(r1 as { success?: boolean }).success} draftId=${draftId || 'MISSING'}`);
  if (!draftId) throw new Error('create_draft returned no draft id; nothing to apply');

  const repo = stagedBatchRepository();
  const staged = await repo.findForApply({
    tenantId, agentId, connector: connectorAlias, applyTool: 'send_draft', applyArgs: { draft_id: draftId },
  });
  say(`   batch: id=${staged?.id} status=${staged?.status} digest=${staged?.digest?.slice(0, 12)}…`);
  if (!staged || staged.status !== 'staged') {
    throw new Error('the stage produced no staged batch — the mint did not fire, and the apply below would refuse for the wrong reason');
  }

  // 2. REFUSE before approval. Nothing must be sent here.
  const r2 = await call('send_draft', 'draft', { draft_id: draftId });
  say(`2. send_draft (unapproved) success=${(r2 as { success?: boolean }).success} error=${String((r2 as { error?: string }).error ?? '').slice(0, 120)}`);
  if ((r2 as { success?: boolean }).success !== false) {
    throw new Error('an UNAPPROVED apply went through — stop and read the gateway before trusting anything else in this trace');
  }

  // 3. GRANT through the real funnel. The ask names the apply call; the
  //    approve binds the batch (clauses 5+6) — never written by hand here.
  const hitl = hitlEnforcementService;
  const toolName = `${connectorAlias}__send_draft`;
  const ask = await hitl.createApprovalRequest({
    tenantId,
    agentId,
    hitlLevel: 2,
    pendingToolCalls: [{ id: 'trace-apply-1', name: toolName, input: { draft_id: draftId } }],
    reason: 'staged_write_batch',
    idempotencyKey: `stage-apply-trace-${invocationId}`,
    invocationId,
    source: 'agent',
    actionSummary: `Send the staged Gmail draft ${draftId} (stage/apply trace)`,
    gateView: { tools: [{ name: toolName, writeRole: 'apply' }] },
  } as never);
  say(`3. ask created: ${ask.id} status=${ask.status}`);
  const decided = await hitl.approveRequest({
    approvalId: ask.id,
    decidedBy: 'stage-apply-trace',
    decidedByRole: 'operator',
  } as never);
  const bound = await repo.get(tenantId, staged.id);
  say(`   approved: ${decided.status}; batch status=${bound?.status} approvalId=${bound?.approvalId ?? 'UNBOUND'}`);
  if (bound?.status !== 'approved') {
    throw new Error('the approval did not bind the batch — the person said yes and the apply below would still refuse');
  }

  // 4. APPLY. One real vendor send, to self.
  const r4 = await call('send_draft', 'draft', { draft_id: draftId });
  const after = await repo.get(tenantId, staged.id);
  say(`4. send_draft (approved) success=${(r4 as { success?: boolean }).success} batch status=${after?.status}`);
  if ((r4 as { success?: boolean }).success !== true || after?.status !== 'applied') {
    throw new Error('the approved apply did not land as applied — read settleStagedApply for this batch');
  }

  // 5. REPLAY. The recorded result, and no second email in anybody's inbox.
  const r5 = await call('send_draft', 'draft', { draft_id: draftId });
  say(`5. send_draft (replay)   success=${(r5 as { success?: boolean }).success} — must be the RECORDED result; the log line is 'staged apply already applied'`);

  say('');
  say('Durable evidence, by id:');
  say(`  staged_write_batches ${staged.id} (staged → approved → applied)`);
  say(`  hitl_approval_requests ${ask.id}`);
  say(`  one email to ${selfAddress}, subject 'Stage/apply trace ${invocationId}'`);
}

main().then(
  () => process.exit(0),
  (err) => {
     
    console.error('stage-apply-trace failed:', (err as Error).message);
    process.exit(1);
  },
);
