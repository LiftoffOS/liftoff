// A wall only a person can pass.
//
// A CAPTCHA, an "are you human" interstitial, an anti-bot challenge: the loop
// has no business attempting any of them, and until this existed it did not
// know they were different from anything else. A challenge page reads as a page
// with nothing useful on it, which is `blocked` — and `blocked` hands the rest
// of the task to another model driving the same page, which cannot pass it
// either. So the task spent its whole clock on something that was never going
// to work, and the person was told it had run out of time.
//
// Named, it stops at once and asks the person, in the conversation, in words.
// That is the only move that has ever worked here, and it takes seconds
// instead of minutes.
//
// Deliberately conservative. A false positive stops a task that could have
// carried on, so this looks for the vendors' own markers and for wording that
// only appears on a challenge — not for the word "robot" in a page's prose.

import type { Page } from 'playwright-core';

/** The challenge vendors, by what they put IN the page. Frames and elements
 *  they inject under their own names, which no ordinary page carries. */
const VENDOR_MARKERS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[title*="challenge" i]',
  'div.g-recaptcha',
  'div.h-captcha',
  'div.cf-turnstile',
  '#challenge-form',
  '#captcha',
  '[data-sitekey]',
];

/** Wording that appears on a challenge and effectively nowhere else. Matched
 *  against the page's visible text, lowercased. */
const CHALLENGE_WORDING = [
  'verify you are human',
  'verify that you are human',
  'are you a robot',
  'i am not a robot',
  "i'm not a robot",
  'select all images',
  'complete the security check',
  'security check to access',
  'unusual traffic from your computer',
  'prove you are not a robot',
  'checking if the site connection is secure',
];

/**
 * Whether the page is a human-verification wall.
 *
 * A vendor marker is enough on its own — those elements exist for exactly one
 * purpose. Wording alone is enough too, but only the phrases above, which are
 * the challenge's own words rather than a page discussing one.
 */
export async function looksLikeHumanCheck(page: Page, visibleText: string): Promise<boolean> {
  const text = (visibleText || '').toLowerCase();
  if (CHALLENGE_WORDING.some((phrase) => text.includes(phrase))) return true;
  try {
    return await page.evaluate((selectors: string[]) => {
      const doc = (globalThis as unknown as { document: { querySelector(s: string): unknown } }).document;
      return selectors.some((s) => {
        try { return Boolean(doc.querySelector(s)); } catch { return false; }
      });
    }, VENDOR_MARKERS);
  } catch {
    // A page that cannot be read says nothing either way, and guessing here
    // would stop a task on a navigation.
    return false;
  }
}
