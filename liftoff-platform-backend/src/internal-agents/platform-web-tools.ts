// The platform-native web/research tool list, in its own module so both the
// distillation prompt and the capability-discovery service can read it
// without importing each other — distill-service consumes discovery for the
// prior-art section, so the list living inside distill-service would make the
// two modules a require cycle.

/** Platform-native web/research tools, exposed to EVERY agent with NO connector
 *  or vendor binding required. These mirror the NATIVE-backed set the tenant
 *  runtime keeps tenant-level (perplexity/openai/google/xai backends) in
 *  Liftoff-Tenant-Runtime/src/integrations/web-fetch/expose-tools.ts. BYOK
 *  tools (web_extract, web_diff, web_task, web_session_*) are deliberately
 *  EXCLUDED — they need a vendor the agent has connected, so they are per-agent,
 *  not universal, and surfacing them here would wire a tool_call step that fails
 *  UNRESOLVABLE for any agent without the vendor (the find_teammates class).
 *  These six are standard-family, so they dispatch and validate as workflow
 *  steps with no runtime change. Keep in sync with expose-tools.ts.
 *
 *  `web_search` is the BASIC search — ranked results, no synthesis. The runtime
 *  keeps two lists for it. The MODEL's list withholds it where the agent's
 *  engine attaches a web search of the model vendor's own (Claude's WebSearch,
 *  Codex's web_search, Gemini's grounding, the wire's hosted search), so a
 *  model never sees two tools called web search. The RUN's list — what
 *  validates and dispatches a `tool_call` step — offers it on every engine
 *  wherever a backend exists, because a deterministic step never calls the
 *  model and the vendor's hosted search is attached only to the model's calls,
 *  so it cannot serve a step. A step authored here therefore resolves whatever
 *  engine the agent runs on (Liftoff-Tenant-Runtime
 *  src/integrations/web-fetch/expose-tools.ts, `surface`; the contract test is
 *  src/integrations/web-fetch/__tests__/bridged-search-surfaces.test.ts). */
/**
 *  `run_browser_task` is the seventh, and the one that is not a read. A team
 *  has a browser of its own — one persistent profile per team, which its chat
 *  pane and its scheduled runs both bind — so a run with no person present can
 *  open a page that needs interaction, or a site the team is signed in to, and
 *  return what it found. The runtime classes it as a write (an autonomous
 *  browser agent cannot promise it only looks), so it carries its own
 *  categories here rather than the read the others share. */
export const PLATFORM_WEB_TOOLS: ReadonlyArray<{ name: string; description: string; categories?: string[] }> = [
  { name: 'web_search', description: 'Basic web search: ranked results (title, URL, snippet) for a query, fast and cheap, no synthesis. Use it the way you would use a search engine — find current pages on a topic, check a fact, locate a source to read with web_fetch_advanced. Input: { "query": "<search query>", "max_results"?: number (max 20) }. For a synthesized, cited answer use web_research instead.' },
  { name: 'web_research', description: 'Multi-source synthesized research with CITATIONS (platform Perplexity/Exa/Tavily backends). The backend reads several sources and writes one answer. Use when a question needs reading and synthesis, not a list of links — "who competes with X", "what do reviewers say about Y", "compare the pricing of the top 5 Z". Slower and costlier than web_search. Input: { "question": "<specific question>", "max_sources"?: number }.' },
  { name: 'web_fetch_advanced', description: 'Fetch the CONTENT of a specific URL (JS rendering, anti-bot / login-walled pages), sanitized and injection-stripped. Use to read a page you have the URL for — a competitor homepage, pricing page, changelog. Input: { "url": "<url>" } (+ optional wait_for/session_id). Use web_research instead when you do NOT have the URL.' },
  { name: 'web_deep_research', description: 'Comprehensive multi-source report with long-form synthesis and a full source list — slower/costlier (~5-30 min). Use ONLY when web_research is insufficient: a multi-section report or competitive analysis across many companies. Input: { "question": "<topic>", "reasoning_effort"?: "low"|"high" }. Prefer web_research for single questions.' },
  { name: 'web_people_search', description: 'Find specific PEOPLE (executives, new hires) by name/title/company/location — structured records with citations. Prefer over web_research when the task is to identify a person, e.g. a competitor’s new senior leadership hire. Input: { "query": "<name/role/company>", "max_sources"?: number }.' },
  { name: 'web_finance_search', description: 'Financial data — tickers, prices, SEC/EDGAR filings, earnings, funding and analyst notes; structured records with citations. Prefer over web_research for a company’s financials or a competitor’s funding round. Input: { "query": "<ticker/company/topic>", "instrument"?: "<ticker>", "max_sources"?: number }.' },
  { name: 'run_browser_task', categories: ['write'], description: 'Drive the agent’s own browser on a page that needs interaction (clicking, scrolling, a form, a page behind a sign-in the agent holds) and return what it found. State the URL, what to do there, and exactly what to return. The team stays signed in between runs. For a page that can simply be read, use web_fetch_advanced instead. Input: { "prompt": "<open <url>, do <steps>, and return <what>>" }.' },
];
