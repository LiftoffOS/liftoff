// Which platform assistant spent it.
//
// The three assistants have no `internal_agents` row — the tenant runtime spells
// "no agent" with a nil UUID and the spend subscriber turns that into a null
// `agent_id` (billing/web-tool-spend-subscriber.ts), which is the truthful
// value: the spend is the workspace's, and `purpose` says which surface made it.
//
// So `purpose` is the only dimension that separates them, and it arrives in two
// spellings depending on which half of the ledger wrote the row:
//
//   web_tool / connector_call  — the SURFACE name, as the runtime knows it:
//                                'liftoff' | 'insights' | 'team_plan'
//   llm_invocation             — the model-call purpose: 'liftoff_chat',
//                                'caio_workforce_planning', 'insights_chat', …
//
// One map covers both, so a caller never has to know which half it is reading.
// Anything unrecognised returns null and is reported as unattributed rather
// than guessed at — a wrong name on a cost line is worse than no name.

export type AssistantKey = 'liftoff' | 'insights' | 'caio';

/** What each assistant is called on the page. Their own names, which is what a
 *  person sees everywhere else in the product. */
export const ASSISTANT_LABELS: Record<AssistantKey, string> = {
  liftoff:  'Liftoff',
  insights: 'Insights Manager',
  caio:     'Chief AI Officer',
};

/** Spend that is the workspace's but carries no agent and no recognisable
 *  surface. Named rather than dropped: this covers web-tool rows and agentless
 *  connector calls, and silently losing them makes the page understate. */
export const UNATTRIBUTED_LABEL = 'Unattributed';

const BY_PURPOSE: Record<string, AssistantKey> = {
  // Surface names, written by the runtime on tool and data-source rows.
  liftoff:   'liftoff',
  insights:  'insights',
  team_plan: 'caio',

  // Model-call purposes, written by each assistant's own loop.
  liftoff_chat:                             'liftoff',
  liftoff_summarization:                    'liftoff',
  liftoff_dataset_extract:                  'liftoff',
  // Conversation recall (migration 547): one embed per turn, and one per search
  // that reaches the semantic arm. Small per call and charged like any other
  // model spend, so it lands on the assistant that spent it rather than
  // becoming unattributed platform overhead.
  liftoff_recall_embed:                     'liftoff',
  liftoff_recall_query:                     'liftoff',
  insights_chat:                            'insights',
  insights_summarization:                   'insights',
  insights_dataset_extract:                 'insights',
  // Absorbed today (they auto-run when a person opens the page, so the platform
  // eats them). Mapped anyway: if that policy ever changes, the spend lands on
  // the Insights Manager's line instead of becoming unattributed.
  insights_intro:                           'insights',
  insights_observation:                     'insights',
  insights_recall_embed:                    'insights',
  insights_recall_query:                    'insights',
  caio_workforce_planning:                  'caio',
  caio_workforce_planning_summarization:    'caio',
  caio_workforce_planning_title_generation: 'caio',
  caio_dataset_extract:                     'caio',
  // The Chief AI Officer's conversation search. Its threads live in
  // workforce-service's database, but the embed runs here (over
  // /api/internal/embedding) so the cost lands on its line like every other
  // model call it makes.
  caio_recall_embed:                        'caio',
  caio_recall_query:                        'caio',
};

export function assistantForPurpose(purpose: string | null | undefined): AssistantKey | null {
  if (purpose == null) return null;
  return BY_PURPOSE[purpose] ?? null;
}
