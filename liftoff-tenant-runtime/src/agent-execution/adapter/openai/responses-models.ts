// Which OPENAI models serve the Responses API, and therefore its hosted tools.
//
// Its own module so a target can ask without importing the adapter that
// imports the targets. The question is OpenAI-specific by construction: it
// matches OpenAI's model families, so every other vendor's model answers false
// — which is correct for OpenAI's tools and wrong as a general test of "does
// this endpoint run hosted tools". Each target answers that for itself.

/** OpenAI's hosted `web_search` tool runs only on Responses-API models; the
 *  SDK throws if it's attached to an incompatible model. Gate on the model
 *  family so a non-Responses model just falls back to platform web tools
 *  (web_fetch_advanced etc., bridged as function tools) instead of erroring.
 *  OpenAI has no hosted web_fetch — fetch is served by web_fetch_advanced.
 *
 *  Confirmed Responses-API web_search families: GPT-5 series and GPT-4.1
 *  series. (GPT-4o routes web search through Chat-Completions search-preview
 *  models, NOT this hosted tool; o-series support is unconfirmed — both are
 *  intentionally excluded so we never attach a tool the model rejects.) */
const OPENAI_RESPONSES_MODEL_PATTERNS: readonly RegExp[] = [/^gpt-5/, /^gpt-4\.1/];

export function isOpenAiResponsesModel(model: string): boolean {
  return OPENAI_RESPONSES_MODEL_PATTERNS.some((re) => re.test(model));
}
