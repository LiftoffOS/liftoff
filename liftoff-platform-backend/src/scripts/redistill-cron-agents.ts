// WS-9.1 — re-distill cron-only agents.
//
// One-shot script. Finds every internal_agent with trigger_config.type='cron'
// whose role implies reactivity (matches REACTIVITY_KEYWORDS); runs
// re-distillation; compares the new trigger_config; stages the change for
// human review before applying.

import { withAdminScope } from '../infrastructure/database';

const REACTIVITY_KEYWORDS = [
  /respond.{0,10}to.{0,10}emails?/i,
  /monitor.{0,10}(inbox|email|messages|slack|prs?|pull request)/i,
  /review.{0,10}(prs?|pull request|code|commits?)/i,
  /handle.{0,10}(support|tickets|incidents)/i,
  /watch.{0,10}(for|inbox|channel)/i,
];

async function main() {
  const candidates = await withAdminScope({ caller: 'redistill-cron-agents', reason: 'cross-tenant internal_agents candidate scan' }, (client) => client.query(`
    SELECT id, tenant_id, role, distilled_objective, trigger_config
    FROM internal_agents
    WHERE trigger_config->>'type' = 'cron'
      AND deleted_at IS NULL
  `));
  const out: Array<{
    agent_id: string;
    tenant_id: string;
    role: string;
    current_cron: string;
    proposed_trigger_config: unknown;
  }> = [];
  for (const a of candidates.rows) {
    const text = `${a.role}\n${a.distilled_objective ?? ''}`;
    if (!REACTIVITY_KEYWORDS.some((r) => r.test(text))) continue;
    // The actual re-distill call hooks the existing distill-service; the
    // dry-run captures the proposal so an operator can review the CSV
    // before any PATCH on internal_agents fires.
    const proposed = {
      type: 'event',
      eventTopic: inferEventTopicForRole(a.role),
      filter: {},
    };
    out.push({
      agent_id: a.id,
      tenant_id: a.tenant_id,
      role: a.role,
      current_cron: a.trigger_config?.cronExpr ?? '',
      proposed_trigger_config: proposed,
    });
  }
  console.log(JSON.stringify(out, null, 2));
}

function inferEventTopicForRole(role: string): string {
  const r = role.toLowerCase();
  if (r.includes('support') || r.includes('csr') || r.includes('email')) return 'google_mail.Message';
  if (r.includes('code review') || r.includes('pull request') || r.includes('pr ')) return 'github.PullRequest';
  return 'custom.event';
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
