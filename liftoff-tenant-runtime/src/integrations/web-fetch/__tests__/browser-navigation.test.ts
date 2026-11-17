// A headless fetch's answer for a page is the ORIGIN's status on the main
// frame's navigation response: a client status is the page not being there
// to retrieve, raised as one shape for every browser vendor; a server status
// or Chromium's own error stands as before. The status is read off the
// response event as well as `goto`'s return, because Chromium fails an
// error status with an empty body outright and `goto` then returns nothing.

import type { Page, Response } from 'playwright-core';
import { navigateForFetch, OriginAnsweredForPage } from '../browser-navigation';

const mainFrame = { name: 'main' };

function response(status: number, navigation = true): Response {
  return {
    status: () => status,
    request: () => ({
      isNavigationRequest: () => navigation,
      frame: () => (navigation ? mainFrame : { name: 'iframe' }),
    }),
  } as unknown as Response;
}

/** A page whose navigation the test scripts: `goto` may emit response events
 *  first, then resolve with a response, resolve with nothing, or throw. */
function fakePage(goto: (emit: (r: Response) => void) => Promise<Response | null>) {
  const listeners = new Set<(r: Response) => void>();
  const page = {
    mainFrame: () => mainFrame,
    on: jest.fn((event: string, cb: (r: Response) => void) => { if (event === 'response') listeners.add(cb); }),
    off: jest.fn((event: string, cb: (r: Response) => void) => { if (event === 'response') listeners.delete(cb); }),
    goto: jest.fn((url: string, opts: unknown) => {
      void url; void opts;
      return goto((r) => { for (const cb of listeners) cb(r); });
    }),
  };
  return { page: page as unknown as Page, listeners, spies: page };
}

describe('navigateForFetch', () => {
  it('resolves on a page the origin served, and stops listening afterwards', async () => {
    const { page, listeners, spies } = fakePage(async () => response(200));

    await expect(navigateForFetch(page, 'https://x.test/page', 1_000)).resolves.toBeUndefined();

    expect(spies.goto).toHaveBeenCalledWith('https://x.test/page', { waitUntil: 'domcontentloaded', timeout: 1_000 });
    expect(spies.off).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  it("raises the origin's client status instead of handing the site's error page over", async () => {
    const { page } = fakePage(async () => response(404));

    await expect(navigateForFetch(page, 'https://x.test/gone', 1_000)).rejects.toMatchObject({
      name: 'OriginAnsweredForPage', originStatus: 404, message: 'the origin answered 404 for the page',
    });
  });

  it('reads the status off the response event when Chromium fails an empty error body outright', async () => {
    const { page, listeners } = fakePage(async (emit) => {
      emit(response(410));
      throw new Error('page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at https://x.test/gone');
    });

    const err = await navigateForFetch(page, 'https://x.test/gone', 1_000).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OriginAnsweredForPage);
    expect((err as OriginAnsweredForPage).originStatus).toBe(410);
    expect(listeners.size).toBe(0);
  });

  it("keeps Chromium's own error when no navigation response was seen", async () => {
    const chromiums = new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://x.test/page');
    const { page } = fakePage(async () => { throw chromiums; });

    await expect(navigateForFetch(page, 'https://x.test/page', 1_000)).rejects.toBe(chromiums);
  });

  it('never lets a sub-resource or another frame speak for the page', async () => {
    const { page } = fakePage(async (emit) => {
      emit(response(404, false));
      emit(response(403, false));
      return response(200);
    });

    await expect(navigateForFetch(page, 'https://x.test/page', 1_000)).resolves.toBeUndefined();
  });

  it('follows a redirect to what the origin finally answered', async () => {
    const { page } = fakePage(async (emit) => {
      emit(response(301));
      emit(response(200));
      return response(200);
    });

    await expect(navigateForFetch(page, 'https://x.test/old', 1_000)).resolves.toBeUndefined();
  });

  it('returns a page served under a server status as before: the origin is down, not the page absent', async () => {
    const { page } = fakePage(async () => response(503));

    await expect(navigateForFetch(page, 'https://x.test/page', 1_000)).resolves.toBeUndefined();
  });

  it('reads nothing into a navigation that returned no response', async () => {
    const { page } = fakePage(async () => null);

    await expect(navigateForFetch(page, 'about:blank', 1_000)).resolves.toBeUndefined();
  });
});
