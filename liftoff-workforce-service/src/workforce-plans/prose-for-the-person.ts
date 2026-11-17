// The authored prose is the person's layer, and it stays in the person's terms.
//
// `responsibilities` and `additionalContext` are what the team's page shows and
// what a person edits; the build turns them into the technical layer — the
// instructions and the workflow steps — which is where a tool name belongs.
// How the platform reaches a site, whether a run has a browser, which tool
// reads a page: those are decided when the team is built, from what the
// platform offers at the time, and a person reading their team's brief should
// never have to know them. A brief that says "use the direct web-reading tool,
// not an interactive browser session" tells the person nothing they can act
// on and asks them to understand a distinction the platform already makes.
//
// A rule in the prompt is one end of the wire. This is the other: the two tools
// that write the prose refuse text that names execution mechanics, naming the
// field and the phrase so the author rewrites it in the person's terms.

/** Tool names the author can see and might echo — its own, and the runtime's
 *  standard tools a distilled brief names — as whole words. */
const TOOL_NAMES = [
  // The author's own tools.
  'web_fetch', 'run_browser_task', 'navigate_browser_session', 'capability_search',
  'run_capability', 'memory_save', 'memory_retrieve', 'workforce_plan__draft',
  'workforce_plan__commit', 'workforce_plan__approve', 'team__get_config',
  'team__propose_update', 'source_conversation__read', 'conversation__read',
  'conversations__list', 'connectors__list_available', 'org__get_existing_structure',
  'agent_templates__list', 'agent_templates__get', 'preview_with_liftoff',
  // The runtime's web and record tools a built team runs.
  'web_fetch_advanced', 'web_search', 'web_research', 'web_deep_research',
  'web_people_search', 'web_finance_search', 'web_extract', 'web_task', 'web_diff',
  'notify_team', 'record_step_output', 'schedule_followup', 'delegate_to_agent',
];

/** Phrases that describe how the platform does the work rather than what the
 *  team does. Matched case-insensitively as whole words. */
const MECHANICS_PHRASES = [
  'browser session',
  'interactive browser',
  'headless browser',
  'web-reading tool',
  'web reading tool',
  'fetch tool',
  'search tool',
  'research tool',
  'scraping tool',
  'the tool catalog',
  'tool call',
  'tool_call',
  'llm_reason',
  'system prompt',
  'workflow step',
  'workflow steps',
  'cron expression',
];

export interface ProseMechanicsFinding {
  /** The prose field, as the tool's argument names it. */
  field: string;
  /** The offending text, as written. */
  phrase: string;
}

/**
 * Every place the given prose fields name an execution mechanic. Empty when
 * the prose is in the person's terms.
 */
export function findExecutionMechanics(
  fields: Record<string, string | undefined>,
): ProseMechanicsFinding[] {
  const findings: ProseMechanicsFinding[] = [];
  for (const [field, text] of Object.entries(fields)) {
    if (!text) continue;
    for (const name of TOOL_NAMES) {
      const re = new RegExp(`(^|[^A-Za-z0-9_])${escape(name)}(?![A-Za-z0-9_])`);
      const m = re.exec(text);
      if (m) findings.push({ field, phrase: name });
    }
    for (const phrase of MECHANICS_PHRASES) {
      const re = new RegExp(`(^|[^A-Za-z0-9_-])${escape(phrase)}(?![A-Za-z0-9_-])`, 'i');
      const m = re.exec(text);
      if (m) findings.push({ field, phrase: text.slice(m.index + m[1].length, m.index + m[1].length + phrase.length) });
    }
  }
  return findings;
}

/**
 * The refusal handed back to the author, or null when the prose passes. Names
 * each field and phrase and says what to write instead, so the next draft is
 * the fix rather than another guess.
 */
export function refuseExecutionMechanics(
  fields: Record<string, string | undefined>,
): string | null {
  const findings = findExecutionMechanics(fields);
  if (findings.length === 0) return null;
  const listed = findings.map((f) => `${f.field}: "${f.phrase}"`).join('; ');
  return (
    `This text names how the platform does the work, and the person reads it: ${listed}. `
    + 'The brief is written in the person\'s terms: what the agent does, for whom, when, with what '
    + 'rules and limits, and what the result looks like. Never say which tool reads a page, whether '
    + 'a run uses a browser or a session, or whether a site is reached by a browser or by a page read; '
    + 'those are decided when the agent is built, and the platform already keeps a scheduled run away '
    + 'from anything that needs a person present. The address of a page the agent opens is part of the '
    + 'work, not of the mechanics: keep every URL exactly as the person gave it. Rewrite the named text '
    + 'without the mechanics and send the draft again.'
  );
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
