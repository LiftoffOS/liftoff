import {
  resolveDatadogSite,
  isValidDatadogSite,
  datadogDiscoveryBaseUrl,
  datadogApiBaseUrl,
  datadogRegistrationKey,
  datadogMcpUrl,
  datadogSiteSentinel,
  siteFromSentinels,
  DATADOG_DEFAULT_SITE,
} from './datadog-region.js';
import { resolveTokenEndpoint } from '../credentials/oauth-providers/dcr.js';

describe('datadog-region helpers', () => {
  it('validates + normalizes sites, defaulting unknown/empty to US1', () => {
    expect(isValidDatadogSite('us3.datadoghq.com')).toBe(true);
    expect(isValidDatadogSite('ap2.datadoghq.com')).toBe(true); // AP2 - Australia
    expect(isValidDatadogSite('evil.com')).toBe(false);
    // FED regions are excluded — they don't expose the MCP OAuth flow.
    expect(isValidDatadogSite('ddog-gov.com')).toBe(false);
    expect(isValidDatadogSite('us2.ddog-gov.com')).toBe(false);
    expect(resolveDatadogSite('us3.datadoghq.com')).toBe('us3.datadoghq.com');
    expect(resolveDatadogSite('US5.DATADOGHQ.COM')).toBe('us5.datadoghq.com');
    expect(resolveDatadogSite('evil.com')).toBe(DATADOG_DEFAULT_SITE);
    expect(resolveDatadogSite(undefined)).toBe(DATADOG_DEFAULT_SITE);
  });

  it('derives every region URL from the site', () => {
    expect(datadogDiscoveryBaseUrl('us3.datadoghq.com')).toBe('https://mcp.us3.datadoghq.com');
    expect(datadogApiBaseUrl('us3.datadoghq.com')).toBe('https://api.us3.datadoghq.com');
    expect(datadogRegistrationKey('us3.datadoghq.com')).toBe('datadog@us3.datadoghq.com');
    expect(datadogMcpUrl('us3.datadoghq.com')).toBe('https://mcp.us3.datadoghq.com/api/unstable/mcp-server/mcp');
  });

  it('US1 default keeps the legacy hosts', () => {
    expect(datadogDiscoveryBaseUrl('datadoghq.com')).toBe('https://mcp.datadoghq.com');
    expect(datadogRegistrationKey('datadoghq.com')).toBe('datadog@datadoghq.com');
  });

  it('round-trips the site through scope sentinels (validating on read)', () => {
    expect(datadogSiteSentinel('us3.datadoghq.com')).toBe('site:us3.datadoghq.com');
    expect(siteFromSentinels(['repo', 'site:us3.datadoghq.com'])).toBe('us3.datadoghq.com');
    expect(siteFromSentinels(['site:evil.com'])).toBe(DATADOG_DEFAULT_SITE);
    expect(siteFromSentinels(null)).toBe(DATADOG_DEFAULT_SITE);
    expect(siteFromSentinels(['no-site-here'])).toBe(DATADOG_DEFAULT_SITE);
  });
});

describe('dcr resolveTokenEndpoint (datadog is no longer DCR)', () => {
  it('non-datadog DCR providers keep their fixed token endpoints', () => {
    expect(resolveTokenEndpoint('notion')).toBe('https://api.notion.com/v1/oauth/token');
    expect(resolveTokenEndpoint('asana')).toBe('https://app.asana.com/-/oauth_token');
  });
});
