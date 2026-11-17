// Tests for the centralized BACKEND_URL accessor. Guards against the prior
// silent-fallback-to-prod pattern that caused cross-environment trust bugs.

import {
  getBackendUrl,
  getBackendUrlOrNull,
  getProxyBaseUrl,
  _resetBackendUrlCacheForTests,
} from '../control-plane-url';

const originalBackendUrl = process.env.BACKEND_URL;
const originalProxyBaseUrl = process.env.PROXY_BASE_URL;
const originalNodeEnv = process.env.NODE_ENV;
const originalEnvironment = process.env.ENVIRONMENT;

beforeEach(() => {
  // Set NODE_ENV BEFORE the reset — the reset helper guards on NODE_ENV='test'.
  process.env.NODE_ENV = 'test';
  _resetBackendUrlCacheForTests();
  delete process.env.BACKEND_URL;
  delete process.env.PROXY_BASE_URL;
  delete process.env.ENVIRONMENT;
});

afterAll(() => {
  if (originalBackendUrl === undefined) delete process.env.BACKEND_URL;
  else process.env.BACKEND_URL = originalBackendUrl;
  if (originalProxyBaseUrl === undefined) delete process.env.PROXY_BASE_URL;
  else process.env.PROXY_BASE_URL = originalProxyBaseUrl;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalEnvironment === undefined) delete process.env.ENVIRONMENT;
  else process.env.ENVIRONMENT = originalEnvironment;
});

describe('getBackendUrl', () => {
  it('throws when BACKEND_URL is unset', () => {
    expect(() => getBackendUrl()).toThrow(/BACKEND_URL is unset/);
  });

  it('REGRESSION: rejects the prod alias when ENVIRONMENT=dev', () => {
    process.env.BACKEND_URL = 'https://api.example.com';
    process.env.ENVIRONMENT = 'dev';
    expect(() => getBackendUrl()).toThrow(/prod alias.*ENVIRONMENT.*"dev"/);
  });

  it('REGRESSION: rejects the prod alias when ENVIRONMENT=staging', () => {
    process.env.BACKEND_URL = 'https://api.example.com';
    process.env.ENVIRONMENT = 'staging';
    expect(() => getBackendUrl()).toThrow(/prod alias.*ENVIRONMENT.*"staging"/);
  });

  it('REGRESSION: rejects the prod alias when ENVIRONMENT is unset (local dev)', () => {
    process.env.BACKEND_URL = 'https://api.example.com';
    // ENVIRONMENT intentionally unset
    expect(() => getBackendUrl()).toThrow(/prod alias.*ENVIRONMENT.*"unset"/);
  });

  it('REGRESSION: rejects the prod alias even when NODE_ENV=production but ENVIRONMENT=dev', () => {
    // This was the previous-guard miss: dev Cloud Run sets NODE_ENV=production
    // but ENVIRONMENT=dev. The new guard catches this.
    process.env.BACKEND_URL = 'https://api.example.com';
    process.env.NODE_ENV = 'production';
    process.env.ENVIRONMENT = 'dev';
    expect(() => getBackendUrl()).toThrow(/prod alias.*ENVIRONMENT.*"dev"/);
  });

  it('accepts the prod alias when ENVIRONMENT=prod', () => {
    process.env.BACKEND_URL = 'https://api.example.com';
    process.env.ENVIRONMENT = 'prod';
    expect(getBackendUrl()).toBe('https://api.example.com');
  });

  it('accepts the dev alias under any ENVIRONMENT', () => {
    process.env.BACKEND_URL = 'https://api-dev.example.com';
    process.env.ENVIRONMENT = 'dev';
    expect(getBackendUrl()).toBe('https://api-dev.example.com');
  });

  it('accepts the local-dev URL', () => {
    process.env.BACKEND_URL = 'http://localhost:8080';
    expect(getBackendUrl()).toBe('http://localhost:8080');
  });

  it('strips trailing slashes', () => {
    process.env.BACKEND_URL = 'https://api-dev.example.com/';
    expect(getBackendUrl()).toBe('https://api-dev.example.com');
  });

  it('caches across calls so process.env mutations after first read are ignored', () => {
    process.env.BACKEND_URL = 'https://api-dev.example.com';
    expect(getBackendUrl()).toBe('https://api-dev.example.com');
    process.env.BACKEND_URL = 'https://other.example';
    expect(getBackendUrl()).toBe('https://api-dev.example.com');
  });
});

describe('getBackendUrlOrNull', () => {
  it('returns null instead of throwing when BACKEND_URL is unset', () => {
    expect(getBackendUrlOrNull()).toBeNull();
  });

  it('returns the URL when BACKEND_URL is set', () => {
    process.env.BACKEND_URL = 'https://api-dev.example.com';
    expect(getBackendUrlOrNull()).toBe('https://api-dev.example.com');
  });
});

describe('getProxyBaseUrl', () => {
  it('derives /proxy from BACKEND_URL', () => {
    process.env.BACKEND_URL = 'https://api-dev.example.com';
    expect(getProxyBaseUrl()).toBe('https://api-dev.example.com/proxy');
  });

  it('uses PROXY_BASE_URL override when set', () => {
    process.env.PROXY_BASE_URL = 'https://proxy-dev.example/proxy';
    expect(getProxyBaseUrl()).toBe('https://proxy-dev.example/proxy');
  });

  it('REGRESSION: rejects prod PROXY_BASE_URL when ENVIRONMENT is not prod', () => {
    process.env.PROXY_BASE_URL = 'https://api.example.com/proxy';
    process.env.ENVIRONMENT = 'dev';
    expect(() => getProxyBaseUrl()).toThrow(/prod alias.*ENVIRONMENT/);
  });

  it('throws via getBackendUrl when neither PROXY_BASE_URL nor BACKEND_URL is set', () => {
    expect(() => getProxyBaseUrl()).toThrow(/BACKEND_URL is unset/);
  });
});
