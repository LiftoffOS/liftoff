// The three platform assistants a person can talk to alongside the workspace
// agents: the Liftoff assistant, the Chief AI Officer and the Insights
// Manager — the same three colleagues the dashboard offers.
//
// They are not internal_agents rows (the CAIO's row is a tenant_id-NULL system
// agent; the other two are not rows anywhere), so they are named here rather
// than looked up, with reserved ids that are deliberately not UUIDs and so can
// never collide with a team's. Every surface that names an assistant — the
// dashboard's mention picker, a coding tool over MCP, a Slack DM, a Teams
// chat, a notification — reads this one list, so one colleague has one name
// everywhere. Chat-only: they take no background tasks and read no
// agent_messages queue.
//
// Deliberately import-free: this is read at module load by the chat adapters
// and the notifier, and must not drag a service behind it.

export type AssistantKind = 'liftoff' | 'caio' | 'insights';

export interface AssistantTarget {
  kind: AssistantKind;
  /** The reserved address: 'liftoff', 'caio' or 'insights'. */
  id: AssistantKind;
  /** The name a person and the calling model see. */
  name: string;
  /** One line on what this assistant is for. */
  description: string;
}

export const ASSISTANT_TARGETS: readonly AssistantTarget[] = [
  {
    kind: 'liftoff',
    id: 'liftoff',
    name: 'Liftoff',
    description:
      'The workspace general assistant. Answers anything, and brings in the '
      + 'Chief AI Officer, the Insights Manager, or an agent when the work is theirs.',
  },
  {
    kind: 'caio',
    id: 'caio',
    name: 'Chief AI Officer',
    description:
      'Designs, creates and changes agents: what an agent should do, which tools it gets, '
      + 'and launching, pausing or reshaping it.',
  },
  {
    kind: 'insights',
    id: 'insights',
    name: 'Insights Manager',
    description:
      'Answers questions from real workspace data: cost, task volume, trends, and who did what. '
      + 'It has the data tools; nobody else does.',
  },
];

/** The assistant a kind names, or null for anything else (a team). */
export function assistantByKind(kind: string): AssistantTarget | null {
  return ASSISTANT_TARGETS.find((a) => a.kind === kind) ?? null;
}

/** The assistant a person addressed by name — "Chief AI Officer: …" — read the
 *  way a name is typed: case and surrounding space do not matter. Null when
 *  the name is not one of the three, which is what lets a team's name be
 *  looked up next. */
export function assistantByName(name: string): AssistantTarget | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  return ASSISTANT_TARGETS.find((a) => a.name.toLowerCase() === wanted) ?? null;
}

export function isAssistantKind(value: unknown): value is AssistantKind {
  return value === 'liftoff' || value === 'caio' || value === 'insights';
}
