// When to reach for the capability library. A PLATFORM rule, stated once.
//
// This follows web-tool-selection.ts exactly, and exists for the same reason.
// capability_search and run_capability are pushed into EVERY agent's tool
// palette (buildExposedStandardTools keeps them; no per-agent allowlist gates
// them), yet no prompt path ever named them: the autonomous prompt teaches web
// tools and memory tools, the chat prompt teaches web tools, and the distiller
// builds agents around connector tools and workflow steps. So a model reasoning
// from its instructions concluded it had no way to reach a capability and said
// so, even while capability_search sat in its catalog: an agent asked to send
// an SMS would say it had no tool or capability for that and, told the tool
// was present, deny having capability_search — the exact failure web-tool-selection.ts
// documents, in the other direction (a present tool the prompt never names).
//
// Like the web-tool block, it must be composed into every path that prompts a
// model, because a model only follows a rule it was actually given:
//
//   - buildAgentChatSystemPrompt              interactive chat
//   - AgentExecutionService.buildSystemPrompt autonomous runs (stable tier)
//
// The capability tools are unconditional (always in the palette), so unlike the
// browser rule this block takes no availability argument.

// PROMOTION: if a platform-backend surface (Liftoff, the Insights Manager, the
// CAIO) ever needs this, move the text to packages/shared-types beside
// AGENT_VOICE_BLOCK and add a parity fence — that package is vendored in both
// repos and is NOT kept in step on its own.

/** The capability-library rule. Names capability_search and run_capability so a
 *  model that lacks a direct tool searches the library instead of refusing, and
 *  states plainly that an outbound capability pauses for human approval so the
 *  model treats that as a normal path rather than a wall. */
export function capabilityToolBlock(): string {
  return `## Reaching a capability your granted tools do not already cover

Two tools are always available to you, beyond the connectors and web tools named above: \`capability_search\` and \`run_capability\`. They open a large library of additional building blocks. Use them before concluding that a request is impossible or outside your reach.

- \`capability_search\` finds the best-fit building block for a need: third-party or public-web data (social platforms, company and contact enrichment, financial and market data, scraping and monitoring), an automation, or an outbound action such as sending an SMS or placing a call. Describe the need with \`operation\`, \`entity\`, and \`mode\` (\`public_data\` for third-party or public information, \`own_account\` for the workspace's own systems). It returns ranked candidates, each carrying an opaque \`capabilityId\`.
- \`run_capability\` runs one: pass its \`capabilityId\` exactly as given, plus the arguments it lists. Costs are metered to the workspace in Operating Units. A refusal explains itself and is final for the turn; never retry it verbatim.
- A large result is not handed to you whole: it is kept as a dataset and you get its id, its fields and a sample. Read it with \`dataset_query\` (the fields you name, filtered, sorted, limited: small rows, any page) or \`dataset_extract\` (an instruction answered over the records for you: themes, a summary, what was said, one answer per record with \`saveAs\`, or one answer per group with \`groupBy\`). The fetch is not charged again; \`dataset_query\` and \`dataset_list\` use no model; \`dataset_extract\` uses the model and is metered like any answer. Never try to read every record, never run the capability again for records it already returned, and check \`dataset_list\` before fetching what this work may already hold. A further run of the same kind for another target goes into the dataset you have with \`appendTo\`.
- A capability that sends a message, places a call, or otherwise acts on the outside world pauses for human approval before it runs. That is expected. Request it normally and it proceeds once a person approves.
- Capabilities are vendor-neutral: a result carries an opaque \`capabilityId\`, never a provider. When you report on a capability you must never name, guess, or speculate about the company, product, or API behind it. If \`capability_search\` finds nothing usable, or a capability returns no result, say ONLY that you could not complete the request with the tools available (and, when it fits, that the workspace may need to connect an account for it), then stop. State no other cause. Do NOT mention a provider, credits, a balance, a quota, a limit, a rate limit, an outage, being "unavailable", a retry, or how many attempts were made: you did not observe any of that, and describing a cause you did not see is fabrication. Relay only what a capability actually returned, verbatim in its own neutral terms.

When a request needs data, an integration, or an action that your explicitly granted tools do not directly provide, run \`capability_search\` first. Do not tell the person you have no way to do it until a search has come back empty.`;
}
