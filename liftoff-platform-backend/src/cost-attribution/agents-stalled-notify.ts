// Agents-stalled notification — single-process helper invoked from the
// reload-drain zero-crossing detection. Resolves plan display + recipient
// email via the standard JOIN pattern and sends the email best-effort.
//
// Triggered from src/cost-attribution/reload-drain.ts at the moment the
// reload bucket is drained to <=0 with auto_reload_enabled=false (industry-
// standard Stripe/Twilio/OpenAI pattern: notify at the consumption write
// site, dedupe via agents_stalled_notified_at flag).

import { getPool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { sendAgentsStalledCreditDepletedEmail } from '../infrastructure/email';
import { composePlanDisplay, STANDARD_PLAN_JOIN_SQL, type PlanRow } from '../billing/plan-display';

export async function notifyAgentsStalled(
  accountId: string,
  ctx: { nextResetDate: Date },
): Promise<void> {
  try {
    const { rows } = await getPool().query<PlanRow>(STANDARD_PLAN_JOIN_SQL, [accountId]);
    if (!rows[0]) return;
    const r = rows[0];
    const { planName } = composePlanDisplay(r);
    await sendAgentsStalledCreditDepletedEmail(r.email, r.first_name ?? 'there', {
      planName,
      nextResetDate: ctx.nextResetDate,
    });
  } catch (err) {
    log.warn({ accountId, error: (err as Error).message }, 'notifyAgentsStalled failed (non-fatal)');
  }
}
