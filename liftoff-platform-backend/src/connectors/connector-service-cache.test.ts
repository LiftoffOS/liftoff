// Tests for the connector-service RPC cache (Fix 6).
//
// These exercise the drop-in replacements exported by
//   src/agent-templates/connector-availability.ts  → FUNCTIONAL_CONNECTOR_TYPES
//   src/agent-templates/connector-capabilities.ts  → CONNECTOR_CAPABILITIES + helpers
//
// The goal: prove that when the cache holds RPC-derived data, the legacy
// exports reflect that data, so existing call sites that still use the
// old names (loader.ts, validator.ts, from-template-router.ts,
// distill-service.ts, tests) pick up the new source of truth with no
// code change.

import {
  seedConnectorServiceCache,
  getFunctionalConnectorTypes,
  connectorTypesForCapability,
  scopesForConnector,
  getAllCapabilities,
  getCacheSource,
  stopConnectorServiceCache,
} from './connector-service-cache';
import {
  FUNCTIONAL_CONNECTOR_TYPES,
} from '../agent-templates/connector-availability';
import {
  CONNECTOR_CAPABILITIES,
  connectorTypesForCapability as legacyTypesFor,
  scopesForConnector as legacyScopesFor,
} from '../agent-templates/connector-capabilities';

describe('connector-service-cache (Fix 6: collapse duplicate sources)', () => {
  afterEach(() => stopConnectorServiceCache());

  it('legacy FUNCTIONAL_CONNECTOR_TYPES reflects the cache', () => {
    seedConnectorServiceCache({
      functionalTypes: ['slack', 'github'],
      capabilities: {},
    });
    expect(FUNCTIONAL_CONNECTOR_TYPES.has('slack')).toBe(true);
    expect(FUNCTIONAL_CONNECTOR_TYPES.has('github')).toBe(true);
    expect(FUNCTIONAL_CONNECTOR_TYPES.has('unknown')).toBe(false);
    expect(FUNCTIONAL_CONNECTOR_TYPES.size).toBe(2);
  });

  it('updates live — a re-seed is visible without re-importing', () => {
    seedConnectorServiceCache({ functionalTypes: ['a'], capabilities: {} });
    expect(FUNCTIONAL_CONNECTOR_TYPES.has('a')).toBe(true);
    expect(FUNCTIONAL_CONNECTOR_TYPES.has('b')).toBe(false);

    seedConnectorServiceCache({ functionalTypes: ['b', 'c'], capabilities: {} });
    expect(FUNCTIONAL_CONNECTOR_TYPES.has('a')).toBe(false);
    expect(FUNCTIONAL_CONNECTOR_TYPES.has('b')).toBe(true);
    expect(FUNCTIONAL_CONNECTOR_TYPES.has('c')).toBe(true);
  });

  it('legacy CONNECTOR_CAPABILITIES reflects the cache', () => {
    seedConnectorServiceCache({
      functionalTypes: [],
      capabilities: {
        crm: [{ connectorType: 'salesforce', requiredScopes: ['api'] }],
        hris: [{ connectorType: 'bamboohr', requiredScopes: ['employee:read'] }],
      },
    });
    expect(Object.keys(CONNECTOR_CAPABILITIES).sort()).toEqual(['crm', 'hris']);
    expect(CONNECTOR_CAPABILITIES['crm'][0].connectorType).toBe('salesforce');
    expect(CONNECTOR_CAPABILITIES['hris'][0].requiredScopes).toEqual(['employee:read']);
  });

  it('legacy helper functions resolve through the cache', () => {
    seedConnectorServiceCache({
      functionalTypes: [],
      capabilities: {
        email_marketing: [
          { connectorType: 'mailchimp', requiredScopes: ['readonly'] },
          { connectorType: 'sendgrid', requiredScopes: ['mail.send'] },
        ],
      },
    });
    expect(legacyTypesFor('email_marketing')).toEqual(['mailchimp', 'sendgrid']);
    expect(legacyScopesFor('email_marketing', 'sendgrid')).toEqual(['mail.send']);
    expect(legacyScopesFor('email_marketing', 'nonexistent')).toEqual([]);
  });

  it('direct getters match the legacy shims', () => {
    seedConnectorServiceCache({
      functionalTypes: ['zoom'],
      capabilities: { crm: [{ connectorType: 'hubspot', requiredScopes: ['x'] }] },
    });
    expect(getFunctionalConnectorTypes()).toBeInstanceOf(Set);
    expect(Array.from(getFunctionalConnectorTypes())).toEqual(['zoom']);
    expect(connectorTypesForCapability('crm')).toEqual(['hubspot']);
    expect(scopesForConnector('crm', 'hubspot')).toEqual(['x']);
    expect(getAllCapabilities()).toEqual({
      crm: [{ connectorType: 'hubspot', requiredScopes: ['x'] }],
    });
  });

  it('cache source marker reflects the seed', () => {
    seedConnectorServiceCache({ functionalTypes: [], capabilities: {} });
    expect(getCacheSource()).toBe('seed');
  });
});
