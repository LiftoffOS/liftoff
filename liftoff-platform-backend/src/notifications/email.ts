// Notification email renders. Each render function:
//   1. Builds the body via the exported buildParagraph/buildList/etc. helpers
//   2. Appends the unsubscribe footer + List-Unsubscribe header pair via appendUnsubscribeFooter
//   3. Calls buildEmail with rawHtml to wrap in the standard Liftoff scaffold
//   4. Calls sendEmail with the headers
//
// All notification templates are switched to body-via-rawHtml so a single helper
// uniformly appends the unsubscribe footer across all email types.

import {
  buildEmail,
  sendEmail,
  buildParagraph,
  buildListIntro,
  buildList,
  buildCTA,
} from '../infrastructure/email';
import { EMAIL_COLORS } from '../infrastructure/email/shared';
import type { NotificationRow, NotificationType } from './types';
import type { Account } from '../accounts/types';
import {
  buildEmailUnsubscribeUrl,
  buildListUnsubscribeUrl,
  type UnsubscribeAction,
} from './unsubscribe';

// Resolved at module load. initSecrets() in src/index.ts hydrates env BEFORE
// anything else, so the constants are populated by the time any handler runs.
// Default fallback is the production public URL; Cloud Run env overrides per environment.
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'https://example.com';
const SETTINGS_LINK = `${FRONTEND_URL}/dashboard/settings/communication`;
const ACTIVITY_LINK = `${FRONTEND_URL}/dashboard/activity`;
const REVIEW_LINK = `${FRONTEND_URL}/dashboard/review`;

// HTML-escape caller-supplied strings before interpolating them into the body.
// Notification payloads come from internal callers (PB-native fanout in
// agent-audit-logs / hitl-late-feedback, plus future cross-repo callers in
// governance-engine + tenant-runtime), but those values originate from
// human-controlled DB columns (agent names, tenant names, user inputs). A
// stray '<' or '"' would otherwise break out of the surrounding HTML tag.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Sanitize text destined for the email Subject: / X-Preheader (plain-text
// header fields, NOT HTML). Strips CRLF (prevents header injection of e.g.
// Bcc: lines) and angle brackets (kept consistent with the existing
// sanitizeForEmail helper in src/infrastructure/email/index.ts). No length
// cap here; the body Zod schemas already cap inputs.
//
// Exported so the newsletter broadcast router can apply the same protection
// to operator-supplied subject/preheader strings.
export function sanitizeForHeader(s: string): string {
  return s.replace(/[\r\n]/g, '').replace(/[<>]/g, '');
}

/** The first line of an escalation email.
 *
 *  "needs your approval" was written when every one of these was a queue item
 *  awaiting a decision. It is wrong for all three cases now: a parked blocker
 *  wants an action taken elsewhere, a clarification wants an answer, and a
 *  terminal escalation wants nothing at all from the reader except that they
 *  know. Saying "approval" invites someone to go looking for an Approve button
 *  that does not exist.
 *
 *  Copy rules: never the word "agent" (the team's name stands in), no em
 *  dashes, no contractions. */
export function escalationLeadLine(agentName: string, recordKind: string | undefined): string {
  switch (recordKind) {
    case 'blocker':
      return `${agentName} cannot continue until someone acts.`;
    case 'clarification':
      return `${agentName} is waiting on an answer.`;
    default:
      return `${agentName} stopped and needs you to know why.`;
  }
}

// Validate caller-supplied URLs before placing them in an href. We accept only
// http(s) absolute URLs and fall back to a known-safe internal link otherwise.
// Prevents `javascript:`, `data:`, and href-break-out attacks via mangled strings.
function safeHref(url: string | undefined, fallback: string): string {
  if (!url) return fallback;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return url;
  } catch {
    /* malformed URL → fallback */
  }
  return fallback;
}

// Inject inline brand styles (Liftoff orange, no underline) onto every <a>
// tag in a block of operator-supplied HTML that doesn't already declare its
// own style. Email clients otherwise render anchors with their built-in
// default of blue + underline, which doesn't match the rest of the brand.
//
// Inline (not a <style> block) because Gmail web strips most <style>
// declarations from the head. Inline survives.
//
// Exported so the newsletter broadcast can transform operator HTML; the
// code-built notification bodies (task-update / digest / etc.) don't have
// raw <a> tags — they use buildCTA, which already emits inline styles.
export function styleAnchorsInHtml(html: string): string {
  return html.replace(/<a\b([^>]*)>/gi, (match, attrs: string) => {
    if (/\bstyle\s*=/i.test(attrs)) return match; // caller already styled — respect their choice
    return `<a${attrs} style="color:${EMAIL_COLORS.accent};text-decoration:none;">`;
  });
}

const TYPE_TEMPLATE_KEY: Record<NotificationType, string> = {
  task_update: 'task-update',
  agent_activity: 'team-activity',
  escalation: 'escalation',
};

// Per-template unsubscribe wiring. ACTION_FOR_TEMPLATE drives both the in-body link
// (lands on FE → GlobalUnsubscribeHandler) and the List-Unsubscribe header (lands
// directly on backend for Gmail one-click). HUMAN_LABEL_FOR_TEMPLATE is the visible
// text in the in-body footer ("Unsubscribe from {label}"). Adding a new email type
// requires entries in BOTH maps — keep them in sync.
const ACTION_FOR_TEMPLATE: Record<string, UnsubscribeAction> = {
  'task-update': 'disable:taskUpdates',
  'team-activity': 'disable:teamActivity',
  'escalation': 'disable:escalations',
  'daily-digest': 'cadence:none',
  'weekly-digest': 'cadence:none',
  'weekly-performance-recap': 'disable:weeklyDigest',
  'newsletter': 'disable:newsletter',
};

// Single helper called by every render function. Returns the body with the
// unsubscribe footer paragraph appended AND the List-Unsubscribe header pair to
// pass into sendEmail. Guarantees uniform footer + headers across all email types.
//
// The footer paragraph deliberately mirrors the FOOTER tagline ("The Operating
// System for Agents") style: 12px / muted-gray / sans-serif. The
// two links use the CTA accent color and have no underline so they look like
// the rest of the brand's link treatment rather than the default blue.
//
// Wording is generic ("these type of notifications") rather than per-template
// because every recipient already knows what notification just hit their
// inbox; surfacing the type as a label clutters the footer without adding
// information. The ACTION encoded in the unsubscribe token still scopes the
// click correctly to the right preference field.
export function appendUnsubscribeFooter(
  body: string,
  account: { id: string },
  templateKey: string,
): { body: string; headers: Record<string, string> } {
  const action = ACTION_FOR_TEMPLATE[templateKey];
  if (!action) {
    throw new Error(
      `appendUnsubscribeFooter: no action for template '${templateKey}' — update ACTION_FOR_TEMPLATE`,
    );
  }

  const inAppUnsubUrl = buildEmailUnsubscribeUrl(account.id, action);
  const listUnsubUrl = buildListUnsubscribeUrl(account.id, action);

  // Styled to match the FOOTER tagline in src/infrastructure/email/shared.ts.
  // Inline HTML (not buildParagraph) because we need a different font-size +
  // color than the body paragraph default.
  const bodyWithFooter =
    body +
    `
                                    <p
                                      style="margin:0;padding-top:1em;padding-bottom:0;font-size:12px;line-height:1.5;text-align:center;color:${EMAIL_COLORS.textMuted};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"
                                    >
                                      <span>Do not want these emails? </span><a href="${inAppUnsubUrl}" style="color:${EMAIL_COLORS.accent};text-decoration:none;">Unsubscribe</a><span> · </span><a href="${SETTINGS_LINK}" style="color:${EMAIL_COLORS.accent};text-decoration:none;">Manage notifications</a>
                                    </p>`;
  return {
    body: bodyWithFooter,
    headers: {
      'List-Unsubscribe': `<${listUnsubUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

export async function sendRealtimeNotificationEmail(
  account: Account,
  row: NotificationRow,
): Promise<string> {
  const p = row.payload as {
    actorName?: string;
    internalAgentName?: string;
    eventTitle?: string;
    eventSummary?: string;
    eventLink?: string;
    recordKind?: string;
  };
  const templateKey = TYPE_TEMPLATE_KEY[row.type];

  // Escape every caller-supplied string before interpolating. URL-validate
  // eventLink so a malformed value cannot break out of the href.
  const actor = escapeHtml(p.actorName ?? 'A workspace member');
  const agent = escapeHtml(p.internalAgentName ?? 'An agent');
  const title = escapeHtml(p.eventTitle ?? 'Action required');
  const summary = p.eventSummary ? escapeHtml(p.eventSummary) : '';

  let body = '';
  if (row.type === 'escalation') {
    // Three different things arrive as type 'escalation', and they do not all
    // have somewhere to send the reader.
    //
    //   'blocker' / 'clarification' — the run is PARKED. There is a row in the
    //     review queue, answering it resumes the work, and the button is right.
    //   'escalation' (or absent, meaning an older runtime) — the run ENDED and
    //     left a record. Records are not in the queue, so a "Review now" button
    //     sends the reader to a page that does not contain the thing they were
    //     just told about.
    //
    // The old code sent everyone to the queue, and did it twice over: the link
    // was hardcoded upstream AND safeHref fell back to REVIEW_LINK whenever it
    // was absent. Dropping the link upstream alone would have changed nothing.
    body += buildParagraph(escalationLeadLine(agent, p.recordKind));
    body += buildParagraph(title);
    if (summary) body += buildParagraph(summary);
    if (p.eventLink) {
      body += buildCTA('Review now', safeHref(p.eventLink, REVIEW_LINK));
    }
    // No CTA otherwise, deliberately. The summary above carries what the agent
    // reported and what it needs, which is the whole of the actionable content.
    // A button to a page that cannot show this record is worse than no button.
  } else if (row.type === 'task_update') {
    body += buildParagraph(`${agent} updated a task: ${title}.`);
    if (summary) body += buildParagraph(summary);
    body += buildCTA('View task', safeHref(p.eventLink, ACTIVITY_LINK));
  } else {
    // agent_activity
    body += buildParagraph(`${actor} ${summary || 'took action in your workspace.'}`);
    body += buildCTA('View activity', safeHref(p.eventLink, ACTIVITY_LINK));
  }

  const { body: bodyWithFooter, headers } = appendUnsubscribeFooter(body, account, templateKey);

  // Subject/preheader placeholders go into plain-text mail headers, not HTML.
  // Use sanitizeForHeader (strip CRLF + angle brackets) — not escapeHtml,
  // which would render literal '&amp;' in the user's inbox subject line.
  const { subject, html } = buildEmail(templateKey, {
    firstName: account.firstName ?? 'there',
    internalAgentName: p.internalAgentName ? sanitizeForHeader(p.internalAgentName) : undefined,
    actorName: p.actorName ? sanitizeForHeader(p.actorName) : undefined,
    eventTitle: p.eventTitle ? sanitizeForHeader(p.eventTitle) : undefined,
    rawHtml: bodyWithFooter,
  });
  return sendEmail({ to: account.email, subject, html, emailType: templateKey, headers });
}

export async function sendDigestEmail(
  account: Account,
  rows: NotificationRow[],
  cadence: 'daily' | 'weekly',
): Promise<string> {
  const period = cadence === 'daily' ? 'the past 24 hours' : 'the past week';
  const counts = countByType(rows);

  let body = '';
  body += buildParagraph(`Here is what happened in ${period}:`);
  body += buildListIntro('Activity summary');
  body += buildList(formatCountLines(counts));
  body += buildCTA('View activity', ACTIVITY_LINK);

  const templateKey = cadence === 'daily' ? 'daily-digest' : 'weekly-digest';
  const { body: bodyWithFooter, headers } = appendUnsubscribeFooter(body, account, templateKey);

  const { subject, html } = buildEmail(templateKey, {
    firstName: account.firstName ?? 'there',
    digestPeriod: period,
    rawHtml: bodyWithFooter,
  });
  return sendEmail({ to: account.email, subject, html, emailType: templateKey, headers });
}

export async function sendPerformanceRecapEmail(
  account: Account,
  metrics: { tenantName: string; agentActions: number; completedTasks: number; escalations: number }[],
): Promise<string> {
  let body = '';
  body += buildParagraph('Here is how your agents did last week:');
  for (const t of metrics) {
    // tenantName comes from the tenants table; HTML-escape before placing
    // it inside the listIntro paragraph (which applies its own emphasis via
    // CSS font-weight, not <strong>).
    body += buildListIntro(escapeHtml(t.tenantName));
    body += buildList([
      `${t.agentActions} actions taken`,
      `${t.completedTasks} tasks completed`,
      `${t.escalations} escalations resolved`,
    ]);
  }
  body += buildCTA('View dashboard', `${FRONTEND_URL}/dashboard`);

  const { body: bodyWithFooter, headers } = appendUnsubscribeFooter(body, account, 'weekly-performance-recap');

  const { subject, html } = buildEmail('weekly-performance-recap', {
    firstName: account.firstName ?? 'there',
    rawHtml: bodyWithFooter,
  });
  return sendEmail({
    to: account.email,
    subject,
    html,
    emailType: 'weekly-performance-recap',
    headers,
  });
}

function countByType(rows: NotificationRow[]): Record<NotificationType, number> {
  const c: Record<NotificationType, number> = { task_update: 0, agent_activity: 0, escalation: 0 };
  for (const r of rows) c[r.type]++;
  return c;
}

function formatCountLines(c: Record<NotificationType, number>): string[] {
  const lines: string[] = [];
  if (c.task_update) lines.push(`${c.task_update} task ${c.task_update === 1 ? 'update' : 'updates'}`);
  if (c.agent_activity)
    lines.push(`${c.agent_activity} team activity ${c.agent_activity === 1 ? 'event' : 'events'}`);
  if (c.escalation)
    lines.push(
      `${c.escalation} ${c.escalation === 1 ? 'escalation' : 'escalations'} (already sent in real-time)`,
    );
  return lines;
}
