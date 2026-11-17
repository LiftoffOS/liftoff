// W2 of the work_inbox/ack convention plan
//
// At distill time, walk the agent's resolved tool catalog and find every
// inbox/ack pair where both halves are bound. For each pair, emit a
// platform-mandatory section into the distill prompt teaching the LLM:
//
//   1. After acting on a work item returned by the inbox tool, the agent
//      MUST call the paired ack tool on the same item id before the
//      invocation ends. The next list call will only return items the agent
//      has NOT acknowledged.
//
//   2. For any single work item, the agent should not produce more than
//      N distinct outbound resolution attempts before escalating to a
//      human. N is 3 for every agent.
//
//      There is NO per-agent override. This comment previously described a
//      `maxResolutionAttemptsPerWorkItem` field on the agent row; no such
//      column exists in any migration and nothing reads one. The value is
//      prompt text rather than an enforced limit, so a per-agent knob would
//      need a column, an API field and a surface to set it — build those if
//      the need appears, rather than reading this as a wiring gap.
//
// The convention is connector-agnostic: as long as the registry tags
// (workRole, paired_ack, acknowledges, workItemKind) are populated on
// the catalog tools, the section emits automatically for any agent that
// binds an inbox tool plus its paired ack.
//
// If an inbox tool is in the agent's catalog but its paired ack is NOT,
// distillation fails with DistillationError('work_inbox_missing_ack')
// rather than emit a contract the agent has no way to satisfy.

import type { ToolCatalog } from './distill-service.js';

export class DistillationError extends Error {
  constructor(
    public readonly code: 'work_inbox_missing_ack',
    public readonly details: {
      inboxTool: string;
      expectedAck: string;
      workItemKind: string;
    },
  ) {
    super(
      `Distillation failed (${code}): inbox tool "${details.inboxTool}" requires ` +
        `ack tool "${details.expectedAck}" but it is not in the agent's allowed tools. ` +
        `Either bind the ack tool or remove the inbox tool from the agent.`,
    );
    this.name = 'DistillationError';
  }
}

export interface WorkInboxPair {
  /** Resolved per-account tool name as it appears in the catalog (e.g. "google-mail-14a82d9e__list_messages"). */
  inboxTool: string;
  /** Resolved per-account tool name for the ack side (same alias prefix as inboxTool). */
  ackTool: string;
  /** Stable cross-connector label (e.g. "email_message"). */
  workItemKind: string;
  /** Per-account alias prefix shared by both tools. */
  connectorAlias: string;
}

/**
 * Walk the catalog and return all (inbox, ack) pairs the agent is bound
 * to. Throws DistillationError if any inbox tool is present without its
 * paired ack.
 *
 * Tool names follow `<alias>__<funcName>` (per migration 252's per-account
 * alias format). The `paired_ack` field on the registry carries the
 * function suffix only ("mark_as_read"), so we compose the ack tool name
 * from the inbox tool's own alias prefix.
 */
export function resolveWorkInboxPairs(catalog: ToolCatalog): WorkInboxPair[] {
  const pairs: WorkInboxPair[] = [];

  for (const [toolName, tool] of catalog) {
    if (tool.workRole !== 'inbox') continue;
    // Both fields must be present per the W1 boot validator — if not,
    // the registry is internally inconsistent and connector-service would
    // have refused to start. Skip defensively.
    if (!tool.paired_ack || !tool.workItemKind) continue;

    const aliasSepIdx = toolName.indexOf('__');
    if (aliasSepIdx < 0) continue; // not an aliased tool — can't compose
    const alias = toolName.slice(0, aliasSepIdx);
    const ackToolName = `${alias}__${tool.paired_ack}`;

    if (!catalog.has(ackToolName)) {
      throw new DistillationError('work_inbox_missing_ack', {
        inboxTool: toolName,
        expectedAck: ackToolName,
        workItemKind: tool.workItemKind,
      });
    }

    pairs.push({
      inboxTool: toolName,
      ackTool: ackToolName,
      workItemKind: tool.workItemKind,
      connectorAlias: alias,
    });
  }

  return pairs;
}

/**
 * Build the prompt-injected section. Returns empty string when there are
 * no pairs (so the caller can safely concatenate without conditionals).
 */
export function buildWorkInboxContractSection(
  pairs: readonly WorkInboxPair[],
  maxResolutionAttempts: number,
): string {
  if (pairs.length === 0) return '';

  const pairLines = pairs
    .map(
      (p) =>
        `- After acting on a ${p.workItemKind} returned by \`${p.inboxTool}\`, you MUST call \`${p.ackTool}\` with the item id before this invocation ends.`,
    )
    .join('\n');

  const kindsList = [...new Set(pairs.map((p) => p.workItemKind))]
    .map((k) => `\`${k}\``)
    .join(', ');

  return `
WORK-ITEM ACKNOWLEDGEMENT CONTRACT (platform-enforced):

Some of your tools list work items from external systems that already track which items you have processed. The contract:

1. List → Act → Acknowledge. After taking any outbound action on a listed item, call the paired acknowledgement tool BEFORE this invocation ends.
2. Pairings in your catalog:
${pairLines}
3. The next invocation will only see items you have NOT acknowledged. If the inbox tool returns an item you already acted on, that means YOU forgot to acknowledge it — call the ack now, do NOT repeat the outbound action.

RESOLUTION-ATTEMPT CEILING:

For any single work item (one ${kindsList} thread, one ticket, one task), do not produce more than ${maxResolutionAttempts} distinct outbound resolution attempts across all invocations on that item before escalating to a human. Count distinct attempts from the external system's history (messages you sent on the thread, comments you authored, status transitions you made), not from memory.
`;
}
