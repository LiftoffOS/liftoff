// The vendor is asked for a vector once per distinct text, not once per call.
//
// There is no prompt cache on an embedding: no vendor offers a prefix cache for
// one and there is no system prompt to mark. What repeats here is the INPUT.
// Both callers of findNearestSkill loop over candidates against the SAME fixed
// list — skill-import walks the imported skills against the merged set, and the
// provenance merge walks the distilled skills against the preserved ones — so a
// redistill with twenty new skills against twenty preserved ones asked the
// vendor for the same twenty vectors twenty times over.
//
// Safe because an embedding is a pure function of provider, model, dimensions,
// task type and text, and all five are in the key. These tests pin the property
// that matters (the same text is never bought twice) and the one that would be
// catastrophic if it broke (a partial batch must still line up positionally with
// its inputs, or every skill is compared against another skill's vector).

const embedMock = jest.fn();
jest.mock('@liftoffos/embedding', () => ({
  embeddingClient: { embed: embedMock },
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  findNearestSkill,
  pairCosine,
  _resetEmbeddingCacheForTesting,
  _embeddingCacheSizeForTesting,
} from '../skill-similarity';

const ATTRIBUTION = { tenantId: 'tenant-1', agentId: 'agent-1' };

/** A deterministic unit vector per text, so a reused vector is provably the
 *  same vector and a mispaired one is provably wrong. */
function vectorFor(text: string): number[] {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) % 3600;
  const theta = (hash / 3600) * 2 * Math.PI;
  return [Math.cos(theta), Math.sin(theta)];
}

function skill(id: string, body: string) {
  return { id, name: id, description: body, instruction: body, tags: [] };
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetEmbeddingCacheForTesting();
  embedMock.mockImplementation(async (req: { input: string[] }) => ({
    embeddings: req.input.map(vectorFor),
    promptTokens: 0,
    model: 'gemini-embedding-001',
    provider: 'google',
  }));
});

/** Every text the vendor was asked for, across all calls, in order. */
function textsRequested(): string[] {
  return embedMock.mock.calls.flatMap((c) => (c[0] as { input: string[] }).input);
}

describe('embedding reuse', () => {
  it('asks the vendor for the existing skills once, not once per candidate', () => {
    // The shape both production callers have. Under the previous behaviour this
    // was 3 candidates x (1 + 3 existing) = 12 vectors bought; it is now 6.
    const existing = [skill('a', 'alpha body'), skill('b', 'beta body'), skill('c', 'gamma body')];
    const candidates = ['one', 'two', 'three'].map((n) => ({
      description: `${n} desc`,
      instruction: `${n} inst`,
    }));

    return (async () => {
      for (const candidate of candidates) {
        await findNearestSkill(candidate, existing, ATTRIBUTION);
      }

      const requested = textsRequested();
      expect(requested).toHaveLength(new Set(requested).size);
      expect(requested).toHaveLength(6);
    })();
  });

  it('pins the model and dimensions the thresholds were calibrated against', () => {
    // The provider was already pinned so a preference change could not
    // invalidate the calibrated thresholds. The MODEL was the half left open:
    // the vendor's own default moving is the same invalidation by another route,
    // and it is also what would make a cached vector stale.
    return (async () => {
      await findNearestSkill(
        { description: 'candidate', instruction: 'candidate' },
        [skill('a', 'alpha body')],
        ATTRIBUTION,
      );

      expect(embedMock).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'google',
          model: 'gemini-embedding-001',
          dimensions: 768,
          taskType: 'retrieval_document',
        }),
      );
    })();
  });

  it('pairs every input with its own vector when only some were missing', () => {
    // The failure mode a partial batch invites: the vendor is handed 1 of 2
    // inputs and its single answer is spliced back at the wrong index, so two
    // unrelated skills read as identical and get merged.
    return (async () => {
      const a = { description: 'alpha', instruction: 'alpha' };
      const b = { description: 'beta', instruction: 'beta' };

      // Warm ONLY `a`, so the next call is a genuine partial batch.
      await pairCosine(a, a, ATTRIBUTION);
      embedMock.mockClear();

      const cosine = await pairCosine(a, b, ATTRIBUTION);

      expect(textsRequested()).toEqual(['beta\nbeta']);
      const [ax, ay] = vectorFor('alpha\nalpha');
      const [bx, by] = vectorFor('beta\nbeta');
      expect(cosine).toBeCloseTo(ax * bx + ay * by, 10);
    })();
  });

  it('asks once for a text repeated inside a single batch', () => {
    return (async () => {
      // Two skills whose bodies happen to be identical are one point in
      // embedding space, and paying twice for it is the same waste in miniature.
      await findNearestSkill(
        { description: 'candidate', instruction: 'candidate' },
        [skill('a', 'same body'), skill('b', 'same body')],
        ATTRIBUTION,
      );

      expect(textsRequested()).toEqual(['candidate\ncandidate', 'same body\nsame body']);
    })();
  });

  it('still fails open when the vendor errors, and caches nothing from a failure', () => {
    return (async () => {
      embedMock.mockRejectedValueOnce(new Error('vendor down'));

      const result = await findNearestSkill(
        { description: 'candidate', instruction: 'candidate' },
        [skill('a', 'alpha body')],
        ATTRIBUTION,
      );

      expect(result).toBeNull();
      expect(_embeddingCacheSizeForTesting()).toBe(0);
    })();
  });

  it('refuses a vendor answer whose length does not match its inputs', () => {
    // Rather than pair skills with vectors belonging to other skills. The
    // caller's fail-open turns this into "no match", which appends — the safe
    // direction, and the same thing a network error already does.
    return (async () => {
      embedMock.mockResolvedValueOnce({
        embeddings: [[1, 0]],
        promptTokens: 0,
        model: 'gemini-embedding-001',
        provider: 'google',
      });

      const result = await findNearestSkill(
        { description: 'candidate', instruction: 'candidate' },
        [skill('a', 'alpha body'), skill('b', 'beta body')],
        ATTRIBUTION,
      );

      expect(result).toBeNull();
    })();
  });

  it('bounds what it holds', () => {
    // A cost cache, not a store. Unbounded growth in a long-lived process is the
    // one way a saving turns into an incident.
    return (async () => {
      for (let i = 0; i < 40; i++) {
        await pairCosine(
          { description: `x${i}`, instruction: `x${i}` },
          { description: `y${i}`, instruction: `y${i}` },
          ATTRIBUTION,
        );
      }

      expect(_embeddingCacheSizeForTesting()).toBe(80);
      expect(_embeddingCacheSizeForTesting()).toBeLessThanOrEqual(2000);
    })();
  });
});
