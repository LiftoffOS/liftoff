// The @coinbase/cdp-sdk x402 subpath declares its @x402/* companions as
// OPTIONAL peer dependencies while its barrel imports three of them
// unconditionally (@x402/extensions, @x402/svm, @x402/express, dragged in
// eagerly through the client/server modules). npm installs none of them on
// its own, so a tree that typechecks and passes every mocked test can still
// produce an image whose first real payment attempt dies with
// ERR_MODULE_NOT_FOUND. Only importing the real module can see that, and it
// must happen in an ESM process because that is what production runs — a
// CJS require would exercise the _cjs build instead.

import { execFileSync } from 'child_process';

describe('@coinbase/cdp-sdk/x402 loads with its full peer set', () => {
  it('imports in a real ESM process and exposes the signer factory', () => {
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const m = await import('@coinbase/cdp-sdk/x402');
         if (typeof m.fromCdpEvmAccount !== 'function') throw new Error('fromCdpEvmAccount missing');
         console.log('ok');`,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    expect(out.trim()).toBe('ok');
  });
});
