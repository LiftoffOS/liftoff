import { browserContextRegistry } from './context';
import type { BrowserCaptchaType } from '@liftoffos/sandbox-contracts';

const CAPTCHA_SELECTORS: Record<BrowserCaptchaType, string[]> = {
  recaptcha: [
    'iframe[src*="recaptcha"]',
    'iframe[src*="google.com/recaptcha"]',
    '.g-recaptcha',
    '#recaptcha-anchor',
  ],
  hcaptcha: [
    'iframe[src*="hcaptcha.com"]',
    '.h-captcha',
    'iframe[title*="hCaptcha"]',
  ],
  cloudflare: [
    '#cf-challenge-stage',
    '#cf-please-wait',
    '.cf-browser-verification',
    'iframe[src*="challenges.cloudflare.com"]',
  ],
  turnstile: [
    'iframe[src*="challenges.cloudflare.com/turnstile"]',
    '.cf-turnstile',
  ],
};

export async function detectCaptcha(tabId: string): Promise<{ detected: boolean; type?: BrowserCaptchaType; selector?: string }> {
  return browserContextRegistry.withPageLock(tabId, async page => {
    for (const [type, selectors] of Object.entries(CAPTCHA_SELECTORS) as Array<[BrowserCaptchaType, string[]]>) {
      for (const sel of selectors) {
        const exists = await page.$(sel).then(el => !!el);
        if (exists) return { detected: true, type, selector: sel };
      }
    }
    return { detected: false };
  });
}

export async function waitForCaptchaSolve(tabId: string, timeoutMs = 120_000): Promise<{ solved: boolean; durationMs: number }> {
  const start = Date.now();
  const detection = await detectCaptcha(tabId);
  if (!detection.detected || !detection.selector) return { solved: true, durationMs: 0 };
  try {
    await browserContextRegistry.withPageLock(tabId, async page => {
      await page.waitForFunction(
        (sel: string) => !document.querySelector(sel),
        detection.selector!,
        { timeout: timeoutMs, polling: 1000 },
      );
    });
    return { solved: true, durationMs: Date.now() - start };
  } catch {
    return { solved: false, durationMs: Date.now() - start };
  }
}
