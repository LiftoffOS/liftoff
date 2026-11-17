import request from 'supertest';
import express, { type Express } from 'express';
import { verifyServiceAuth } from '@liftoffos/service-client';
import { catalogRouter } from '../router.js';
import { CONNECTORS, CATEGORY_DISPLAY_LABELS, computeCatalogVersion } from '../connectors.js';

function buildTestApp(): Express {
  const app = express();
  app.use(verifyServiceAuth({ tokenEnvVar: 'CONNECTOR_SERVICE_TOKEN' }));
  app.use('/api/connectors/catalog', express.json(), catalogRouter);
  return app;
}

describe('GET /api/connectors/catalog', () => {
  const ORIGINAL_TOKEN = process.env.CONNECTOR_SERVICE_TOKEN;

  beforeAll(() => {
    process.env.CONNECTOR_SERVICE_TOKEN = 'test-service-token';
  });

  afterAll(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.CONNECTOR_SERVICE_TOKEN;
    else process.env.CONNECTOR_SERVICE_TOKEN = ORIGINAL_TOKEN;
  });

  it('rejects requests without X-Service-Auth', async () => {
    const res = await request(buildTestApp()).get('/api/connectors/catalog');
    expect(res.status).toBe(401);
  });

  it('returns the catalog with version and categoryLabels', async () => {
    const res = await request(buildTestApp())
      .get('/api/connectors/catalog')
      .set('X-Service-Auth', 'test-service-token');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('connectors');
    expect(res.body).toHaveProperty('version');
    expect(res.body).toHaveProperty('categoryLabels');

    // Same count as the registry.
    expect(res.body.connectors.length).toBe(Object.keys(CONNECTORS).length);

    // Version matches the deterministic hash.
    expect(res.body.version).toBe(computeCatalogVersion());

    // Category labels match the source.
    expect(res.body.categoryLabels).toEqual(CATEGORY_DISPLAY_LABELS);

    // Sorted by type.
    const types = res.body.connectors.map((c: { type: string }) => c.type);
    expect(types).toEqual([...types].sort());
  });

  it('the user-facing view filters internal connectors; the service view keeps them', async () => {
    const serviceView = await request(buildTestApp())
      .get('/api/connectors/catalog')
      .set('X-Service-Auth', 'test-service-token');
    const userView = await request(buildTestApp())
      .get('/api/connectors/catalog')
      .set('X-Service-Auth', 'test-service-token')
      .set('x-catalog-view', 'user');

    const internalCount = serviceView.body.connectors.filter(
      (c: { status: string }) => c.status === 'internal',
    ).length;
    expect(internalCount).toBeGreaterThan(0); // the assertion is not vacuous
    expect(
      userView.body.connectors.some((c: { status: string }) => c.status === 'internal'),
    ).toBe(false);
    expect(userView.body.connectors.length).toBe(
      serviceView.body.connectors.length - internalCount,
    );
    // A shared cache must never serve one view as the other.
    expect(userView.headers.vary).toContain('x-catalog-view');
  });

  it('every connector in the response has the declared fields', async () => {
    const res = await request(buildTestApp())
      .get('/api/connectors/catalog')
      .set('X-Service-Auth', 'test-service-token');

    for (const connector of res.body.connectors) {
      expect(typeof connector.type).toBe('string');
      expect(typeof connector.displayName).toBe('string');
      expect(typeof connector.category).toBe('string');
      expect(typeof connector.status).toBe('string');
      expect(['available', 'coming_soon', 'beta', 'deprecated', 'internal']).toContain(connector.status);
      expect(connector.auth).toBeDefined();
    }
  });

  it('sets Cache-Control for upstream proxies', async () => {
    const res = await request(buildTestApp())
      .get('/api/connectors/catalog')
      .set('X-Service-Auth', 'test-service-token');
    expect(res.headers['cache-control']).toMatch(/max-age=\d+/);
  });
});
