// A forced round leaves a line to read.
//
// Native forcing is set on the round-0 request and the vendor never echoes
// it back, so nothing in a traced run said whether the round was forced or
// merely grounded by the prefetch — the two produce the same answer built on
// the same bytes, which is the design, and also why the difference is
// invisible without a log line naming the engine, the tool and the invocation.

jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { logger } from '../../../infrastructure/logging';
import {
  forcingDirectiveFor,
  forcingDirectiveForRequest,
  forcibleToolFor,
  ENGINES_WITHOUT_FORCING,
} from '../grounding-forcing';
import { RESOLVABLE_EXECUTION_ENGINE_IDS } from '../types';

const info = logger.info as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe.each(RESOLVABLE_EXECUTION_ENGINE_IDS.map((e) => [e] as const))('%s', (engine) => {
  it('logs exactly when there is a directive, naming engine, tool and invocation', () => {
    const directive = forcingDirectiveForRequest(engine, 'corpus_search', 'inv-42');
    // The wrapper changes nothing about the answer.
    expect(directive).toEqual(forcingDirectiveFor(engine, 'corpus_search'));

    const lines = info.mock.calls.filter((c) => c[0]?.event === 'grounding_forcing_applied');
    if (ENGINES_WITHOUT_FORCING.includes(engine)) {
      // The floor is a complete answer, and not an event.
      expect(directive).toBeNull();
      expect(lines).toHaveLength(0);
    } else {
      expect(directive).not.toBeNull();
      expect(lines).toHaveLength(1);
      expect(lines[0][0]).toMatchObject({
        execution_engine: engine,
        tool_name: 'corpus_search',
        invocation_id: 'inv-42',
        directive_kind: directive!.kind,
      });
    }
  });
});

it('a gated-off model on the wire falls to the floor silently', () => {
  const d = forcingDirectiveForRequest('openrouter-openai-wire', 'corpus_search', 'inv-1', { modelSupportsToolChoice: false });
  expect(d).toBeNull();
  expect(info.mock.calls.filter((c) => c[0]?.event === 'grounding_forcing_applied')).toHaveLength(0);
});

describe('a rule forces only a tool this request declares', () => {
  // A rule is authored per hire and names `corpus_search` whether or not the
  // tenant has a knowledge base; on one that does not, the catalog lacks the
  // tool, and naming it in the directive is a 400 for the whole turn on
  // Gemini. The floor's prefetch already ran; the turn goes on without forcing.
  it('names the tool when the catalog holds it', () => {
    expect(forcibleToolFor('corpus_search', ['search', 'corpus_search', 'note_save'])).toBe('corpus_search');
  });
  it('names nothing when the catalog does not', () => {
    expect(forcibleToolFor('corpus_search', ['search', 'note_save'])).toBeUndefined();
    expect(forcibleToolFor(undefined, ['corpus_search'])).toBeUndefined();
  });
});
