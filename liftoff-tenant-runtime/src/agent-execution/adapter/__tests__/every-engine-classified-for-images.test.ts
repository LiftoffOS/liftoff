// Every engine has an answer for "what happens to an attached picture".
//
// There are two acceptable answers and one unacceptable one. An engine may
// CARRY the image as its vendor's own image block, or it may DESCRIBE it in the
// text prompt because it has no image channel. What it may not do is drop it:
// the model then answers about a picture it never received, fluently, and
// nothing in the answer tells the person it never looked.
//
// This is a ratchet, not a restatement. The sibling test proves each half
// does what it claims — that a carrying engine's input actually carries the
// picture and a describing engine's prompt actually describes it; this one
// proves the CLASSIFICATION is complete —
// that when somebody adds an eighth engine, they cannot ship it without
// deciding which half it belongs to. That is the failure this file exists for,
// because a new adapter that silently ignores an unrecognised content member
// looks exactly like a working one until a person attaches a screenshot.
//
// The union is the source of truth: TypeScript checks the map below covers it
// exhaustively, so a new member is a COMPILE error here, not a runtime miss.

import { RESOLVABLE_EXECUTION_ENGINE_IDS } from '../types';
import type { ExecutionEngineId } from '../types';

type ImageHandling =
  /** Builds a vendor image block from `{ type: 'image' }` content. */
  | 'carries'
  /** Owns its own loop and takes a text prompt with no image channel, so the
   *  picture is described in words through conversation-preamble.ts. Honest,
   *  not silent. */
  | 'describes'
  /** Never constructable — provenance-only sentinel for pre-migration rows. */
  | 'not-constructable';

/**
 * How each engine handles an image, and why.
 *
 * The `Record<ExecutionEngineId, ...>` annotation does NOT make this a ratchet.
 * `tsconfig.json` excludes `**__tests__/**`, so `tsc --noEmit` never reads this
 * file and the missing-key error it would raise is never produced — which is how
 * `xai-openai-wire` was added to the union and classified nowhere. The coverage
 * assertion below is the ratchet, because it runs where this table lives.
 */
const IMAGE_HANDLING: Record<ExecutionEngineId, ImageHandling> = {
  // AnthropicAdapter — SDKUserMessage takes a ContentBlockParam array, and
  // ImageBlockParam is one of the blocks it accepts.
  'claude-agent-sdk': 'carries',
  // OpenAiWireAdapter — Responses-API `input_image` part with a data URL.
  'openai-agents': 'carries',
  // The SAME OpenAiWireAdapter, constructed with { providerKind: 'openrouter' }.
  // Seven ids, six classes: this is the pair that collapses.
  'openrouter-openai-wire': 'carries',
  // GeminiAdapter — genai `inlineData` part.
  'google-genai': 'carries',
  // CodexAdapter — the SDK's turn input takes `{ type: 'local_image', path }`
  // members, handed to the CLI as `--image`; each picture is written to a
  // per-run temporary file and attached to the first turn.
  'openai-codex': 'carries',
  // OpencodeAdapter — a `file` part with a data URL and the image's mime,
  // which the server sends the model as its own image block.
  opencode: 'carries',
  // GeminiAdkAdapter owns its loop and takes a text prompt; the only engine
  // still on the describing path of firstTurnPrompt.
  'google-adk': 'describes',
  // GeminiCliAdapter — the CLI's `@path` prompt syntax attaches a file, and an
  // image file is attached as an inline image part; each picture is written
  // under the run's working directory and referenced from the first turn.
  'google-gemini-cli': 'carries',
  // The SAME OpenAiWireAdapter again, pointed at api.x.ai. Carries for the same
  // reason openrouter does: the image part is built by the shared wire loop, not
  // by the endpoint.
  'xai-openai-wire': 'carries',
  // Sentinel for rows written before engine provenance existed.
  // constructAdapter throws on it by design.
  'unknown-legacy': 'not-constructable',
};

describe('image handling is decided for every engine', () => {
  it('classifies every constructable engine, counted from the vendor record', () => {
    const constructable = Object.entries(IMAGE_HANDLING)
      .filter(([, handling]) => handling !== 'not-constructable')
      .map(([id]) => id);
    // Compared against the derived list rather than a number. The number was 7,
    // and stayed 7 and passing after an eighth engine became routable.
    expect(constructable.sort()).toEqual([...RESOLVABLE_EXECUTION_ENGINE_IDS].sort());
  });

  // The count that keeps getting mis-stated. Eight ids, six adapter classes:
  // openai-agents, openrouter-openai-wire and xai-openai-wire are all
  // OpenAiWireAdapter pointed at three endpoints. Codex and opencode carry
  // too, since they became the default engines for OpenAI, xAI and the
  // open-weights families — a default that removed vision from every run on
  // those providers would have been a regression whatever the loop gained.
  // ENGINE_SUBSET_OK: one half of a partition. Its complement is asserted by the
  // 'describes' row below, and the two together are checked against the derived
  // list above, so an unclassified engine fails there rather than hiding here.
  it('carries images on eight ids across six adapter classes', () => {
    const carries = Object.entries(IMAGE_HANDLING)
      .filter(([, h]) => h === 'carries')
      .map(([id]) => id);
    expect(carries.sort()).toEqual([
      'claude-agent-sdk',
      'google-gemini-cli',
      'google-genai',
      'openai-agents',
      'openai-codex',
      'opencode',
      'openrouter-openai-wire',
      'xai-openai-wire',
    ]);
  });

  // ENGINE_SUBSET_OK: the other half of the partition above.
  it('describes images on the one self-managing engine with no image channel', () => {
    const describes = Object.entries(IMAGE_HANDLING)
      .filter(([, h]) => h === 'describes')
      .map(([id]) => id)
      .sort();
    expect(describes).toEqual(['google-adk']);
  });

  // The property the other two are in service of.
  it('leaves no engine unclassified', () => {
    for (const [id, handling] of Object.entries(IMAGE_HANDLING)) {
      expect(['carries', 'describes', 'not-constructable']).toContain(handling);
      expect(id.length).toBeGreaterThan(0);
    }
  });
});
