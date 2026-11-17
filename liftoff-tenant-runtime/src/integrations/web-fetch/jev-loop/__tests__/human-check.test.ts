// A wall only a person can pass, told apart from a page that merely mentions one.
//
// Until this existed a challenge page read as "a page with nothing useful on
// it", which is `blocked` — and blocked hands the rest of the task to another
// model driving the same page. It cannot pass the challenge either, so the task
// spent its whole clock on something that was never going to work and the
// person was told it had run out of time.
//
// The false-positive half matters as much as the detection: stopping a task
// that could have carried on, because a page used the word robot, is its own
// failure.

jest.mock('../../../../infrastructure/logging', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { looksLikeHumanCheck } from '../human-check';

/** A page whose markup answers a selector query, and nothing else. */
function pageWith(selectorsPresent: string[]) {
  return {
    evaluate: async (_fn: unknown, selectors: string[]) =>
      selectors.some((s) => selectorsPresent.includes(s)),
  } as unknown as import('playwright-core').Page;
}
const barePage = pageWith([]);

describe('a human-verification wall', () => {
  it.each([
    ['a reCAPTCHA frame', ['iframe[src*="recaptcha"]']],
    ['an hCaptcha container', ['div.h-captcha']],
    ['a Cloudflare challenge', ['iframe[src*="challenges.cloudflare.com"]']],
    ['a Turnstile widget', ['div.cf-turnstile']],
    ['a challenge form', ['#challenge-form']],
  ])('is recognised from %s, whatever the page says', async (_name, present) => {
    expect(await looksLikeHumanCheck(pageWith(present as string[]), 'Welcome to our site')).toBe(true);
  });

  it.each([
    'Please verify you are human to continue',
    'Select all images with a traffic light',
    "I'm not a robot",
    'We have detected unusual traffic from your computer network',
    'Checking if the site connection is secure',
  ])('is recognised from the challenge\'s own words: %s', async (text) => {
    expect(await looksLikeHumanCheck(barePage, text)).toBe(true);
  });

  // The other half of the claim. A task stopped because a page discussed bots
  // is a task stopped for nothing.
  it.each([
    'Our robot vacuum reviews: the ten best models',
    'Human resources: verify your details before Friday',
    'This image selection tool lets you pick all images at once',
    'Security check-in for visitors is at the front desk',
  ])('is NOT claimed for a page that merely mentions one: %s', async (text) => {
    expect(await looksLikeHumanCheck(barePage, text)).toBe(false);
  });

  it('says nothing either way about a page it cannot read', async () => {
    const gone = {
      evaluate: async () => { throw new Error('Execution context was destroyed'); },
    } as unknown as import('playwright-core').Page;
    expect(await looksLikeHumanCheck(gone, 'anything at all')).toBe(false);
  });
});
