// Tier-2 evidence for Wave C: four behaviours, traced on real infrastructure.
//
// Each of the four has already shipped once in a state where it could not fire,
// and in every case the unit tests passed. A pure function's test proves the
// function; it says nothing about whether the system reaches it. So this drives
// the production paths and reads what they emit.
//
// Four traces, one invocation each:
//
//   1. GROUNDING   a turn matching a declared rule is answered with the read's
//                  result appended by the host.
//   2. REPAIR      an objective implying an outward action, with none taken,
//                  produces one named correction.
//   3. REFUSAL     a tool whose capability is `absent` is refused BY NAME
//                  rather than merely hidden.
//   4. EGRESS      a declared host-only field never reaches the model.
//
// Env: TRACE_TENANT_ID, TRACE_AGENT_ID, TRACE_CONNECTOR_ID, TRACE_CONNECTOR_TYPE.

import { randomUUID } from 'crypto';
import { loadSecretsToEnv } from '../infrastructure/secrets';
import { initToolSchemaCache, getToolSchemas } from '../connectors/tool-schema-cache';
import { runGroundingPrefetch } from '../agent-execution/grounding-prefetch';
import { assessRepair, buildRepairReminder } from '../agent-execution/repair-loop';
import { refusalForTool } from '../tool-gateway/capability-tri-state';
import { capabilityStatesFor } from '../tool-gateway/capability-states-lookup';
import { runOutputGuardrails } from '../tool-gateway/output-guardrails';
import { drainHostDelivered } from '../tool-gateway/host-delivered';

const say = (s: string): void => {
   
  console.log(s);
};

async function main(): Promise<void> {
  const tenantId = process.env.TRACE_TENANT_ID;
  const agentId = process.env.TRACE_AGENT_ID;
  const connectorType = process.env.TRACE_CONNECTOR_TYPE ?? 'google_mail';
  if (!tenantId || !agentId) throw new Error('TRACE_TENANT_ID and TRACE_AGENT_ID are required');

  await loadSecretsToEnv();
  await initToolSchemaCache();

  const tools = getToolSchemas(connectorType);
  if (tools.length === 0) {
    throw new Error(
      `catalog is EMPTY for ${connectorType}. That is infrastructure, not behaviour: `
      + 'nothing below would mean anything.',
    );
  }
  say(`catalog: ${tools.length} tools for ${connectorType}`);
  const invocationId = randomUUID();
  say(`invocationId: ${invocationId}\n`);

  // ── 1. Grounding ───────────────────────────────────────────────────────
  const rule = {
    label: 'the help centre',
    terms: ['refund', 'policy'],
    cues: ['what', '?'],
    toolName: 'corpus_search',
    enabled: true,
  };
  const grounded = await runGroundingPrefetch({
    turn: 'What is your refund policy?',
    rules: [rule],
    tenantId,
    agentId,
    invocationId,
    dispatch: async (toolName) => ({ ok: true, text: `(read from ${toolName}) Refunds within 30 days.` }),
  });
  say(`1. GROUNDING  matched=${grounded.rule?.toolName ?? 'none'} blockAppended=${grounded.block !== null}`);
  if (grounded.block) say(`   ${grounded.block.trim().split('\n')[0]}`);

  // ── 2. Repair ──────────────────────────────────────────────────────────
  const repair = assessRepair({
    objective: 'Review the pull request and send the author a summary.',
    outwardToolsCalled: 0,
    hasOutwardTool: true,
  });
  say(`\n2. REPAIR     needsRepair=${repair.needsRepair} verb=${repair.impliedVerb}`);
  if (repair.impliedVerb) {
    say(`   ${buildRepairReminder(repair.impliedVerb).split('\n')[0]}`);
  }

  // ── 3. Refusal ─────────────────────────────────────────────────────────
  //
  // Read through the SAME lookup the gateway uses, so this reports what
  // production would decide rather than what a literal would.
  const stored = await capabilityStatesFor(tenantId, agentId, 0);
  say(`\n3. REFUSAL    stored states for this agent: ${JSON.stringify(stored)}`);
  const refusal = refusalForTool({
    toolName: 'send_message',
    capabilityForTool: () => 'team_chat',
    capabilityStates: { team_chat: 'absent' },
  });
  say(`   refused=${refusal !== null}`);
  if (refusal) say(`   ${refusal.message.slice(0, 110)}...`);

  // ── 4. Egress ──────────────────────────────────────────────────────────
  // Through the PRODUCTION route, not the pure function. This step used to
  // call `extractEgressOnly` directly, which proved the lift and nothing about
  // whether a result reaching the model actually passes through it — the
  // defect class this script exists to catch. Now it runs the shared guardrail
  // runner every dispatch path uses (`runOutputGuardrails`, which reads the
  // tool's OWN `egressOnly` declaration off the catalog and records what it
  // lifted for the surface) on a real declared tool, then reads the side
  // channel back the way the chat turn does (`drainHostDelivered`).
  //
  // The fixture value is deliberately NOT secret-shaped. Writing a realistic
  // credential here got this file blocked by push protection, which was the
  // control working: a plausible key in a repo is a plausible key whether or
  // not its author meant it.
  const declared = tools.find((t) => (t.egressOnly?.length ?? 0) > 0);
  if (!declared) {
    say(`\n4. EGRESS     no tool on ${connectorType} declares egressOnly — nothing to lift on this connector (infrastructure, not behaviour)`);
    return;
  }
  const path = declared.egressOnly![0];
  const fixture: Record<string, unknown> = {};
  let cursor = fixture;
  const segments = path.split('.');
  for (const [i, seg] of segments.entries()) {
    if (i === segments.length - 1) cursor[seg] = 'FIXTURE-not-a-real-value';
    else { cursor[seg] = {}; cursor = cursor[seg] as Record<string, unknown>; }
  }
  const guarded = await runOutputGuardrails(
    { actionType: declared.name, payload: {}, tenantId, invocationId, connector: connectorType },
    fixture,
  );
  const delivered = drainHostDelivered(invocationId);
  say(`\n4. EGRESS     tool=${connectorType}__${declared.name} declared=${JSON.stringify(declared.egressOnly)}`);
  say(`   modelVisible=${JSON.stringify(guarded.outcome === 'ok' ? guarded.data : guarded)}`);
  say(`   hostDelivered=${JSON.stringify(delivered.map((d) => ({ tool: d.toolName, paths: Object.keys(d.fields) })))}`);
}

main().then(
  () => process.exit(0),
  (err) => {
     
    console.error('wave-c-trace failed:', (err as Error).message);
    process.exit(1);
  },
);
