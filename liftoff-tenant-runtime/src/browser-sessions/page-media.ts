// The files a page is showing, for a reader that only gets words.
//
// A <video> contributes no text. So a generator page that has just finished
// reads, to everything downstream, as "Your video is ready" and a button
// marked "Generate again" — and a model given that does the only thing the
// page appears to offer, which is to wait, or to generate it again. The clip
// the whole task existed to produce is not in the observation at all.
//
// The player's own download control is not an alternative: Chromium renders it
// in a closed user-agent shadow root, where page script cannot reach it. The
// address is the only handle there is.
//
// Two readers need this and they read the page by different routes — the loop
// through its own snapshot, the assistants through each vendor's text
// extraction — so the formatting lives here and both use it, rather than
// telling a model two different things about one page.

import type { Page } from 'playwright-core';

export interface PageMediaFile {
  kind: string;
  src: string;
  name: string;
}

/** How many to name. A gallery page has hundreds and none of them is the
 *  point; a generator has one. */
const MAX_FILES = 10;
const MAX_SRC_CHARS = 2000;

/**
 * The playable files on the page, by the address each can be fetched from.
 *
 * `currentSrc` first, because that is the address the browser actually
 * resolved and it is the one that works — for a file the page built, it is the
 * `blob:` the element was handed rather than anything on a server.
 */
export async function listPageMedia(page: Page): Promise<PageMediaFile[]> {
  try {
    // Written against the page's own globals, which this process does not
    // have types for: the DOM lives in the browser, not here.
    return await page.evaluate<PageMediaFile[], { max: number; cap: number }>(
       
      ({ max, cap }: { max: number; cap: number }) => {
        const out: { kind: string; src: string; name: string }[] = [];
        const els: any[] = Array.from((globalThis as any).document.querySelectorAll('video,audio'));
        for (const el of els) {
          if (out.length >= max) break;
          const source = el.querySelector('source');
          const src = el.currentSrc || el.getAttribute('src') || (source && source.src) || '';
          if (!src) continue;
          out.push({
            kind: String(el.tagName).toLowerCase(),
            src: String(src).slice(0, cap),
            name: el.getAttribute('title') || el.getAttribute('aria-label') || '',
          });
        }
        return out;
      },
      { max: MAX_FILES, cap: MAX_SRC_CHARS },
    );
  } catch {
    // A page mid-navigation. The reading is still worth having without it.
    return [];
  }
}

/**
 * The files, as a reader is told about them. Empty when there are none, so a
 * caller can append it unconditionally.
 *
 * It says what to DO with an address, because naming a file without saying it
 * can be delivered is how a model ends up describing a video it was holding.
 */
export function filesBlock(files: readonly PageMediaFile[]): string {
  const named = files.filter((f) => f.src);
  if (named.length === 0) return '';
  const lines = named.map((f) => `${f.kind}${f.name ? ` "${f.name}"` : ''}: ${f.src}`);
  return `\n\nFiles on this page (fetch one by its address to deliver it):\n${lines.join('\n')}`;
}
