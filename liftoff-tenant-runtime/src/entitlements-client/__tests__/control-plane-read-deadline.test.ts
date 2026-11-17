// The control-plane reads end, body included, when the control plane stops
// answering.
//
// These sit on the run's admission path. The entitlement fetch cleared its
// abort timer BEFORE `await response.json()`, so a body that never finished
// was waited for forever; the deployment and migration-state reads had no
// timer at all. Each answers null on failure, so a timeout degrades exactly as
// an unreachable control plane always has. Driven over real sockets.

import http from 'http';
import type { AddressInfo } from 'net';
import { waitForNoHeldRequests } from '../../test-utils/wait-for';

jest.mock('../../infrastructure/database');
jest.mock('../../infrastructure/logging');

type Mode = 'no-headers' | 'no-body-end';

async function hangingControlPlane(mode: Mode) {
  let open = 0;
  const server = http.createServer((_req, res) => {
    open += 1;
    res.on('close', () => { open -= 1; });
    if (mode === 'no-body-end') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"tenantOperationalStatus":');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    open: () => open,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

describe('control-plane reads are bounded', () => {
  const prevUrl = process.env.CONTROL_PLANE_API_URL;
  afterAll(() => {
    if (prevUrl === undefined) delete process.env.CONTROL_PLANE_API_URL;
    else process.env.CONTROL_PLANE_API_URL = prevUrl;
  });

  // The base URL is read at module load, so each case loads the module fresh
  // against its own server.
  async function clientFor(url: string) {
    process.env.CONTROL_PLANE_API_URL = url;
    let mod!: typeof import('../service');
    jest.isolateModules(() => { mod = require('../service'); });
    return new mod.EntitlementsClient() as unknown as {
      fetchEntitlementFromControlPlane(_t: string): Promise<unknown>;
      fetchDeploymentFromControlPlane(_t: string): Promise<unknown>;
      getMigrationState(_t: string): Promise<unknown>;
    };
  }

  const cases: Array<[string, Mode, (_c: Awaited<ReturnType<typeof clientFor>>) => Promise<unknown>]> = [
    ['entitlement, body never finishes (the cleared-timer bug)', 'no-body-end', (c) => c.fetchEntitlementFromControlPlane('t1')],
    ['entitlement, no answer', 'no-headers', (c) => c.fetchEntitlementFromControlPlane('t1')],
    ['deployment, no answer', 'no-headers', (c) => c.fetchDeploymentFromControlPlane('t1')],
    ['migration state, no answer', 'no-headers', (c) => c.getMigrationState('t1')],
  ];

  // Concurrently, so the suite pays the 5s once rather than four times.
  it('each read answers null within 5s and releases its socket', async () => {
    const outcomes = await Promise.all(cases.map(async ([label, mode, read]) => {
      const cp = await hangingControlPlane(mode);
      try {
        const client = await clientFor(cp.url);
        const startedAt = Date.now();
        const value = await read(client);
        const elapsed = Date.now() - startedAt;
        // WAIT FOR THE SOCKET TO BE RELEASED, do not guess how long that takes.
        // A fixed 50ms sleep here read a count that had not settled on a loaded
        // machine, and this test failed three runs in four for that reason
        // alone. A client that genuinely leaked its socket never settles, so
        // the bound below expires and the test still fails — for the defect it
        // was written to catch rather than for the scheduler.
        await waitForNoHeldRequests(cp.open, `control plane (${label})`);
        return { label, value, bounded: elapsed >= 4_900 && elapsed < 7_000, open: cp.open() };
      } finally {
        await cp.close();
      }
    }));
    expect(outcomes).toEqual(cases.map(([label]) => ({ label, value: null, bounded: true, open: 0 })));
  }, 15_000);
});
