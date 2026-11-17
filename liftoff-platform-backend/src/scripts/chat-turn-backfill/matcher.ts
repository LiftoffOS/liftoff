// Pure matching core for the chat-turn attribution backfill (plan v13
// Change 5 step 2). No I/O — the job layer loads export rows and thread
// messages, computes HMACs, and calls planThreadAssignments per thread; unit
// tests exercise every skip rule directly.
//
// Invariant: PROVABLE-ONLY. Matching is sanitized-value equality via HMAC
// digest, with UNIQUE 1:1 assignment in both directions; the assistant match
// must be the NEXT attributable message from the audited agent BEFORE any
// intervening user message. Anything ambiguous is skipped and counted, never
// guessed. Timestamps are a sanity bound only, never the matcher.

export interface ExportRow {
  tenantId: string;
  internalAgentId: string;
  threadId: string;
  /** Becomes the synthesized agent_chat_turns.id (deterministic). */
  invocationId: string;
  /** TR local audit write-time truth (sanity bound only). */
  originalCreatedAt: string;
  senderAccountId: string;
  /** HMAC-SHA256(runKey, sanitized objective). */
  objectiveHmac: string;
  /** Sanitized objective carried the truncation suffix — never matched. */
  truncated: boolean;
}

export interface ThreadMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  agentId: string | null;
  createdAt: string; // ISO
  turnId: string | null;
  /** HMAC of sanitized content — computed by the job layer for user rows
   *  with turnId === null only. */
  contentHmac?: string;
}

export interface Assignment {
  row: ExportRow;
  userMessageId: string;
  assistantMessageId: string;
}

export interface SkipCounts {
  truncated: number;
  noUserMatch: number;
  duplicateUser: number;   // >1 identical sanitized user candidates (incl. redaction collisions)
  competingAudit: number;  // >1 audit rows claim the same user message
  noAssistant: number;     // failed turn: no attributable reply
  interleaved: number;     // another user message before the agent's reply
  competingAssistant: number;
  sanityBound: number;     // |audit time - message time| beyond the bound
}

export interface ThreadPlan {
  assignments: Assignment[];
  skips: SkipCounts;
}

export const SANITY_BOUND_MS = 24 * 60 * 60 * 1000; // generous; a bound, not a matcher

export function emptySkips(): SkipCounts {
  return {
    truncated: 0,
    noUserMatch: 0,
    duplicateUser: 0,
    competingAudit: 0,
    noAssistant: 0,
    interleaved: 0,
    competingAssistant: 0,
    sanityBound: 0,
  };
}

/**
 * Plan assignments for ONE thread. `messages` must be the thread's full
 * message list ordered by createdAt ASC.
 */
export function planThreadAssignments(
  rows: ExportRow[],
  messages: ThreadMessage[],
): ThreadPlan {
  const skips = emptySkips();
  const assignments: Assignment[] = [];

  // Candidate user messages: unattributed user rows with an HMAC.
  const userCandidates = messages.filter(
    (m) => m.role === 'user' && m.turnId === null && typeof m.contentHmac === 'string',
  );

  // Pass 1 — user-message match per audit row (uniqueness in row→message
  // direction: exactly one candidate).
  const rowToUser = new Map<string, ThreadMessage>(); // invocationId -> message
  const claimedBy = new Map<string, string[]>();      // messageId -> invocationIds
  for (const row of rows) {
    if (row.truncated) {
      skips.truncated++;
      continue;
    }
    const matches = userCandidates.filter((m) => m.contentHmac === row.objectiveHmac);
    if (matches.length === 0) {
      skips.noUserMatch++;
      continue;
    }
    if (matches.length > 1) {
      // Duplicate identical user messages OR two different messages that
      // collide after redaction — indistinguishable, both unprovable.
      skips.duplicateUser++;
      continue;
    }
    const m = matches[0];
    const drift = Math.abs(
      new Date(m.createdAt).getTime() - new Date(row.originalCreatedAt).getTime(),
    );
    if (drift > SANITY_BOUND_MS) {
      skips.sanityBound++;
      continue;
    }
    rowToUser.set(row.invocationId, m);
    claimedBy.set(m.id, [...(claimedBy.get(m.id) ?? []), row.invocationId]);
  }

  // Pass 2 — message→row uniqueness: a user message claimed by two audit
  // rows is unprovable for both.
  for (const [, invocationIds] of claimedBy) {
    if (invocationIds.length > 1) {
      for (const inv of invocationIds) rowToUser.delete(inv);
      skips.competingAudit += invocationIds.length;
    }
  }

  // Pass 3 — assistant match: the NEXT attributable message from the
  // audited agent BEFORE any intervening user message.
  const claimedAssistants = new Set<string>();
  for (const row of rows) {
    const userMsg = rowToUser.get(row.invocationId);
    if (!userMsg) continue;
    const startIdx = messages.findIndex((m) => m.id === userMsg.id);
    let assistant: ThreadMessage | null = null;
    let sawInterleavedUser = false;
    for (let i = startIdx + 1; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'user') {
        sawInterleavedUser = true;
        break;
      }
      if (m.role === 'assistant' && m.agentId === row.internalAgentId && m.turnId === null) {
        assistant = m;
        break;
      }
    }
    if (!assistant) {
      if (sawInterleavedUser) skips.interleaved++;
      else skips.noAssistant++;
      continue;
    }
    if (claimedAssistants.has(assistant.id)) {
      skips.competingAssistant++;
      continue;
    }
    claimedAssistants.add(assistant.id);
    assignments.push({
      row,
      userMessageId: userMsg.id,
      assistantMessageId: assistant.id,
    });
  }

  return { assignments, skips };
}

export function mergeSkips(a: SkipCounts, b: SkipCounts): SkipCounts {
  const out = emptySkips();
  for (const k of Object.keys(out) as Array<keyof SkipCounts>) {
    out[k] = a[k] + b[k];
  }
  return out;
}
