// Telling the person their agents actually exist.
//
// The CAIO ends an approved plan by promising: "They will appear on the Teams
// page shortly." Provisioning then runs as one Cloud Task per spec, each a full
// HRBP model run, so a multi-team plan can take minutes. Without this module
// nothing is said again, and a feature that worked completely looks broken
// because the only thing missing is the sentence at the end.
//
// The gap is structural. The promise is made on the request path; the
// fulfilment happens on a Cloud Tasks path; and otherwise nothing can write to
// a chat thread except a live turn. Every other appendMessage call in this
// service sits behind an HTTP request.
// `workforce_plan.completed` is published, but its own module says the events
// are "for observability and dashboard updates", and platform-backend carries
// the event name only as a string in a TypeScript union with no subscriber.
//
// Failure is the worse half. A plan that fails would leave the person on
// "shortly" forever, with no way to learn that nothing was coming.
//
// Idempotency: the caller posts only after winning the race to mark the plan
// terminal, which exactly one spec task can do. A retry after that point finds
// the plan no longer `provisioning` and never reaches here, so the notice is
// posted at most once. It can be lost if the process dies between the status
// write and the insert, which is the direction to fail in: a customer seeing a
// completion notice twice is worse than seeing it once, late, from the Teams
// page itself.

import { log } from '../infrastructure/logging.js';
import { withTenantContext } from '../infrastructure/rls.js';
import { appendMessage } from './chat-repository.js';
import { mirrorNoticeToLiftoff } from './mirror.js';
import { notifyTeamPlanReply } from './reply-notification.js';
import type { TeamLaunchOutcomes } from './provisioning-launch.js';

/** The fields of a plan spec this module reads. The stored `agents` array holds
 *  the full WorkforcePlanAgentSpec plus the provisioning status HRBP stamps. */
export interface ProvisionedSpec {
  specId?: unknown;
  name?: unknown;
  provisioningStatus?: unknown;
}

/** Written in the product voice on purpose: this text is composed here rather
 *  than by a model, so the rules the CAIO prompt enforces have to be kept by
 *  hand. No em dash, no contractions, and "agent" rather than "agent". */
function joinNames(names: string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The sentence the person reads when provisioning finishes, or null when there
 * is nothing to say.
 *
 * Three terminal spec statuses exist: `completed`, `failed` and `skipped`.
 * Skipped is deliberate non-action (a spec already provisioned on an earlier
 * run), so it is neither announced as created nor reported as a failure, and a
 * plan where every spec was skipped produces no notice at all. Reporting a
 * skipped spec as ready would be the same class of lie as the connector catalog
 * reporting an absent app as unsupported.
 */
export function buildProvisioningNotice(
  specs: readonly ProvisionedSpec[],
  /** What starting each built team came to, when the person chose to launch;
   *  absent when they chose drafts. Keyed by spec id. */
  launches?: TeamLaunchOutcomes,
): string | null {
  const nameOf = (s: ProvisionedSpec, i: number): string =>
    typeof s.name === 'string' && s.name.trim() ? s.name.trim() : `agent ${i + 1}`;

  const created: string[] = [];
  const failed: string[] = [];

  specs.forEach((spec, i) => {
    if (spec.provisioningStatus === 'completed') created.push(nameOf(spec, i));
    else if (spec.provisioningStatus === 'failed') failed.push(nameOf(spec, i));
  });

  if (created.length === 0 && failed.length === 0) return null;

  if (launches) return buildLaunchNotice(specs, nameOf, failed, launches);

  // "start", never "activate" or "launch". The button on the Teams page reads
  // "Start Team" (internalAgents.ts / externalAgents.ts / AgentChatPage.tsx in
  // the frontend; the one "Activate Team" string lives in a Storybook file and
  // is not the live label). This sentence is the last thing a person reads
  // before being asked to do something, so naming a control that does not exist
  // sends them looking for it. The CAIO's matching promise, made when the plan
  // is approved, is pinned to the same word by platform-backend migration 386.
  const one = created.length === 1;
  const startPhrase = `ready for you to review and start ${one ? 'it' : 'them'}.`;

  if (failed.length === 0) {
    const subject = joinNames(created);
    const tail = one
      ? `It is on the Teams page in draft status, ${startPhrase}`
      : `They are on the Teams page in draft status, ${startPhrase}`;
    return `${subject} ${one ? 'is' : 'are'} set up. ${tail}`;
  }

  if (created.length === 0) {
    const subject = joinNames(failed);
    return (
      `${subject} could not be set up, so nothing was created. ` +
      'Ask me to try again when you are ready, and I will take another run at it.'
    );
  }

  return (
    `${joinNames(created)} ${one ? 'is' : 'are'} set up and on the Teams page ` +
    `in draft status, ${startPhrase} ${joinNames(failed)} ` +
    `could not be set up. Ask me to try ${failed.length === 1 ? 'that one' : 'those'} again ` +
    'when you are ready.'
  );
}

/**
 * The sentence when the person chose Launch Now: what each built team came to,
 * in the workspace's own words when it could not start, and the same closing
 * offer for anything that could not be built. A team that could not start is
 * on the Teams page as a draft, and "start it" here is one turn away, so the
 * text says so once rather than per team.
 */
function buildLaunchNotice(
  specs: readonly ProvisionedSpec[],
  nameOf: (s: ProvisionedSpec, i: number) => string,
  failed: string[],
  launches: TeamLaunchOutcomes,
): string {
  const started: string[] = [];
  const held: Array<{ name: string; message: string }> = [];
  specs.forEach((spec, i) => {
    if (spec.provisioningStatus !== 'completed') return;
    const outcome = typeof spec.specId === 'string' ? launches.get(spec.specId) : undefined;
    if (outcome?.started) started.push(nameOf(spec, i));
    else held.push({ name: nameOf(spec, i), message: outcome ? outcome.message : 'It was not started.' });
  });

  const parts: string[] = [];
  if (started.length > 0) {
    parts.push(`${joinNames(started)} ${started.length === 1 ? 'is' : 'are'} set up and started.`);
  }
  for (const h of held) {
    parts.push(`${h.name} is set up but could not start: ${h.message.replace(/\s+$/, '')}`);
  }
  if (held.length > 0) {
    parts.push(
      `${held.length === 1 ? 'It is' : 'They are'} on the Teams page in draft status. ` +
      `Once that is resolved, ask me to start ${held.length === 1 ? 'it' : 'them'} and I will.`,
    );
  }
  if (failed.length > 0) {
    parts.push(
      `${joinNames(failed)} could not be set up. Ask me to try ${failed.length === 1 ? 'that one' : 'those'} again when you are ready.`,
    );
  }
  return parts.join(' ');
}

/** The CAIO thread a plan was drafted in, or null when the plan was not created
 *  through a conversation. The link lives on the thread (`workforce_plan_id`),
 *  so this is the reverse of the lookup the chat turn does. */
async function findPlanThread(tenantId: string, planId: string): Promise<string | null> {
  return withTenantContext(tenantId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM team_plan_threads
        WHERE workforce_plan_id = $1 AND tenant_id = $2
        ORDER BY updated_at DESC
        LIMIT 1`,
      [planId, tenantId],
    );
    return rows[0]?.id ?? null;
  });
}

/**
 * Post the completion notice into the conversation that asked for the plan, and
 * into the Liftoff conversation when the plan came in through one.
 *
 * Never throws. The caller has already recorded the plan's terminal state, and a
 * notice that cannot be delivered must not undo that or fail the Cloud Task,
 * which would retry provisioning work that has already succeeded.
 */
export async function postProvisioningNotice(input: {
  tenantId: string;
  planId: string;
  specs: readonly ProvisionedSpec[];
  /** Per-spec start outcomes when the person chose Launch Now. */
  launches?: TeamLaunchOutcomes;
  /** Who asked: the approver, told where they asked. Absent for a plan with
   *  no recorded approver, which is then told in the thread only. */
  accountId?: string | null;
}): Promise<void> {
  try {
    const content = buildProvisioningNotice(input.specs, input.launches);
    if (!content) return;

    const threadId = await findPlanThread(input.tenantId, input.planId);
    if (!threadId) {
      log.info(
        { event: 'provisioning_notice_no_thread', planId: input.planId, tenantId: input.tenantId },
        'Provisioning finished for a plan with no chat thread — nothing to post into',
      );
      return;
    }

    await appendMessage({
      threadId,
      tenantId: input.tenantId,
      role: 'assistant',
      content,
    });

    log.info(
      { event: 'provisioning_notice_posted', planId: input.planId, tenantId: input.tenantId, threadId },
      'Posted the provisioning completion notice into the plan thread',
    );

    // The team-plan thread is the system of record and is written first, so a
    // failed mirror costs a copy and never the notice. Same contract as
    // platform-backend's mirrorDelegatedReplyToLiftoff, which this calls.
    await mirrorNoticeToLiftoff({
      tenantId: input.tenantId,
      delegateThreadId: threadId,
      content,
    });

    // Then tell the person where they asked. platform-backend decides from
    // the thread's own binding: the Slack DM or Teams chat it is paired with,
    // else the dashboard notice. `via` is null on purpose: this is a message
    // between turns, not the answer to one.
    if (input.accountId) {
      await notifyTeamPlanReply({
        tenantId: input.tenantId,
        accountId: input.accountId,
        threadId,
        text: content,
        via: null,
      });
    }
  } catch (err) {
    log.warn(
      {
        event: 'provisioning_notice_failed',
        planId: input.planId,
        tenantId: input.tenantId,
        error: (err as Error).message,
      },
      'Could not post the provisioning completion notice — the teams themselves are unaffected',
    );
  }
}
