// INV-PB-013, connector-service half: an executor that PAYS through the x402
// transport must surface what it paid. makeX402Transport moves real USDC per
// call; an executor that adopts it without reading the receipt into costUsd
// produces payments no ledger anywhere will ever see — the exact "vendor path
// with no usage record" the invariant forbids, in its most literal form
// (money, not tokens).
//
// Structural on purpose, like no-direct-fetch.test.ts: it enumerates the
// CALLERS from source, so the ratchet binds at the moment a vendor lands.
// The sibling halves live in tenant-runtime (tool-gateway/x402-usage.ts,
// enumerated over X402_FUNDED_CONNECTORS — a new x402 vendor here must join
// that set) and platform-backend (the usage-ledger ingester's x402 branch).

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const CLIENTS_DIR = join(__dirname, '..', '..', 'clients');

function x402TransportCallers(): Array<{ file: string; source: string }> {
  return readdirSync(CLIENTS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({ file: f, source: readFileSync(join(CLIENTS_DIR, f), 'utf8') }))
    .filter(({ file, source }) =>
      file !== 'connector-transport.ts' && source.includes('makeX402Transport('));
}

describe('every x402-paying executor surfaces its cost (INV-PB-013)', () => {
  const callers = x402TransportCallers();

  it('finds at least one x402 executor, so this cannot pass vacuously', () => {
    expect(callers.map((c) => c.file)).toContain('gloria-mcp.ts');
  });

  it.each(callers.map((c) => [c.file, c.source] as const))(
    '%s reads the payment receipt into costUsd',
    (_file, source) => {
      expect(source).toContain('readX402Receipt');
      expect(source).toContain('costUsd');
    },
  );
});
