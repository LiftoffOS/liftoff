// OpenRouter, as one endpoint on the OpenAI wire.
//
// It fronts five vendors — GLM, Qwen, DeepSeek, Kimi — over a single
// integration and a single invoice, which is the whole reason it is here. Grok
// used to be the fifth and left: it has an account and an API of its own, and
// exactly one of the five could be funded by a customer's own key, which an
// OpenRouter invoice cannot settle.
//
// BYO PROVIDER KEYS: not fundable, and not for want of wiring. An OpenRouter
// invoice is Liftoff's, and the keys card offers no OpenRouter field because a
// customer cannot hold a key for our account. Grok was the one OpenRouter-hosted
// vendor a customer COULD fund, and that is exactly why it now has a provider of
// its own: funding it used to mean leaving OpenRouter mid-run.

import { bindModel , agentStickySessionId } from '../openai-wire/wire-target';
import type { WireTarget } from '../openai-wire/wire-target';
import { getSdkOpenRouterProvider } from './provider';

export { getSdkOpenRouterProvider } from './provider';

/** OpenRouter, on Liftoff's account. Never customer-funded: an OpenRouter
 *  invoice is ours, and no customer holds a key for it. */
export const openRouterTarget: WireTarget = {
  // OpenRouter fans out across providers and the cache is per provider, so a
  // prefix cached on one is missed by the next. The session pins a conversation
  // to the provider that served it from the FIRST successful request; without
  // one, stickiness begins only after a cache hit has already happened, which
  // is the hit that never comes.
  stickySessionId(input) {
    return agentStickySessionId(input);
  },

  name: 'openrouter',
  async sdkProvider() {
    const provider = await getSdkOpenRouterProvider();
    if (!provider) {
      // No OPENROUTER_API_KEY. Refused here rather than returned as undefined:
      // undefined means "use the SDK default", and the SDK default is an OpenAI
      // client, which reports a missing OPENAI_API_KEY for a run that has
      // nothing to do with OpenAI. A missing key names itself.
      throw new Error(
        'openrouter: no OPENROUTER_API_KEY is configured for this runtime, so no '
        + 'OpenRouter-hosted model can run. This is NOT an OpenAI problem.',
      );
    }
    return provider;
  },
  async modelId(input, provider) {
    return bindModel(provider, input.model);
  },
  // None. OpenRouter runs no hosted tools on our behalf; those models reach the
  // web through the platform's own bridged tools.
  // No prompt-cache routing key. OpenRouter fans a request out to whichever upstream is cheapest or up, so
  // there is no one cache behind it to route to and no such parameter on the
  // wire. Any upstream prompt caching it does is its own business.
  //
  // Left unimplemented rather than returning undefined, so the absence is a
  // stated answer and not a stub.
  nativeWebTools() {
    return [];
  },
};
