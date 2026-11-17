// FITNESS FUNCTION — platform machinery does not borrow the agent's model id.
//
// Two calls in the hybrid loop are PLATFORM machinery rather than the agent's
// own work: the recovery advisor, and semantic step validation. Both
// deliberately force `llmClient.complete`'s provider argument to `undefined`,
// meaning the platform default — because llmClient has no OpenRouter provider
// at all, and following the workspace vendor turned every recovery on an
// OpenRouter workspace into `recovery_llm_unavailable`.
//
// That fix was applied to the PROVIDER and not to the MODEL. Both calls went on
// passing `state.context.modelConfig?.modelId`, so a provider forced to
// Anthropic received the agent's `x-ai/grok-4.6` — or `gpt-5.6-terra`, or
// `gemini-3.1-pro-preview` — and answered 404 not_found. A model id is only
// meaningful ON a provider, and these two decisions have to agree.
//
// The blast radius was every agent not on the default provider, which is every
// OpenAI, Google and OpenRouter workspace. Only Anthropic agents ever had
// working recovery.
//
// The two failure modes differ, and the second is worse:
//   - recovery escalates the run with `recovery_llm_unavailable`, kind
//     system_internal, so nobody is notified and the run simply ends.
//   - semantic validation catches and returns `{ pass: true }`. It has been
//     passing every step unread for those agents, reporting a check that never
//     ran as a check that succeeded.
//
// The tier still travels, because a tier is a capability level rather than a
// vendor choice: AnthropicProvider resolves `request.model ?? TIER_MODELS[tier]
// ?? DEFAULT_MODEL`, so the platform default maps `large` onto its own.
//
// Asserted against source: the property is about which argument is passed at a
// call site, and a behavioural test would need the whole hybrid loop plus a
// live provider to observe a 404 that only happens off the default vendor.

import { readFileSync } from 'fs';
import { join } from 'path';

const SERVICE = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

/** The request object literal of each `llmClient.complete(` call. */
function completeRequests(): string[] {
  return SERVICE
    .split('llmClient.complete(')
    .slice(1)
    .map((chunk) => chunk.slice(0, 3000));
}

describe('platform-machinery LLM calls', () => {
  it('finds the calls, so this cannot pass vacuously', () => {
    expect(completeRequests().length).toBeGreaterThan(0);
  });

  it('never sends the agent\'s model id to a platform-default provider', () => {
    // The exact expression that caused it. A model id resolved for one provider
    // is a 404 on another, and these calls do not choose their provider.
    for (const req of completeRequests()) {
      expect(req).not.toContain('model: state.context.modelConfig?.modelId');
    }
  });

  it('sends the tier instead, so capability still tracks the agent', () => {
    // Dropping the model must not silently promote a small agent's advisor to
    // the platform's large model. Normalised, because the stored config can
    // still carry the top tier's retired name.
    for (const req of completeRequests()) {
      expect(req).toContain('tier: normalizeTier(state.context.modelConfig?.tier)');
    }
  });

  it('does not cast the tier to a union it does not have', () => {
    // Both sites once carried `as 'fast' | <top tier> | undefined`. The real
    // union is 'large' | 'medium' | 'small', so the cast asserted a shape the
    // value never had and hid that `medium` and `small` were being passed.
    expect(SERVICE).not.toContain("as 'fast' |");
  });

  it('still forces the provider to the platform default', () => {
    // The half that was already right. If this regresses to the workspace
    // vendor, OpenRouter agents break again — llmClient registers no completion
    // provider for it.
    expect(SERVICE).toContain('llmClient.complete>[2]');
    expect(SERVICE).toContain("purpose: 'agent_recovery'");
  });
});
