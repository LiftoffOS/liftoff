// Tests for getWebhookBaseUrl. Mirrors control-plane-url.test.ts — same
// fail-loud-on-unset, same prod-poisoning guard, same caching semantics.

import {
  getWebhookBaseUrl,
  _resetWebhookBaseUrlCacheForTests,
} from '../webhook-base-url';

const originalWebhookBaseUrl = process.env.WEBHOOK_BASE_URL;
const originalNodeEnv = process.env.NODE_ENV;
const originalEnvironment = process.env.ENVIRONMENT;

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  _resetWebhookBaseUrlCacheForTests();
  delete process.env.WEBHOOK_BASE_URL;
  delete process.env.ENVIRONMENT;
});

afterAll(() => {
  if (originalWebhookBaseUrl === undefined) delete process.env.WEBHOOK_BASE_URL;
  else process.env.WEBHOOK_BASE_URL = originalWebhookBaseUrl;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalEnvironment === undefined) delete process.env.ENVIRONMENT;
  else process.env.ENVIRONMENT = originalEnvironment;
});

describe('getWebhookBaseUrl', () => {
  it('throws when WEBHOOK_BASE_URL is unset', () => {
    expect(() => getWebhookBaseUrl()).toThrow(/WEBHOOK_BASE_URL is unset/);
  });

  it('REGRESSION: rejects the prod alias when ENVIRONMENT=dev', () => {
    process.env.WEBHOOK_BASE_URL = 'https://webhooks.example.com/v1';
    process.env.ENVIRONMENT = 'dev';
    expect(() => getWebhookBaseUrl()).toThrow(/prod alias.*ENVIRONMENT.*"dev"/);
  });

  it('REGRESSION: rejects the prod alias when ENVIRONMENT=staging', () => {
    process.env.WEBHOOK_BASE_URL = 'https://webhooks.example.com/v1';
    process.env.ENVIRONMENT = 'staging';
    expect(() => getWebhookBaseUrl()).toThrow(/prod alias.*ENVIRONMENT.*"staging"/);
  });

  it('REGRESSION: rejects the prod alias when ENVIRONMENT is unset (local dev)', () => {
    process.env.WEBHOOK_BASE_URL = 'https://webhooks.example.com/v1';
    expect(() => getWebhookBaseUrl()).toThrow(/prod alias.*ENVIRONMENT.*"unset"/);
  });

  it('REGRESSION: rejects the prod alias when NODE_ENV=production but ENVIRONMENT=dev', () => {
    // Mirrors the cross-env trust bug fix in control-plane-url.ts: dev Cloud
    // Run sets NODE_ENV=production but ENVIRONMENT=dev, so NODE_ENV alone is
    // not a sufficient guard.
    process.env.WEBHOOK_BASE_URL = 'https://webhooks.example.com/v1';
    process.env.NODE_ENV = 'production';
    process.env.ENVIRONMENT = 'dev';
    expect(() => getWebhookBaseUrl()).toThrow(/prod alias.*ENVIRONMENT.*"dev"/);
  });

  it('accepts the prod alias when ENVIRONMENT=prod', () => {
    process.env.WEBHOOK_BASE_URL = 'https://webhooks.example.com/v1';
    process.env.ENVIRONMENT = 'prod';
    expect(getWebhookBaseUrl()).toBe('https://webhooks.example.com/v1');
  });

  it('accepts the dev alias under any ENVIRONMENT', () => {
    process.env.WEBHOOK_BASE_URL = 'https://webhooks-dev.example.com/v1';
    process.env.ENVIRONMENT = 'dev';
    expect(getWebhookBaseUrl()).toBe('https://webhooks-dev.example.com/v1');
  });

  it('accepts the local-dev URL', () => {
    process.env.WEBHOOK_BASE_URL = 'http://localhost:8080/v1';
    expect(getWebhookBaseUrl()).toBe('http://localhost:8080/v1');
  });

  it('strips trailing slashes', () => {
    process.env.WEBHOOK_BASE_URL = 'https://webhooks-dev.example.com/v1/';
    expect(getWebhookBaseUrl()).toBe('https://webhooks-dev.example.com/v1');
  });

  it('caches across calls so process.env mutations after first read are ignored', () => {
    process.env.WEBHOOK_BASE_URL = 'https://webhooks-dev.example.com/v1';
    expect(getWebhookBaseUrl()).toBe('https://webhooks-dev.example.com/v1');
    process.env.WEBHOOK_BASE_URL = 'https://other.example/v1';
    expect(getWebhookBaseUrl()).toBe('https://webhooks-dev.example.com/v1');
  });
});
