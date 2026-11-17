// The prompt a `capability` workflow step runs as.
//
// A capability step stores a vendor-agnostic need (WorkflowCapabilityNeed), not
// a vendor or a handle — discovery is live and the vendor must stay out of agent
// config. The step executes as a structured micro-turn: the runtime hands the
// model this prompt, the adapter drives capability_search (a read) then
// run_capability through the SAME canUseTool gate a model-issued call uses, so a
// write/outbound capability pauses for approval (item 9) and resumes normally.
// The model chooses among vendor-agnostic ranked results by opaque capabilityId;
// no vendor name ever reaches the transcript.

import type { WorkflowCapabilityNeed } from '../types';

/** Build the instruction for a capability step. `stepDescription` is the
 *  authored goal; `need` is the vendor-agnostic search spec; `args` are the
 *  capability's own call arguments, already template-resolved. Deterministic in
 *  its inputs so the prompt is byte-stable across runs (cacheable prefix). */
export function buildCapabilityStepPrompt(
  need: WorkflowCapabilityNeed,
  args: Record<string, unknown>,
  stepDescription: string,
): string {
  const fields: string[] = [
    `operation: ${JSON.stringify(need.operation)}`,
    `entity: ${JSON.stringify(need.entity)}`,
    `mode: ${JSON.stringify(need.mode)}`,
  ];
  if (need.targetSystem) fields.push(`targetSystem: ${JSON.stringify(need.targetSystem)}`);
  if (need.availableInputs && need.availableInputs.length > 0) {
    fields.push(`availableInputs: ${JSON.stringify(need.availableInputs)}`);
  }
  if (need.requiredOutputFields && need.requiredOutputFields.length > 0) {
    fields.push(`requiredOutputFields: ${JSON.stringify(need.requiredOutputFields)}`);
  }
  const argsJson = JSON.stringify(args ?? {});
  // The step's arguments are its VALUES in its own words — what to search
  // for, how many, which window. The capability is resolved live and names
  // its arguments itself, so the values are passed under the capability's
  // names; passed verbatim, a keyword under a name the capability does not
  // list is ignored and the run searches for nothing. A step that declares
  // no arguments has not decided them, and the model builds them from the
  // goal and the arguments the search result lists.
  const runLine = Object.keys(args ?? {}).length > 0
    ? `2. From the ranked results, call run_capability on the best-fitting capabilityId. This step's arguments are ${argsJson}: they are the step's VALUES, named in the step's own words. The capability names its own arguments (the search result lists them), so pass each value under the capability's name for it — the search term under its search-term argument, the limit under its limit, the window under its time filter — and pass nothing under a name the capability does not list. If the result is empty, check the mapping once against the listed arguments before recording an empty result.`
    : `2. From the ranked results, call run_capability on the best-fitting capabilityId. This step declares no arguments, so build them from this step's goal and the args the search result lists for that capability: the search term or keyword the goal names, the limit it states, the window it asks for. Invent nothing the goal does not say.`;
  return [
    `This step's goal: ${stepDescription}`,
    ``,
    `Accomplish it with the capability library:`,
    `1. Call capability_search with these fields: { ${fields.join(', ')} }.`,
    runLine,
    ``,
    // Deliberately does NOT cap the number of tool calls or forbid "other" tools:
    // a step that declares an outputField must ALSO call record_step_output as its
    // final action (see invokeStepLLM's output contract), and "exactly two calls /
    // call no other tool" contradicted that — the model then skipped the recording
    // and the step returned prose that outputField extraction rejects. Base the
    // output on what run_capability returned and add no commentary of your own; do
    // not reach for tools unrelated to this step. If the capability needs human
    // approval it pauses (expected — the step resumes once approved). If
    // capability_search returns nothing usable, report that plainly rather than
    // improvising an unrelated tool.
    `Base your output only on what run_capability actually returned, and add no commentary of your own. A large result is kept as a dataset and you get its id, fields and a sample: read what this step needs with dataset_query (the fields you name, filtered, sorted, limited) or dataset_extract (an instruction answered over the records for you); never try to read every record and never run the capability again for records it already returned. Follow this step's own output instructions (record the result if asked). If the capability needs human approval it pauses; that is expected, and this step resumes once a person approves. If capability_search returns nothing usable, report that plainly rather than reaching for an unrelated tool.`,
  ].join('\n');
}

// ── The web fallback turn ──────────────────────────────────────────────────
//
// A capability step whose first micro-turn produced no useful result — every
// run_capability answered nothing or failed, and no web tool returned content
// — gets exactly one more turn, on the web tools alone. The second turn is
// web-only BY CONSTRUCTION, not by prompt: its tool catalog is registered from
// this allowlist (invokeStepLLM → buildPlatformMcpCatalog →
// createToolGatewayMcpServer), so the model cannot re-enter the capability
// library there, cannot write to a connector, and cannot drive the browser.
// The prompt says what the turn is for; the catalog is what holds it to that.

/** The read-only web search, fetch and research tools the fallback turn may
 *  use. Every name here is classified `read` in tool-gateway/tool-effect.ts
 *  (pinned by a test), and each is offered only where the run has a backend
 *  for it — the platform's own for the native-backed tools, a bound
 *  connector for `web_extract` and `web_diff` — so the allowlist admits, it
 *  does not grant. Browser interaction (`web_task`, `run_browser_task`, the
 *  session and identity tools) is not here: the fallback reads the public
 *  web, it does not act on it. */
export const CAPABILITY_WEB_FALLBACK_TOOLS: ReadonlySet<string> = new Set([
  'web_search',
  'web_fetch_advanced',
  'web_extract',
  'web_research',
  'web_people_search',
  'web_x_search',
  'web_finance_search',
  'web_deep_research',
  'web_diff',
]);

/** The fallback turn's registered tool set: the web tools above, plus
 *  `record_step_output` when the step declares an `outputField` — the step's
 *  output contract is the same on the second turn as on the first, and a
 *  contract with no tool to satisfy it fails every time. */
export function webFallbackToolAllowlist(stepOutputField: string | undefined): ReadonlySet<string> {
  const allow = new Set(CAPABILITY_WEB_FALLBACK_TOOLS);
  if (stepOutputField) allow.add('record_step_output');
  return allow;
}

/** Characters of the first turn's output carried into the second, so the
 *  model knows what was already tried without the whole turn in its window. */
const FIRST_TURN_CONTEXT_MAX_CHARS = 1_500;

/** Build the instruction for the fallback turn. Deterministic in its inputs
 *  (byte-stable for equal inputs, like the first turn's prompt), and names
 *  no vendor: the need is vendor-agnostic and the first turn's text is the
 *  model's own, which the control plane already scrubbed. */
export function buildCapabilityWebFallbackPrompt(
  need: WorkflowCapabilityNeed,
  args: Record<string, unknown>,
  stepDescription: string,
  /** What the first turn produced — its prose or its recorded value — so the
   *  second turn does not repeat the search that found nothing. */
  firstTurnOutput?: unknown,
): string {
  const goalLine = `This step's goal: ${stepDescription}`;
  const needLine = `What it needs: ${need.operation} ${need.entity}${need.targetSystem ? ` on ${need.targetSystem}` : ''}`;
  const argsJson = JSON.stringify(args ?? {});
  const valuesLine = Object.keys(args ?? {}).length > 0
    ? `The step's values, in its own words: ${argsJson}.`
    : 'The step declares no values; take the search terms, the limit and the window from the goal, and invent nothing the goal does not say.';
  const fieldsLine = need.requiredOutputFields && need.requiredOutputFields.length > 0
    ? `The result must carry these fields: ${JSON.stringify(need.requiredOutputFields)}.`
    : null;
  const priorText = firstTurnOutput === undefined || firstTurnOutput === null
    ? ''
    : typeof firstTurnOutput === 'string' ? firstTurnOutput : JSON.stringify(firstTurnOutput);
  const priorLine = priorText.trim().length > 0
    ? `What the first attempt produced (it met the need with nothing usable): ${priorText.length > FIRST_TURN_CONTEXT_MAX_CHARS ? `${priorText.slice(0, FIRST_TURN_CONTEXT_MAX_CHARS)}…` : priorText}`
    : null;
  return [
    goalLine,
    '',
    'The capability library could not meet this step\'s need. Do it with the web tools you have in this turn (search, fetch, research) and nothing else.',
    needLine,
    valuesLine,
    ...(fieldsLine ? [fieldsLine] : []),
    ...(priorLine ? ['', priorLine] : []),
    '',
    'Base the output only on what the tools return, and add no commentary of your own. Do not state, guess or speculate about why the earlier attempt found nothing. Follow this step\'s own output instructions (record the result if asked). If the web tools return nothing usable either, report that plainly.',
  ].join('\n');
}
