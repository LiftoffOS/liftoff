// Whose logins a browser session carries.
//
// Visibility follows the product. A team's conversations and an assistant's
// conversations are the workspace's: any member can open a thread, several
// people take part in one, and the browser pane beside it is one live session
// everyone in the thread sees and drives. So the logins behind that browser
// belong to the unit whose conversation it is, not to whoever happened to open
// it first — a team agent has one persistent profile, and so does each
// platform assistant (Liftoff, the Chief AI Officer, the Insights Manager),
// one per workspace. Every browser that unit opens — in a pane with a person,
// or on its own in a scheduled run — binds it. Signing a unit in is done once,
// in its pane; the login lives in the profile, not in the session.
//
// Before this rule the persisted profile was keyed to the person who opened
// the pane: in a shared thread the logins were the opener's, carried into a
// space every member could use, and a colleague's new thread had none of them.
//
// The rule lives here, once, rather than in each vendor client's spawn: three
// clients each derived a profile name from the owner account, and a fourth
// kind of caller — a run with no person — would have had to be taught to all
// three. They now take the profile they are handed.

import { NO_AGENT_SENTINEL } from './types';

export interface SessionProfile {
  /** The vendor-side profile name; also the `web_profiles.profile_name` key. */
  name: string;
  /** 'team' — one per team agent; 'assistant' — one per platform assistant per
   *  workspace; 'pane' — the legacy per-person profile, kept only for a caller
   *  that names neither a team nor an assistant. */
  kind: 'team' | 'assistant' | 'pane';
  /** The person a legacy pane profile belongs to; null for a team's or an
   *  assistant's. */
  ownerAccountId: string | null;
}

/**
 * The profile a session should bind, or null for an ephemeral session (a
 * caller naming no team, no assistant and no person — the legacy web_task
 * caller).
 */
export function profileFor(args: {
  tenantId: string;
  agentId: string;
  /** Which platform assistant opened the browser, when no team did:
   *  'liftoff', 'insights' or 'team_plan'. */
  assistant?: string | null;
  ownerAccountId?: string | null;
}): SessionProfile | null {
  if (args.agentId && args.agentId !== NO_AGENT_SENTINEL) {
    return {
      name: `liftoff-${args.tenantId}-${args.agentId}-team`,
      kind: 'team',
      ownerAccountId: null,
    };
  }
  if (args.assistant) {
    return {
      name: `liftoff-${args.tenantId}-${args.assistant}-workspace`,
      kind: 'assistant',
      ownerAccountId: null,
    };
  }
  if (args.ownerAccountId) {
    return {
      name: `liftoff-${args.tenantId}-${NO_AGENT_SENTINEL}-${args.ownerAccountId}`,
      kind: 'pane',
      ownerAccountId: args.ownerAccountId,
    };
  }
  return null;
}
