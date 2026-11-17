// What opencode is told about a model we register with it.
//
// REGISTERING A MODEL COSTS IT ITS METADATA, and that is the whole reason this
// module exists. opencode validates a model against a bundled models.dev
// snapshot that lags the vendors, so a current slug is rejected outright unless
// it is registered under `provider.<id>.models` — but a registered entry is a
// FULL model record, and every field left out takes a DEFAULT rather than
// staying unknown. Two of those defaults are wrong for the models we run, and
// both fail quietly:
//
//   limit.context defaults to 0, and 0 does not mean "unlimited". `isOverflow`
//   returns false whenever the context limit is 0, so auto-compaction never
//   fires and the session grows until the vendor rejects it. opencode's own
//   test pins this ("returns false when model context limit is 0", at 110k
//   tokens), and it would void the main adapter's `managesOwnContext`: it
//   cannot self-manage a window it was told nothing about.
//
//   reasoning defaults to false, which gates `variants()` — the reasoning
//   EFFORT variants. It is inert for most of what we run (opencode returns no
//   variants for qwen / kimi / deepseek / non-5.2 glm whatever the flag says)
//   and NOT inert for GLM-5.2, our GLM large model and the default coding model:
//   with it true, opencode offers `high` and `xhigh` mapped to GLM-5.2's native
//   effort on OpenRouter. It does not turn thinking on or off — no OpenRouter
//   path reads it for that; the branches that do are google / anthropic /
//   alibaba-cn / meta specific.
//
// Cost is deliberately NOT set. opencode would compute a per-session figure
// from it, and a figure derived from a rate WE supplied is not independent
// evidence of anything; the platform rate table prices these sessions from the
// token counts, the same way it prices every other call.

import { contextWindowForModel, mayDriveRetirement } from '../../../llm/context-window';
import { isNonReasoningGrokModel } from '../../../llm/providers/xai';
import { logger } from '../../../infrastructure/logging';

/** Generation headroom held back from the context window, in tokens.
 *
 *  opencode computes what it can spend as `context - maxOutputTokens`, so this
 *  is what makes compaction fire BEFORE the window is full rather than at the
 *  moment the next request would overflow it. A generous coding-turn ceiling:
 *  too small truncates a long answer, too large compacts earlier than needed,
 *  and only the first of those loses work. */
export const OPENCODE_OUTPUT_RESERVE_TOKENS =
  Number(process.env.OPENCODE_OUTPUT_RESERVE_TOKENS) || 32_000;

export interface OpencodeModelEntry {
  name: string;
  reasoning: boolean;
  limit?: { context: number; output: number };
}

/**
 * The model record to register with opencode.
 *
 * `family` is the provider the registry files the model under — `glm`, `xai` —
 * and NOT the transport opencode reaches it through: the four open-weights
 * families share the `openrouter` transport, and a window looked up under the
 * transport's name matches nothing and silently leaves the session without a
 * compaction limit.
 *
 * Only a RECORDED window is sent. The provider floor is a family-wide lower
 * bound, and passing one here would compact a 1M-token model at 200k; when the
 * registry has nothing, the field is omitted so opencode's own snapshot value
 * (which may well be right) still applies, and the gap is logged rather than
 * papered over with a guess.
 */
export function opencodeModelEntry(family: string, model: string): OpencodeModelEntry {
  // Every model reaching opencode is one of the open-weights vendors' reasoning
  // models, or Grok. The registry records no reasoning capability for any model
  // — its `capabilities` array carries tools/streaming/vision/video and nothing
  // about thinking — so there is no per-model source to read this from, and the
  // vendor set is the warrant. The one exception is written into the id: Grok's
  // small tier is the `-non-reasoning` variant, and flagging it as reasoning-
  // capable offers effort variants a non-reasoning model cannot honour.
  const entry: OpencodeModelEntry = { name: model, reasoning: !isNonReasoningGrokModel(model) };

  const window = contextWindowForModel(family, model);
  if (!mayDriveRetirement(window) || window.tokens <= 0) {
    logger.warn(
      { model, family, windowSource: window.source },
      'opencode_model_window_unknown: no recorded context window; leaving the limit to opencode',
    );
    return entry;
  }
  return { ...entry, limit: { context: window.tokens, output: OPENCODE_OUTPUT_RESERVE_TOKENS } };
}
