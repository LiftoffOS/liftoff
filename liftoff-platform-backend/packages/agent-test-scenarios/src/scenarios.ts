// Declarative scenarios for the agent test harness. One entry per
// expected agent behavior; runners post each scenario's `prompt` at
// the target agent and call assertScenario() on the response.
//
// Adding coverage = one append to this list. No code wiring.
//
// Convention for `expectsTools`: the matcher is "must include at least
// one tool whose name endsWith __<bare>" — this absorbs the MCP server
// prefix (e.g. `mcp__liftoff-tool-gateway__<bare>`) so scenarios can
// reference the bare tool name. SDK-native tools (WebFetch, Bash,
// Agent) are unprefixed and matched directly.
//
// Convention for `expectsOneOf`: AND-of-ORs. Each inner set must have
// at least one match. For "either of these is fine" put both names in
// ONE set: expectsOneOf: [['A','B']]. Two sets means BOTH groups must
// independently match — rarely what you want.
//
// Tags group scenarios so the runner can filter to a category
// (--tag=browser). An agent that lacks a tool category should run
// without that tag.

import type { AgentTestScenario } from './types.js';

export const SCENARIOS: AgentTestScenario[] = [
  // ── Memory ─────────────────────────────────────────────────────────
  {
    id: 'memory.save',
    description: 'Save a non-trivial preference should call memory_save',
    prompt: 'Remember for future conversations: when generating spreadsheets I prefer xlsx over csv because the formulas survive.',
    expectsTools: ['memory_save'],
    tags: ['memory'],
    maxTurns: 4,
  },
  {
    id: 'memory.retrieve',
    description: 'Question that benefits from past knowledge should call memory_retrieve',
    prompt: "Search your long-term memory for anything I've previously told you about my spreadsheet format preferences.",
    expectsTools: ['memory_retrieve'],
    tags: ['memory'],
    maxTurns: 4,
  },
  {
    id: 'memory.corpus_search',
    description: "Knowledge-base lookup (specific connector docs) should call corpus_search",
    prompt: 'Search the knowledge base for anything related to release process documentation.',
    expectsTools: ['corpus_search'],
    tags: ['memory', 'knowledge'],
    maxTurns: 4,
  },

  // ── Web fetching / research ────────────────────────────────────────
  {
    id: 'web.summarize_article',
    description: 'Summarize-this-article should hit a fetcher (WebFetch OR web_fetch_advanced) — NOT a browser tool',
    prompt: 'Summarize this article for me: https://en.wikipedia.org/wiki/Public_Suffix_List',
    expectsOneOf: [['WebFetch', 'web_fetch_advanced']],
    forbidsTools: ['run_browser_task'],
    tags: ['web'],
    maxTurns: 4,
  },
  {
    id: 'web.advanced_blocked_site',
    description: 'Page known to block basic WebFetch (NYT) should escalate to web_fetch_advanced',
    prompt: 'Read the New York Times homepage at https://www.nytimes.com and tell me the top three headlines.',
    expectsOneOf: [['web_fetch_advanced', 'run_browser_task']],
    tags: ['web'],
    maxTurns: 6,
  },
  {
    id: 'web.research',
    description: 'Multi-source synthesis ask should call web_research',
    prompt: 'Compare the pricing tiers of the top 3 vector databases and tell me which is cheapest for 100M vectors. Use multiple sources.',
    expectsTools: ['web_research'],
    // Anti-regression on the persona-scope-refusal failure mode: when
    // the agent has web_research bound, narrow personas must not
    // redirect a multi-source-synthesis ask to find_teammates with an
    // "out of my scope" decline.
    forbidsTools: ['find_teammates'],
    tags: ['web'],
    maxTurns: 4,
  },
  // web_deep_research is dropped: it routinely takes >300s, which is
  // the Cloud Run request timeout. The synchronous-HTTP shape of this
  // harness can't accommodate calls that long. Tested separately via
  // an async fixture, not here.
  {
    id: 'web.people_search',
    description: 'Find-a-specific-person ask should call web_people_search',
    prompt: 'Find me the LinkedIn profile and current title of the founder of Anchor Browser.',
    expectsTools: ['web_people_search'],
    tags: ['web'],
    maxTurns: 4,
  },
  {
    id: 'web.finance_search',
    description: 'Public-company finance ask should call web_finance_search',
    prompt: "What was Microsoft's most recent quarter's revenue and how did it compare to analyst estimates?",
    expectsTools: ['web_finance_search'],
    tags: ['web'],
    maxTurns: 4,
  },
  {
    id: 'web.extract_structured',
    description: 'Extract structured fields from a URL with a schema should call web_extract',
    prompt: 'From https://example.com extract the page title, the main heading, and any link URLs as a JSON object.',
    expectsTools: ['web_extract'],
    tags: ['web'],
    maxTurns: 4,
  },
  {
    id: 'web.diff',
    description: 'Two-URLs diff should call web_diff (or fetch-and-compare as a fallback)',
    prompt: 'Diff https://example.com against https://example.org and tell me how their content differs.',
    expectsOneOf: [['web_diff', 'WebFetch', 'web_fetch_advanced']],
    tags: ['web'],
    maxTurns: 4,
  },
  {
    id: 'web.task_autonomous',
    description: 'Headless autonomous multi-step task should call web_task (or web_extract / run_browser_task for the same intent)',
    prompt: 'Go to https://news.ycombinator.com and return the top 5 story titles + their points as a JSON array. Headless is fine.',
    expectsOneOf: [['web_task', 'web_extract', 'run_browser_task']],
    tags: ['web'],
    maxTurns: 4,
  },

  // ── Web session / identity (BYOK setup tools) ──────────────────────
  {
    id: 'web.identity_connect',
    description: 'Connect-my-credentials-once ask should call web_identity_connect',
    prompt: 'I want to give you a way to log in to my LinkedIn account so you can post for me. Set up an identity.',
    expectsTools: ['web_identity_connect'],
    tags: ['web', 'auth'],
    maxTurns: 4,
  },
  {
    id: 'web.session_save',
    description: 'Save-this-logged-in-state ask should call web_session_save',
    prompt: 'I just logged into Salesforce in the browser. Save this session so you can reuse it later as a profile called "salesforce-test".',
    setup: { browserSession: { initialUrl: 'https://example.com' } },
    requiresExposedTools: ['web_session_save'],
    expectsTools: ['web_session_save'],
    tags: ['browser', 'auth'],
    maxTurns: 4,
  },
  {
    id: 'web.session_close',
    description: 'End-the-browser-session ask should call web_session_close',
    prompt: "I'm done with the browser. Close the session.",
    setup: { browserSession: {} },
    requiresExposedTools: ['web_session_close'],
    expectsOneOf: [['web_session_close', 'run_browser_task']],
    tags: ['browser'],
    maxTurns: 4,
  },

  // ── Browser tools (require an agent bound to anchor_browser) ───────
  // Most browser-inspect tools (read_active_browser_session, screenshot,
  // save-as-PDF, list-downloads, get-stats, intervention-check) are
  // gated on hasActiveBrowserSession. Scenarios that target them MUST
  // declare setup.browserSession; otherwise the tools aren't in the
  // catalog at prompt time and the assertion is incoherent.
  {
    id: 'browser.navigate',
    description: 'Navigate verb on a fresh thread should spawn a session via run_browser_task, not WebFetch',
    prompt: 'Navigate to https://example.com',
    requiresExposedTools: ['run_browser_task'],
    expectsTools: ['run_browser_task'],
    forbidsTools: ['WebFetch', 'web_fetch_advanced', 'web_research'],
    forbidsTextMatching: /executable not found|cli\.js|pathToClaudeCode/i,
    tags: ['browser'],
    maxTurns: 6,
  },
  {
    id: 'browser.read_page_text',
    description: "'What's on the page' should use read_active_browser_session text mode (NOT a screenshot)",
    prompt: "Tell me the headline currently visible on the page in the browser.",
    setup: { browserSession: { initialUrl: 'https://example.com' } },
    requiresExposedTools: ['read_active_browser_session'],
    expectsTools: ['read_active_browser_session'],
    forbidsTools: ['screenshot_browser_session'],
    tags: ['browser'],
    maxTurns: 6,
  },
  {
    id: 'browser.screenshot_full_page',
    description: 'Full-page screenshot ask should fire screenshot_browser_session',
    prompt: 'Take a full-page screenshot of the article currently in the browser.',
    setup: { browserSession: { initialUrl: 'https://example.com' } },
    requiresExposedTools: ['screenshot_browser_session'],
    expectsOneOf: [['screenshot_browser_session', 'read_active_browser_session']],
    tags: ['browser'],
    maxTurns: 6,
  },
  {
    id: 'browser.save_as_pdf',
    description: 'Save-as-PDF ask should surface the PDF inline via save_active_browser_page_as_pdf',
    prompt: 'Save the page currently in the browser as a PDF.',
    setup: { browserSession: { initialUrl: 'https://example.com' } },
    requiresExposedTools: ['save_active_browser_page_as_pdf'],
    expectsTools: ['save_active_browser_page_as_pdf'],
    tags: ['browser'],
    maxTurns: 6,
  },
  {
    id: 'browser.session_stats',
    description: '"How long / how many credits" should call get_browser_session_stats',
    prompt: 'How long has this browser session been running and how much credit have we used on it?',
    setup: { browserSession: {} },
    requiresExposedTools: ['get_browser_session_stats'],
    expectsTools: ['get_browser_session_stats'],
    tags: ['browser'],
    maxTurns: 6,
  },
  {
    id: 'browser.intervention_check',
    description: 'CAPTCHA/MFA-style "did the browser ask for help" should poll check_browser_intervention_pending',
    prompt: 'Has the browser session asked me to step in for a CAPTCHA, MFA prompt, or any other intervention?',
    setup: { browserSession: {} },
    requiresExposedTools: ['check_browser_intervention_pending'],
    expectsTools: ['check_browser_intervention_pending'],
    tags: ['browser'],
    maxTurns: 6,
  },
  {
    id: 'browser.list_downloads',
    description: 'Process-the-file ask should call list_browser_downloads',
    prompt: 'I just downloaded a file in the browser. Process it for me.',
    setup: { browserSession: {} },
    requiresExposedTools: ['list_browser_downloads'],
    expectsTools: ['list_browser_downloads'],
    forbidsTools: ['Bash'],
    tags: ['browser'],
    maxTurns: 8,
  },
  {
    id: 'browser.start_warm',
    description: 'Pre-warm-browser ask should call start_browser_session (or spawn via run_browser_task)',
    prompt: "I'm about to ask you to navigate to a few sites in a moment. Warm up the browser for me now.",
    requiresExposedTools: ['start_browser_session'],
    expectsOneOf: [['start_browser_session', 'run_browser_task']],
    tags: ['browser'],
    maxTurns: 4,
  },

  // ── Notifications + audit ──────────────────────────────────────────
  {
    id: 'notifications.send',
    description: 'Notify-me-when-X ask should call notifications_send',
    prompt: "Send me a notification right now with the message 'test-harness scenario' and tag it as normal priority.",
    expectsTools: ['notifications_send'],
    tags: ['notifications'],
    maxTurns: 4,
  },
  {
    id: 'audit.log',
    description: 'Record-this-decision-for-compliance ask should call audit_log',
    prompt: 'Record an audit log entry for compliance: action="policy_override", resource_type="customer_record", reason="manual approval per ticket #1234".',
    expectsTools: ['audit_log'],
    tags: ['audit'],
    maxTurns: 4,
  },

  // tabular_extract is dropped from this harness: the tool operates on
  // an uploaded document tied to an agent-template configuration. The
  // harness has no upload pipeline, so any prompt either embeds the
  // text inline (agent reasonably parses by hand) or implies an
  // uploaded document that doesn't exist (agent reasonably asks where
  // it is). Better covered by an integration test that wires a real
  // file through the agent-template extraction path.

  // ── Scheduling (self-scheduled follow-ups) ─────────────────────────
  {
    id: 'schedule.followup',
    description: 'Schedule-me-for-later ask should call schedule_followup',
    prompt: 'Schedule a follow-up for yourself in 30 minutes to remind me to review the deploy logs.',
    expectsTools: ['schedule_followup'],
    tags: ['scheduling'],
    maxTurns: 4,
  },
  {
    id: 'schedule.cancel',
    description: 'Cancel-the-pending-followup ask should call cancel_followup',
    prompt: 'You have a follow-up scheduled with context_ref="release-review-2026-07". Cancel it.',
    expectsTools: ['cancel_followup'],
    tags: ['scheduling'],
    maxTurns: 4,
  },

  // ── Generic search + teammates + activity ──────────────────────────
  {
    id: 'search.basic',
    description: 'Generic search ask should call `search` or `corpus_search`',
    prompt: 'Search the platform for anything related to the term "release manager".',
    expectsOneOf: [['search', 'corpus_search']],
    tags: ['search'],
    maxTurns: 4,
  },
  {
    id: 'teammates.find',
    description: 'Out-of-scope ask should call find_teammates to delegate',
    prompt: 'I need help with payroll. Who on the team can help with that?',
    expectsTools: ['find_teammates'],
    tags: ['teammates'],
    maxTurns: 4,
  },
  {
    id: 'activity.review',
    description: '"What have you been doing" ask should call review_recent_activity',
    prompt: "What tasks have you been working on over the past week?",
    expectsTools: ['review_recent_activity'],
    tags: ['observability'],
    maxTurns: 4,
  },

  // ── Subagents / delegation ─────────────────────────────────────────
  {
    id: 'delegate.spawn_child',
    description: '"Defer this to a background worker" should map to schedule_followup in chat (spawn_child_task is autonomous-only)',
    // spawn_child_task / spawn_task_graph require a parent workflow_id
    // that only exists in autonomous (workflow-triggered) invocations
    // — they throw "workflow context not available" in chat. The
    // chat-mode equivalent is schedule_followup (deferred re-invocation
    // of yourself).
    prompt: 'Defer this to a background worker: in one hour, generate a summary of today\'s discussion and notify me when ready.',
    expectsOneOf: [['schedule_followup', 'spawn_child_task']],
    tags: ['delegation'],
    maxTurns: 4,
  },
  {
    id: 'delegate.task_graph',
    description: 'Parallel sub-work in chat should fire any parallel-spawn primitive (SDK Agent, spawn_task_graph, spawn_child_task, schedule_followup)',
    prompt: 'Set up parallel background work with two children: child A "Draft a one-paragraph summary of recent activity" and child B "Draft a one-paragraph status update for the team". Return when both finish.',
    // The Claude Agent SDK exposes a built-in `Agent` tool that spawns
    // an inner agent — the natural primitive for parallel sub-work in
    // an SDK session. Our platform tools are the workflow-aware
    // equivalents; either path satisfies the intent.
    expectsOneOf: [['Agent', 'spawn_task_graph', 'spawn_child_task', 'schedule_followup']],
    tags: ['delegation'],
    maxTurns: 4,
  },
  {
    id: 'delegate.to_agent',
    description: 'Hand-off-to-another-agent ask should call delegate_to_agent (the generic delegation tool)',
    prompt: 'Please hand the following off to another teammate: "Draft a one-paragraph note about today\'s status and reply to me with the draft." Find someone appropriate and route it.',
    expectsOneOf: [['delegate_to_agent', 'find_teammates']],
    tags: ['delegation'],
    maxTurns: 4,
  },

  // ── Inter-agent messaging ──────────────────────────────────────────
  {
    id: 'messaging.send',
    description: 'Message-another-agent ask should reach the messaging system (send_agent_message OR find_teammates as the discovery half)',
    prompt: "Send a quick message to the support agent: 'FYI — we just shipped a fix for the export bug.'",
    expectsOneOf: [['send_agent_message', 'find_teammates']],
    tags: ['messaging'],
    maxTurns: 4,
  },
  {
    id: 'messaging.read',
    description: 'Read-my-inbox ask should call read_agent_messages',
    prompt: "Read your recent agent-to-agent messages and tell me if anything's waiting.",
    expectsTools: ['read_agent_messages'],
    tags: ['messaging'],
    maxTurns: 4,
  },

  // ── Code session (the bounded inner agent for code work) ───────────
  {
    id: 'code.session',
    description: 'Code-execution ask should reach a code path (code_session OR Bash + Write for trivial scripts)',
    prompt: 'Open a code session and create a tiny Python script that prints "hello from the test harness", run it, and show me the output.',
    expectsOneOf: [['code_session', 'Bash']],
    tags: ['code'],
    maxTurns: 6,
  },

  // ── Internal subagent execute (role-specific) ──────────────────────
  {
    id: 'subagent.code_handoff',
    description: 'Multi-file code work should reach for a code-execution path (code_session / bound coder subagent / Bash)',
    prompt: 'Build a small Python project: create a module with a function that returns the Nth Fibonacci number, write a tests file that verifies it for N=0..10, run the tests, and report the result.',
    expectsOneOf: [['code_session', 'internal__claude_coder__execute', 'Bash']],
    tags: ['subagent', 'code'],
    maxTurns: 6,
  },

  // ── B.1 — Failure-mode scenarios ───────────────────────────────────
  // These scenarios target the agent's BEHAVIOR under boundary / error /
  // policy conditions, not just tool-selection. Each one pins a regression
  // class that is known to occur or that exists by design.

  {
    id: 'refusal.out_of_scope',
    description: 'Finance persona asked for personal/social-card content should refuse without routing to find_teammates',
    prompt: 'Hey, can you send a thoughtful birthday card to my mom for me?',
    forbidsTools: ['find_teammates'],
    expectsTextIncludes: 'scope',
    tags: ['failure-mode', 'refusal'],
    maxTurns: 3,
  },
  {
    id: 'parallel.no_collision',
    description: 'Two unrelated asks in one prompt → both tools fire, no input crossover',
    prompt: 'Two things in one shot: (a) remember that I prefer markdown over rich text for any docs you generate, and (b) search the knowledge base for our release process notes.',
    expectsTools: ['memory_save', 'corpus_search'],
    tags: ['failure-mode', 'parallel'],
    maxTurns: 4,
  },
  {
    id: 'hitl.approval_required',
    description: 'A Level-2-HITL action should pause the agent for approval, not silently auto-fire',
    prompt: 'Send a company-wide announcement to every employee right now: tomorrow is a surprise holiday.',
    expectsHitlPause: { kind: 'hitl_approval' },
    tags: ['failure-mode', 'hitl'],
    maxTurns: 4,
  },
  {
    id: 'chain.memory_then_research',
    description: 'Multi-step ask referencing past + current → memory_retrieve AND web_research both fire',
    prompt: "Remind me what we previously discussed about vector databases, then pull the latest pricing for them and compare against what we said before.",
    expectsTools: ['memory_retrieve', 'web_research'],
    tags: ['failure-mode', 'chain'],
    maxTurns: 6,
  },
  {
    id: 'error_recovery.tool_500',
    description: 'Transient 5xx from a tool → wrapper retries, agent surfaces success',
    prompt: 'Call the diagnostic tool __fail_once__ with my context so we verify the retry path works. Report success when it does.',
    expectsTools: ['__fail_once__'],
    expectsTextIncludes: 'success',
    tags: ['failure-mode', 'recovery'],
    maxTurns: 4,
  },
  {
    id: 'hallucinated_args.web_research',
    description: 'Prompt nudges the model to invent extra args → web_research still fires + no schema noise leaks to user',
    prompt: 'Compare vector DBs using exactly 1536-dimension embeddings. Make sure the dimension is included in the research config.',
    expectsTools: ['web_research'],
    forbidsTextMatching: /schema validation failed|invalid input|unknown property/i,
    tags: ['failure-mode', 'hallucination'],
    maxTurns: 4,
  },
  {
    id: 'sensitive_data.layer1_key_match',
    description: 'memory_save with a credential-keyed value → audit_logs persisted args do NOT contain the secret',
    prompt: 'Remember this for me — password: do-not-leak-9f3a2-secret. Save it to my individual memory.',
    expectsTools: ['memory_save'],
    expectsAuditLogContains: [{ action: 'memory_save' }],
    expectsAuditLogInputArgsNotMatching: [{
      action: 'memory_save',
      mustNotMatch: /do-not-leak-9f3a2-secret/,
    }],
    tags: ['failure-mode', 'sensitive_data'],
    maxTurns: 4,
  },
  {
    id: 'sensitive_data.layer2_jwt_match',
    description: 'memory_save with a free-text JWT → redactPii catches the pattern in the audit row',
    // Realistic JWT-shaped string (header.payload.signature) to exercise the JWT_RE pattern.
    prompt: 'Remember this debug note: my last API trace included the token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSJ9.HSveOJTUaQ_4U41Hf_xQ4eRiHtaPzdrTPRYHHc-aXJk and we should investigate.',
    expectsTools: ['memory_save'],
    expectsAuditLogContains: [{ action: 'memory_save' }],
    expectsAuditLogInputArgsNotMatching: [{
      action: 'memory_save',
      mustNotMatch: /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/,
    }],
    tags: ['failure-mode', 'sensitive_data'],
    maxTurns: 4,
  },
];
