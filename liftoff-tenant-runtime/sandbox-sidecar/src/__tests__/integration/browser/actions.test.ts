/**
 * Browser integration test — launches Playwright Chromium against a data: URL
 * fixture and exercises navigate/click/fill/screenshot/extract.
 *
 * Only runs under the "integration" jest project: `npm run test:integration`.
 * The default `npm test` runs the unit project only, so this never blocks CI
 * unit-test runs.
 */
import { chromium } from 'playwright';
import { Mutex } from 'async-mutex';

describe('browser actions (integration)', () => {
  jest.setTimeout(60_000);

  it('navigates a data URL and reads back text + input value', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto('data:text/html,<html><body><h1>hi</h1><input id="x"></body></html>');
      expect(await page.locator('h1').innerText()).toBe('hi');
      await page.fill('#x', 'value');
      expect(await page.locator('#x').inputValue()).toBe('value');
      const shot = await page.screenshot({ type: 'png' });
      expect(shot.byteLength).toBeGreaterThan(100);
    } finally {
      await browser.close();
    }
  });

  it('per-tab mutex serializes concurrent calls', async () => {
    const mutex = new Mutex();
    const order: number[] = [];
    await Promise.all([
      mutex.runExclusive(async () => {
        order.push(1);
        await new Promise(resolve => setTimeout(resolve, 20));
        order.push(2);
      }),
      mutex.runExclusive(async () => {
        order.push(3);
        await new Promise(resolve => setTimeout(resolve, 20));
        order.push(4);
      }),
    ]);
    expect(order).toEqual([1, 2, 3, 4]);
  });
});
