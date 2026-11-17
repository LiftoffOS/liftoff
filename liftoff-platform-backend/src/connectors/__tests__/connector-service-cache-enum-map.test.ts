// The RPC refresh maps each GetCapabilities entry from the proto enum value
// to the catalog key, and drops an unmapped value in silence. That map was
// nine hand-written rows against an enum of thirty-five, so every capability
// past the ninth reached this cache only through the static fallback. It is
// derived from the enum now; this pins that every enum value maps, and that
// the mapping is the catalog key (the member name, lower-cased).

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const getCapabilities = jest.fn();
const getFunctionalTypes = jest.fn();
jest.mock('../connector-service-client', () => {
  const actual = jest.requireActual('../connector-service-client');
  return {
    ...actual,
    isConnectorServiceEnabled: () => true,
    isShadowMode: () => false,
    getConnectorServiceClient: () => ({ getCapabilities, getFunctionalTypes }),
  };
});

import { ConnectorCapabilityEnum } from '../connector-service-client';
import {
  connectorTypesForCapability,
  initConnectorServiceCache,
  stopConnectorServiceCache,
} from '../connector-service-cache';

afterEach(() => stopConnectorServiceCache());

it('maps every proto capability value the installed proto-gen knows, not a hand-listed subset', async () => {
  const values = Object.entries(ConnectorCapabilityEnum as unknown as Record<string, number | string>)
    .filter((e): e is [string, number] => typeof e[1] === 'number' && e[0] !== 'UNSPECIFIED');
  expect(values.length).toBeGreaterThan(30);

  getFunctionalTypes.mockResolvedValue({ connectorTypes: [] });
  getCapabilities.mockResolvedValue({
    capabilities: values.map(([name, value]) => ({
      capability: value,
      providers: [{ connectorType: `vendor-for-${name.toLowerCase()}`, requiredScopes: [] }],
    })),
  });
  await initConnectorServiceCache();

  for (const [name] of values) {
    const key = name.toLowerCase();
    expect(connectorTypesForCapability(key)).toEqual([`vendor-for-${key}`]);
  }
  // The four the data vendors declare (proto-gen 0.24.0), by name.
  for (const key of ['compliance_checks', 'company_intelligence', 'news_monitoring', 'market_data']) {
    expect(connectorTypesForCapability(key)).toHaveLength(1);
  }
});
