import { loadConfig, resetConfigForTests } from '../infrastructure/config';

const base = {
  GCP_PROJECT_ID: 'test-project',
  DB_INSTANCE_CONNECTION_NAME: 'test:us-west1:db',
};

describe('public URLs derived from ENVIRONMENT', () => {
  beforeEach(() => resetConfigForTests());
  afterAll(() => resetConfigForTests());

  it('derives both public URLs for prod when the deploy sets neither', () => {
    const config = loadConfig({ ...base, ENVIRONMENT: 'prod' });
    expect(config.PLATFORM_BACKEND_URL).toBe('https://api.example.com');
    expect(config.PROXY_BASE_URL).toBe('https://api.example.com/proxy');
  });

  it('derives both public URLs for dev when the deploy sets neither', () => {
    const config = loadConfig({ ...base, ENVIRONMENT: 'dev' });
    expect(config.PLATFORM_BACKEND_URL).toBe('https://api-dev.example.com');
    expect(config.PROXY_BASE_URL).toBe('https://api-dev.example.com/proxy');
  });

  it('keeps an explicit value that matches the environment', () => {
    const config = loadConfig({
      ...base,
      ENVIRONMENT: 'prod',
      PLATFORM_BACKEND_URL: 'https://api.example.com',
      PROXY_BASE_URL: 'https://api.example.com/proxy',
    });
    expect(config.PROXY_BASE_URL).toBe('https://api.example.com/proxy');
  });

  it('refuses the production proxy URL in a non-production environment', () => {
    expect(() =>
      loadConfig({ ...base, ENVIRONMENT: 'dev', PROXY_BASE_URL: 'https://api.example.com/proxy' }),
    ).toThrow(/non-production/);
  });

  it("refuses another environment's proxy URL in production", () => {
    // The failure mode: a cloudbuild default the trigger never overrides.
    expect(() =>
      loadConfig({ ...base, ENVIRONMENT: 'prod', PROXY_BASE_URL: 'https://api-dev.example.com/proxy' }),
    ).toThrow(/must be https:\/\/api\.liftoffos\.com\/proxy/);
  });
});
