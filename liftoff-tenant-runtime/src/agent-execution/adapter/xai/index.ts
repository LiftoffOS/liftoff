// The xAI adapter. Serves Grok — both Liftoff-funded and customer-funded.
//
// WHY GROK IS ITS OWN PROVIDER
//
// It used to execute as `openrouter`, which bought one integration and one
// invoice across five vendors and cost three things that could not be expressed
// from inside that arrangement:
//
//   1. WHICH of the five an agent had chosen. Selecting Grok set the provider
//      and nothing else, so the model came from OpenRouter's shared tier map —
//      a Grok agent ran GLM unless someone pinned a concrete id.
//   2. That exactly one of the five can be funded by a customer's own key. An
//      OpenRouter invoice is Liftoff's, so an xAI key cannot settle it, and
//      funding a Grok turn meant LEAVING OpenRouter mid-run: an adapter swap
//      keyed on the credential, which the resolved provider knew nothing about.
//   3. Its rates, which came from OpenRouter's list because that is where it
//      billed.
//
// Grok has an account and an API of its own, so it has a provider of its own.
// OpenRouter keeps the open-weight models, where one integration across many
// vendors is exactly the point. Both funding models come through here; only the
// credential differs.
//
// It previously lived as two `vendor === 'xai'` branches inside the OpenAI
// adapter, which is the file that also serves OpenAI proper and the other four
// OpenRouter vendors. That worked, and it was the wrong place: every future way
// xAI diverges — reasoning parameters, tool-call shape, error bodies — would
// have landed as another branch in code serving vendors it has nothing to do
// with, and a mistake there reaches all of them.
//
// WHY IT SUBCLASSES RATHER THAN COPIES
//
// xAI speaks the OpenAI wire format, so the tool loop, guardrails and event
// translation are identical. What differs is a WireTarget: which provider the
// call goes through, and what the endpoint calls the model. Sharing the
// implementation while owning those two answers is the whole of the difference,
// and it is why this file is short rather than a second copy of a 615-line
// adapter.

import { OpenAiWireAdapter } from '../openai-wire';
import { getSdkGatewayProvider } from '../openai-wire/gateway-provider';
import { bindModel } from '../openai-wire/wire-target';
import type { HostedTool, WireTarget } from '../openai-wire/wire-target';
import { getSdkXaiProvider } from './provider';
import { xaiNativeModelId } from '../../../llm/providers/xai';

/** The model id xAI's own API expects.
 *
 *  Defined beside the tier map and the base URL rather than here, because the
 *  PRICING path needs the same answer: a rate looked up under OpenRouter's slug
 *  matches nothing and records the run at zero cost. Re-exported because this is
 *  where the adapter's callers expect it. */
export { xaiNativeModelId } from '../../../llm/providers/xai';

/** api.x.ai, reached through the Liftoff gateway so the customer's key stays in
 *  the control plane and this process only ever holds a short-lived token. */
export const xaiTarget: WireTarget = {
  name: 'xai',
  async sdkProvider(input) {
    // Customer-funded: the gateway, carrying a short-lived per-run token. The
    // customer's key itself never reaches this process.
    if (input.byok) {
      return getSdkGatewayProvider('xai', input.byok.baseUrl, input.byok.token);
    }
    // Managed: Liftoff's own xAI account.
    const provider = await getSdkXaiProvider();
    if (!provider) {
      // No XAI_API_KEY. Refused rather than returned as undefined, for the same
      // reason OpenRouter refuses: undefined means "use the SDK default", and
      // the SDK default is an OpenAI client, which reports a missing
      // OPENAI_API_KEY for a run that has nothing to do with OpenAI.
      throw new Error(
        'xai: no XAI_API_KEY is configured for this runtime, so managed Grok '
        + 'cannot run. This is NOT an OpenAI problem.',
      );
    }
    return provider;
  },
  async modelId(input, provider) {
    return bindModel(provider, xaiNativeModelId(input.model));
  },
  // xAI's OWN web_search, on every Grok model.
  //
  // Reachable only on the Responses surface: chat completions rejects
  // `{"type":"web_search"}` and names `function` and `live_search` as the only
  // tool types it knows, and Live Search is a different, older feature. That is
  // why the provider is built without `useResponses:false`.
  //
  // Offered unconditionally rather than gated on a model family. OpenAI needs
  // that gate because only some of its models serve the tool; every Grok model
  // in the catalogue does, so a gate here would only be a way to get it wrong
  // later.
  // No prompt-cache routing key. api.x.ai speaks the OpenAI wire format but does not carry this parameter,
  // and it is an endpoint that REFUSES options it does not know rather than
  // ignoring them — the same reason xaiWebSearchTool() is hand-built.
  //
  // Left unimplemented rather than returning undefined, so the absence is a
  // stated answer and not a stub.
  nativeWebTools() {
    return [xaiWebSearchTool()];
  },
};

/**
 * xAI's hosted web_search, as a tool declaration.
 *
 * Built by hand rather than with the SDK's `webSearchTool()`, which always
 * sends OpenAI's `search_context_size`: the option cannot be omitted, because
 * an undefined one falls back to `'medium'`. api.x.ai refuses it outright —
 *
 *     400 "Argument not supported: search_context_size"
 *
 * — and that refusal is not a degraded search but a failed model call: the step
 * produces no output and no usage, and the run recovers into a clarification
 * instead of answering. A hosted tool declaration carries the vendor's own
 * argument surface, so it cannot be shared between vendors just because both
 * call the tool `web_search`.
 */
function xaiWebSearchTool(): HostedTool {
  return {
    type: 'hosted_tool',
    name: 'web_search',
    providerData: { type: 'web_search' },
  } as HostedTool;
}

/** The xAI adapter: the shared OpenAI-wire loop, pointed at this target.
 *
 *  A function rather than a subclass. The subclass existed only to name the
 *  endpoint `xai`, and the shared class now reads that off the target — so
 *  every future endpoint on this wire is a target and a factory, never another
 *  class to keep in step with the loop. */
export function createXaiAdapter(): OpenAiWireAdapter {
  return new OpenAiWireAdapter({ target: xaiTarget });
}
