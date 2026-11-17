// What the platform has left to spend at the aggregators it prepays.
//
// The Locus and Vaaya keys live here, so this is the one place their
// balances can be read; platform-backend's vendor-spend monitor asks once a
// run and raises the operator alert when one is under its floor. Each
// balance is read independently and reported as a figure or an error, never
// as a guess: a vendor that cannot answer is `null` with the reason beside it,
// and the other vendor's figure still comes back.

import { Router, type Request, type Response } from 'express';
import { locusBalanceUsd } from './locus.js';
import { vaayaBalanceUsd } from './vaaya.js';

export const platformVendorBalancesRouter = Router();

export interface PlatformVendorBalance { usd: number | null; error?: string }

async function read(fn: () => Promise<number>): Promise<PlatformVendorBalance> {
  try {
    return { usd: await fn() };
  } catch (err) {
    return { usd: null, error: (err as Error).message };
  }
}

platformVendorBalancesRouter.get('/balances', async (_req: Request, res: Response) => {
  const [locus, vaaya] = await Promise.all([read(locusBalanceUsd), read(vaayaBalanceUsd)]);
  res.set('Cache-Control', 'no-store');
  res.json({ locus, vaaya, readAt: new Date().toISOString() });
});
