// The one gate for framing a STRUCTURED web result on its way to a model.
//
// `web_fetch_advanced` and the browser extractions are one text field each, so
// they are framed where they are produced. `web_extract` and `web_task` are
// not: their payload is `unknown`, and nothing recursively wraps an object.
// Their handlers screen the value and leave it exactly as it is, which means
// the frame has to go on the SERIALISATION — the string the model actually
// reads — and there is more than one of those:
//
//   - the MCP / tool-gateway path, where a standard tool's result is
//     JSON.stringify'd into one text block;
//   - the autonomous path's prompt, by three routes (the prior step's summary,
//     the earlier-outputs section, and a `{{…}}` reference substituted into
//     the step's objective).
//
// One rule, written once here, so a route added later cannot quietly get a
// different answer — and so the discriminator is a list rather than a string
// comparison repeated in four places.
//
// NOTHING is written back. The handler's result object, the audit row,
// `stdResult`, `completedToolCalls`, `stepOutputs`, `step.description` and
// every workflow output keep the raw structured value; only the prompt text
// changes, and only for these two tools.

import { frameUntrusted } from '../../workspace/untrusted-content-wrapper';

/** The tools whose result is structure rather than one text field, and which
 *  therefore reach the model through a serialisation that has to carry the
 *  frame. */
export const FRAMED_STRUCTURED_WEB_TOOLS: ReadonlySet<string> = new Set(['web_extract', 'web_task']);

/**
 * Frame a step output's prompt-only rendering when the tool that produced it
 * is one of those two. Anything else is returned unchanged, which is today's
 * behaviour for every other tool.
 *
 * No `screenCtx`: the structured value was already screened explicitly in the
 * handler, and this string hashes differently from the extracted text, so a
 * second screen would neither deduplicate nor add anything.
 */
export function frameStepOutputForPrompt(rendered: string, producedBy: string | undefined): string {
  if (!rendered || !producedBy || !FRAMED_STRUCTURED_WEB_TOOLS.has(producedBy)) return rendered;
  return frameUntrusted(`web:${producedBy}`, rendered);
}
