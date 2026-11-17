// Each balance comes back as a figure or as null with the reason, and one
// vendor failing never hides the other's figure.

jest.mock('./locus.js', () => ({ locusBalanceUsd: jest.fn() }));
jest.mock('./vaaya.js', () => ({ vaayaBalanceUsd: jest.fn() }));

import express from 'express';
import request from 'supertest';
import { locusBalanceUsd } from './locus.js';
import { vaayaBalanceUsd } from './vaaya.js';
import { platformVendorBalancesRouter } from './platform-vendor-balances-router.js';

const app = express();
app.use('/api/connectors/platform-vendors', platformVendorBalancesRouter);

it('answers both figures, and a failure on one as null with the reason', async () => {
  (locusBalanceUsd as jest.Mock).mockResolvedValue(23.67);
  (vaayaBalanceUsd as jest.Mock).mockRejectedValue(new Error('vaaya wallet: HTTP 503'));
  const res = await request(app).get('/api/connectors/platform-vendors/balances');
  expect(res.status).toBe(200);
  expect(res.body.locus).toEqual({ usd: 23.67 });
  expect(res.body.vaaya).toEqual({ usd: null, error: 'vaaya wallet: HTTP 503' });
  expect(res.headers['cache-control']).toBe('no-store');
});
