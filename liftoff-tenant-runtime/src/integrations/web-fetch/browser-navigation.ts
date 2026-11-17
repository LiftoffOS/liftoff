// A headless browser's answer for the page it navigated to.
//
// Four fetch clients drive a browser over CDP (Steel, Browser Use,
// Browserbase, Anchor's session path). Their statement about a page is the
// ORIGIN's own status on the main frame's navigation response: a client
// status is the origin saying the page is not there to be retrieved, the
// browser's shape for what Exa's empty `/contents` and Perplexity's
// `no_result_returned` say. Left to Playwright, that answer is lost twice
// over: an error status with a body comes back as the site's error page
// handed over as content, and an error status with an empty body fails the
// navigation outright with `net::ERR_HTTP_RESPONSE_CODE_FAILURE`, which
// names no status at all. So the status is read off the response event,
// kept beside `goto`'s own return for the empty-body case, and raised as one
// shared class for every browser vendor. A server status is the origin
// being down, not the page absent: the page is returned or the navigation
// error stands, as before.

import type { Page, Response } from 'playwright-core';

/** The origin answered a client status for the page: the browsers' shared
 *  empty-answer shape, which the miss classifier reads for any vendor. */
export class OriginAnsweredForPage extends Error {
  constructor(public readonly originStatus: number) {
    super(`the origin answered ${originStatus} for the page`);
    this.name = 'OriginAnsweredForPage';
  }
}

function isClientStatus(status: number): boolean {
  return status >= 400 && status < 500;
}

/** Navigate for a headless fetch. Resolves once the page is there to read;
 *  throws `OriginAnsweredForPage` when the origin answered a client status
 *  for it, and Playwright's own error otherwise. */
export async function navigateForFetch(page: Page, url: string, timeoutMs: number): Promise<void> {
  let originStatus = null as number | null;
  const onResponse = (response: Response) => {
    const request = response.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) originStatus = response.status();
  };
  page.on('response', onResponse);
  try {
    let navigation: Response | null;
    try {
      navigation = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    } catch (err) {
      if (originStatus !== null && isClientStatus(originStatus)) throw new OriginAnsweredForPage(originStatus);
      throw err;
    }
    const answered = navigation?.status() ?? originStatus;
    if (answered !== null && isClientStatus(answered)) throw new OriginAnsweredForPage(answered);
  } finally {
    page.off('response', onResponse);
  }
}
