// OpenAI, as one endpoint on the OpenAI wire.
//
// This module is OpenAI's answers and nothing else. The run loop it executes in
// lives in ../openai-wire and is shared with OpenRouter and xAI — which is the
// distinction the old layout could not express, because the shared loop and
// OpenAI's own configuration lived in the same directory under the same name. A
// defect in the loop is a defect for three vendors; a defect here is OpenAI's
// alone.

import { webSearchTool } from '@openai/agents';
import { agentPromptCacheKey, bindModel } from '../openai-wire/wire-target';
import type { WireTarget } from '../openai-wire/wire-target';
import { getSdkGatewayProvider } from '../openai-wire/gateway-provider';
import { getSdkOpenAIProvider } from './provider';
import { isOpenAiResponsesModel } from './responses-models';

export { getSdkOpenAIProvider } from './provider';
export { isOpenAiResponsesModel } from './responses-models';

/** Native hosted web tools for OpenAI.
 *
 *  Exported because callers outside the adapter use it. Inside the run loop the
 *  TARGET is asked instead — "which hosted tools does this endpoint run" is a
 *  property of the endpoint, and a model-family match answers it only here. */
export function nativeOpenAiWebTools(model: string): ReturnType<typeof webSearchTool>[] {
  return isOpenAiResponsesModel(model) ? [webSearchTool()] : [];
}

/** OpenAI proper. A customer's OpenAI key is a pure credential swap: the same
 *  endpoint shape, the same model ids, a different account paying. */
export const openAiTarget: WireTarget = {
  name: 'openai',
  async sdkProvider(input) {
    if (input.byok?.vendor === 'openai') {
      return getSdkGatewayProvider('openai', input.byok.baseUrl, input.byok.token);
    }
    return getSdkOpenAIProvider(input.purpose);
  },
  async modelId(input, provider) {
    return bindModel(provider, input.model);
  },
  // OpenAI's hosted web_search, on the Responses-API families that serve it.
  // Other OpenAI models get none, and the platform's bridged web tools cover
  // web there.
  // OpenAI is the endpoint this parameter belongs to; the other two targets
  // deliberately answer nothing.
  promptCacheKey(input) {
    return agentPromptCacheKey(input);
  },
  nativeWebTools(input) {
    return nativeOpenAiWebTools(input.model);
  },
};
