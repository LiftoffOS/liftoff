// Which web tool answers which kind of request. A PLATFORM rule, stated once.
//
// The platform owns this the same way it owns the voice rules, and for the same
// reason: it is not a property of any one agent, and an agent that gets it wrong
// looks broken to the person watching. See agent-voice.ts for the pattern this
// follows.
//
// It has to be composed at inference time into EVERY path that prompts a model,
// because a model only follows a rule it was actually given:
//
//   - buildAgentChatSystemPrompt        interactive chat
//   - AgentExecutionService.buildSystemPrompt   autonomous runs (stable tier)
//   - the workflow-step prompt          one per step of a distilled workflow
//   - buildRecoveryPrompt               the recovery advisor
//
// The workflow-step path is why this file exists. That prompt is assembled from
// scratch per step and had never carried the map, so a distilled agent chose its
// tools from its own step text instead. Asked to "navigate to espn.com" it
// classified the request as a page read because a URL was present, fetched the
// page invisibly, and reported success while the browser pane the person was
// looking at stayed blank. The rule existed; that call never received it. The
// voice rules and the user's own message had each already been missing from the
// same prompt for the same reason.
//
import { hasSessionBrowserConnector, platformPaneBrowserOn } from '../browser-sessions/session-vendor-connectors';

// PROMOTION: if a platform-backend surface (Liftoff, the Insights Manager, the
// CAIO) ever needs this, move the text to packages/shared-types beside
// AGENT_VOICE_BLOCK and add a parity fence — that package is vendored in both
// repos and is NOT kept in step on its own.

/** Capability-aware, because a prompt that names an absent tool is worse than
 *  one that names none: the model reasons from the instruction rather than the
 *  catalog, goes looking for a tool it does not have, and reports that it has no
 *  tools at all. Enforced by prompt-palette-agreement.test.ts. */
export function webToolSelectionBlock(opts: { hasVisibleBrowser: boolean }): string {
  const browserRule = opts.hasVisibleBrowser
    ? `1. **They want to SEE or DRIVE a browser** , "navigate to", "go to", "open", "visit", "show me", "take me to", "log in to", "click through", "search on <site>".
   → Use \`navigate_browser_session\` for a destination, or \`run_browser_task\` when the ask is multi-step work ("log in and download the invoices"). These drive the browser pane the person is watching: the pane opens if it is closed, and they can watch and take over.
   → This is decided by the VERB, never by whether a URL is present. "Navigate to <url>" and "summarise <url>" carry the same URL and are different requests.
   → A fetch tool CANNOT satisfy this intent. It returns text and leaves the pane blank, which the person experiences as being ignored.`
    : `1. **They want to SEE or DRIVE a browser** , "navigate to", "go to", "show me", "log in to".
   → No browser is connected for this workspace, so there is no visible browser to drive. Say so plainly, then offer the page's CONTENT via a fetch tool. Do not silently substitute a fetch and describe it as having opened a browser.`;

  return `## Choosing a web tool

Match the person's INTENT. The presence of a URL does not decide this on its own.

${browserRule}

2. **They want the CONTENT of a page** , "summarise this", "what does this page say", "read me <url>", "extract the prices from <url>".
   → \`WebFetch\` first; it is cheapest for a public page. If it comes back blocked, empty or 4xx, escalate to \`web_fetch_advanced\`, which renders JS and gets through anti-bot and login walls. Do not escalate to a browser just because a fetch failed: they did not ask to watch anything.

3. **They want an answer drawn from several sources** , "compare X across vendors", "what do reviewers say about Y", "recent research on Z".
   → \`web_research\`. Prefer the specialised variants when the subject matches: \`web_people_search\` for a named person, \`web_finance_search\` for tickers, filings, earnings or funding, \`web_x_search\` for what is being said on X. A plain search, "find pages on X", "is it true that Y", "where is the Z page", is \`web_search\` or the web search tool native to your runtime, whichever you hold: ranked results, no synthesis, cheaper.

This rule outranks any step description or instruction that names a specific tool for a whole category of request. A step that says to fetch every URL is describing the common case, not overriding what THIS person asked for.`;
}

/** Whether this agent has a browser a person can watch.
 *
 *  Both halves, exactly as the tool palette asks them: a connector the WORKSPACE
 *  brought that can drive the pane, or the platform's own Browser Use key, which
 *  backs one for an agent bound to nothing.
 *
 *  The execution paths hold `integrations` (objects) while the chat path holds
 *  connector TYPES already, so this takes the object shape and the chat path
 *  passes its own boolean.
 *
 *  Asking only the first half is not a smaller mistake than asking neither. The
 *  palette is built by buildExposedStandardTools, which the autonomous and
 *  workflow-step paths share with chat, so under the platform key it hands those
 *  runs navigate_browser_session while this block told them "No browser is
 *  connected for this workspace, so there is no visible browser to drive." A
 *  model follows the instruction over the catalog, which is how a run with a
 *  working browser reports that it has none. */
export async function hasVisibleBrowserFrom(
  tenantId: string,
  integrations: ReadonlyArray<{ type?: string; id?: string }> | undefined,
): Promise<boolean> {
  const types = (integrations ?? [])
    .map((i) => i.type || i.id)
    .filter((v): v is string => !!v);
  if (hasSessionBrowserConnector(types)) return true;
  return platformPaneBrowserOn(tenantId);
}
