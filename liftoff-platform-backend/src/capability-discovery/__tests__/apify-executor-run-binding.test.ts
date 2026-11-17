// The cost booked for an actor run is the cost of THAT run, read by its id.
//
// The platform account is shared by every environment and every tenant, so a
// second run of the same actor starting seconds after the first is ordinary,
// and "the actor's most recent run" is then the wrong run. This suite pins the
// protocol: start → wait on the id → items by the id → cost by the id, and
// never a listing of the actor's runs.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { log } from '../../infrastructure/logging';
import { runApifyActor } from '../apify-executor';

type Route = (url: string, init?: RequestInit) => { status: number; body: unknown } | undefined;

/** A fetch that answers by URL and method, recording every call. */
function scriptedFetch(route: Route): jest.Mock & { calls: Array<{ url: string; method: string }> } {
  const calls: Array<{ url: string; method: string }> = [];
  const fn = jest.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    const answer = route(url, init);
    if (!answer) throw new Error(`unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => answer.body,
      text: async () => JSON.stringify(answer.body),
    };
  }) as jest.Mock & { calls: Array<{ url: string; method: string }> };
  fn.calls = calls;
  return fn;
}

const realFetch = global.fetch;
const savedToken = process.env.APIFY_PLATFORM_TOKEN;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.APIFY_PLATFORM_TOKEN = 'apify_api_test';
});

afterEach(() => {
  global.fetch = realFetch;
  if (savedToken === undefined) delete process.env.APIFY_PLATFORM_TOKEN;
  else process.env.APIFY_PLATFORM_TOKEN = savedToken;
});

const ACTOR = 'clearpath/reddit-subreddit-posts-scraper';
const START = '/acts/clearpath~reddit-subreddit-posts-scraper/runs?';

describe('runApifyActor binds items and cost to the run it started', () => {
  it('books the cost of the run whose id the start call returned, and never lists the actor’s runs', async () => {
    // Another run of the same actor exists in the account, started later and
    // cheaper. Under the old "most recent run" read it would have been booked.
    const fetchMock = scriptedFetch((url, init) => {
      if (url.includes(START) && init?.method === 'POST') {
        return { status: 201, body: { data: { id: 'run-real', status: 'RUNNING' } } };
      }
      if (url.includes('/actor-runs/run-real?waitForFinish=')) {
        return { status: 200, body: { data: { id: 'run-real', status: 'SUCCEEDED', usageTotalUsd: 0.0305 } } };
      }
      if (url.includes('/actor-runs/run-real/dataset/items')) {
        return { status: 200, body: [{ title: 'a' }, { title: 'b' }] };
      }
      if (url.endsWith('/actor-runs/run-real')) {
        return { status: 200, body: { data: { id: 'run-real', status: 'SUCCEEDED', usageTotalUsd: 0.0305 } } };
      }
      if (url.includes('/runs?limit=1')) {
        return { status: 200, body: { data: { items: [{ id: 'run-other', usageTotalUsd: 0.0005 }] } } };
      }
      return undefined;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const run = await runApifyActor(ACTOR, { subreddit: 'explainlikeimfive', maxPostsPerSubreddit: 15 });

    expect(run).toEqual({ success: true, items: [{ title: 'a' }, { title: 'b' }], costUsd: 0.0305, runId: 'run-real', fundingSource: 'platform_key' });
    expect(fetchMock.calls.some((c) => c.url.includes('/runs?limit=1'))).toBe(false);
    // The start call carries the input and the run limits.
    const start = fetchMock.calls.find((c) => c.method === 'POST');
    expect(start?.url).toContain('timeout=90');
    expect(start?.url).toContain('memory=1024');
    expect(start?.url).toContain('waitForFinish=60');
    // Items are read by the run id, with the same item limit as before.
    expect(fetchMock.calls.some((c) => c.url.includes('/actor-runs/run-real/dataset/items?limit=100'))).toBe(true);
  });

  it('polls the run by id until it is terminal', async () => {
    let polls = 0;
    const fetchMock = scriptedFetch((url, init) => {
      if (url.includes(START) && init?.method === 'POST') {
        return { status: 201, body: { data: { id: 'run-slow', status: 'READY' } } };
      }
      if (url.includes('/actor-runs/run-slow?waitForFinish=')) {
        polls += 1;
        return polls < 3
          ? { status: 200, body: { data: { id: 'run-slow', status: 'RUNNING' } } }
          : { status: 200, body: { data: { id: 'run-slow', status: 'SUCCEEDED', usageTotalUsd: 0.01 } } };
      }
      if (url.includes('/actor-runs/run-slow/dataset/items')) return { status: 200, body: [{ x: 1 }] };
      if (url.endsWith('/actor-runs/run-slow')) return { status: 200, body: { data: { id: 'run-slow', usageTotalUsd: 0.01 } } };
      return undefined;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const run = await runApifyActor(ACTOR, {});
    expect(run.success).toBe(true);
    expect(run.runId).toBe('run-slow');
    expect(polls).toBe(3);
  });

  it('reads the cost fresh after the run is terminal and records a figure that moved', async () => {
    const fetchMock = scriptedFetch((url, init) => {
      if (url.includes(START) && init?.method === 'POST') {
        // Finished within the start call's wait, carrying an early figure.
        return { status: 201, body: { data: { id: 'run-fast', status: 'SUCCEEDED', usageTotalUsd: 0.0005 } } };
      }
      if (url.includes('/actor-runs/run-fast/dataset/items')) return { status: 200, body: [{ x: 1 }] };
      if (url.endsWith('/actor-runs/run-fast')) return { status: 200, body: { data: { id: 'run-fast', usageTotalUsd: 0.0305 } } };
      return undefined;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const run = await runApifyActor(ACTOR, {});
    expect(run.costUsd).toBe(0.0305);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'apify_run_cost_settled_late', runId: 'run-fast', carriedUsd: 0.0005, settledUsd: 0.0305 }),
      expect.any(String),
    );
  });

  it('reports a run that did not succeed as a failure carrying the run id, and books nothing', async () => {
    const fetchMock = scriptedFetch((url, init) => {
      if (url.includes(START) && init?.method === 'POST') {
        return { status: 201, body: { data: { id: 'run-bad', status: 'RUNNING' } } };
      }
      if (url.includes('/actor-runs/run-bad?waitForFinish=')) {
        return { status: 200, body: { data: { id: 'run-bad', status: 'FAILED', statusMessage: 'Actor crashed' } } };
      }
      return undefined;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const run = await runApifyActor(ACTOR, {});
    // A run that started and failed may have been charged for, so the result
    // says not to start another paid source from this call.
    expect(run).toEqual({ success: false, error: 'the source returned an error (run FAILED): Actor crashed', runId: 'run-bad', autoFailoverSafe: false, fundingSource: 'platform_key' });
    expect(fetchMock.calls.some((c) => c.url.includes('/dataset/items'))).toBe(false);
  });

  it('reports a run Apify timed out as a timeout', async () => {
    global.fetch = scriptedFetch((url, init) => {
      if (url.includes(START) && init?.method === 'POST') {
        return { status: 201, body: { data: { id: 'run-late', status: 'TIMED-OUT' } } };
      }
      return undefined;
    }) as unknown as typeof fetch;

    await expect(runApifyActor(ACTOR, {})).resolves.toEqual({ success: false, error: 'the source timed out', runId: 'run-late', autoFailoverSafe: false, fundingSource: 'platform_key' });
  });

  it('still refuses an input the source rejected at the start call, as an argument rejection', async () => {
    global.fetch = scriptedFetch((url, init) => {
      if (url.includes(START) && init?.method === 'POST') {
        return { status: 400, body: { error: { type: 'invalid-input', message: 'Field input.subreddit is required' } } };
      }
      return undefined;
    }) as unknown as typeof fetch;

    await expect(runApifyActor(ACTOR, {})).resolves.toEqual({
      success: false,
      argumentsRejected: true,
      error: 'Field input.subreddit is required',
    });
  });

  it('books nothing when the run reports no cost, and says so', async () => {
    global.fetch = scriptedFetch((url, init) => {
      if (url.includes(START) && init?.method === 'POST') {
        return { status: 201, body: { data: { id: 'run-free', status: 'SUCCEEDED', usageTotalUsd: 0 } } };
      }
      if (url.includes('/actor-runs/run-free/dataset/items')) return { status: 200, body: [] };
      if (url.endsWith('/actor-runs/run-free')) return { status: 200, body: { data: { id: 'run-free', usageTotalUsd: 0 } } };
      return undefined;
    }) as unknown as typeof fetch;

    const run = await runApifyActor(ACTOR, {});
    expect(run).toEqual({ success: true, items: [], costUsd: undefined, runId: 'run-free', fundingSource: 'platform_key' });
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-free' }), expect.stringContaining('no cost'));
  });
});
