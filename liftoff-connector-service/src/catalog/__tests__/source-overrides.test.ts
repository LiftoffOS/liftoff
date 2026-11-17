// Composio cutover-completion (C8): source-overrides env-var parsing tests.

import {
  parseEnvCsv,
  shouldSwitchoverComposioToNative,
  shouldForceComposio,
} from '../source-overrides';

describe('parseEnvCsv', () => {
  it('returns an empty set for undefined / empty string', () => {
    expect(parseEnvCsv(undefined).size).toBe(0);
    expect(parseEnvCsv('').size).toBe(0);
  });

  it('parses a single value', () => {
    expect([...parseEnvCsv('slack')]).toEqual(['slack']);
  });

  it('parses comma-separated values with whitespace tolerance', () => {
    expect([...parseEnvCsv('slack, google_mail, github').values()].sort()).toEqual([
      'github', 'google_mail', 'slack',
    ]);
  });

  it('drops empty segments from trailing / duplicate commas', () => {
    expect([...parseEnvCsv('slack,,google_mail,').values()].sort()).toEqual([
      'google_mail', 'slack',
    ]);
  });
});

describe('shouldSwitchoverComposioToNative (COMPOSIO_DISABLED_CONNECTORS)', () => {
  const PREV = process.env.COMPOSIO_DISABLED_CONNECTORS;
  afterEach(() => {
    if (PREV === undefined) delete process.env.COMPOSIO_DISABLED_CONNECTORS;
    else process.env.COMPOSIO_DISABLED_CONNECTORS = PREV;
  });

  it('returns false when env var is unset', () => {
    delete process.env.COMPOSIO_DISABLED_CONNECTORS;
    expect(shouldSwitchoverComposioToNative('google_mail')).toBe(false);
  });

  it('returns true when the connector type is in the env var', () => {
    process.env.COMPOSIO_DISABLED_CONNECTORS = 'google_mail,slack';
    expect(shouldSwitchoverComposioToNative('google_mail')).toBe(true);
    expect(shouldSwitchoverComposioToNative('slack')).toBe(true);
    expect(shouldSwitchoverComposioToNative('github')).toBe(false);
  });
});

describe('shouldForceComposio (FORCE_COMPOSIO_FOR_CONNECTOR_TYPES)', () => {
  const PREV = process.env.FORCE_COMPOSIO_FOR_CONNECTOR_TYPES;
  afterEach(() => {
    if (PREV === undefined) delete process.env.FORCE_COMPOSIO_FOR_CONNECTOR_TYPES;
    else process.env.FORCE_COMPOSIO_FOR_CONNECTOR_TYPES = PREV;
  });

  it('returns false when env var is unset', () => {
    delete process.env.FORCE_COMPOSIO_FOR_CONNECTOR_TYPES;
    expect(shouldForceComposio('linear')).toBe(false);
  });

  it('returns true when the connector type is in the env var', () => {
    process.env.FORCE_COMPOSIO_FOR_CONNECTOR_TYPES = 'linear,zendesk';
    expect(shouldForceComposio('linear')).toBe(true);
    expect(shouldForceComposio('zendesk')).toBe(true);
    expect(shouldForceComposio('salesforce')).toBe(false);
  });
});
