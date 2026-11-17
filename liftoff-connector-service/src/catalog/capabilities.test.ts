import {
  getConnectorCapability,
  listConnectorCapabilities,
  getFunctionalConnectorTypes,
  getCapabilityGroups,
} from './capabilities.js';
import { ConnectorCapability as ProtoCapability } from '@liftoffos/proto-gen/liftoff/connector/v1/types_pb.js';

describe('capabilities registry', () => {
  it('returns null for unknown connector', () => {
    expect(getConnectorCapability('__nope__')).toBeNull();
  });

  it('hydrates stripe capability with vendor-hosted MCP', () => {
    const cap = getConnectorCapability('stripe');
    expect(cap).not.toBeNull();
    expect(cap!.displayName).toBe('Stripe');
    expect(cap!.hasMcpConfig).toBe(true);
    expect(cap!.isVendorHostedMcp).toBe(true);
    expect(cap!.oauthProvider).toBe('stripe');
    // `mcp`, not `read_write`: the connector authenticates by DCR against
    // access.stripe.com/mcp, whose registration issues scope `mcp`.
    // `read_write` was Stripe CONNECT's scope, and Connect was never wired.
    expect(cap!.scopes).toContain('mcp');
  });

  it('lists many per-type capability entries', () => {
    const caps = listConnectorCapabilities();
    expect(caps.length).toBeGreaterThan(30);
    const googleMail = caps.find((c) => c.connectorType === 'google_mail');
    expect(googleMail?.oauthProvider).toBe('google');
  });
});

describe('getFunctionalConnectorTypes', () => {
  it('returns a sorted list pulled from FUNCTIONAL_CONNECTOR_TYPES', () => {
    const types = getFunctionalConnectorTypes();
    const sorted = [...types].sort();
    expect(types).toEqual(sorted);
    expect(types).toContain('slack');
    expect(types).toContain('github');
    expect(types).toContain('salesforce');
  });

  it('does not include connectors that are not yet functional', () => {
    const types = getFunctionalConnectorTypes();
    // docusign stays coming_soon until the DocuSign Partner Program account is
    // approved. zenefits is coming_soon pending its native integration.
    expect(types).not.toContain('docusign');
    expect(types).not.toContain('zenefits');
  });

  it('includes the available native HRIS connectors', () => {
    const types = getFunctionalConnectorTypes();
    expect(types).toContain('gusto');
    expect(types).toContain('rippling');
    expect(types).toContain('workday');
    expect(types).toContain('namely');
    expect(types).toContain('sap_successfactors');
    expect(types).toContain('oracle_hcm');
  });
});

describe('getCapabilityGroups', () => {
  it('returns one entry per proto-mapped capability key', () => {
    const groups = getCapabilityGroups();
    const keys = new Set(groups.map((g) => g.capabilityKey));
    expect(keys).toContain('email_marketing');
    expect(keys).toContain('crm');
    expect(keys).toContain('hris');
    expect(keys).toContain('project_management');
  });

  it('CRM group has salesforce + hubspot providers with correct scopes', () => {
    const crm = getCapabilityGroups().find((g) => g.capability === ProtoCapability.CRM);
    expect(crm).toBeDefined();
    const types = crm!.providers.map((p) => p.connectorType);
    expect(types).toEqual(expect.arrayContaining(['salesforce', 'hubspot']));
    const sf = crm!.providers.find((p) => p.connectorType === 'salesforce')!;
    // No scopes: salesforce is composio_managed, and Composio's
    // managed OAuth app holds the grant, so there is no Liftoff-side scope set to
    // require. Every composio_managed capability declares [] for the same reason.
    expect(sf.requiredScopes).toEqual([]);
    const hs = crm!.providers.find((p) => p.connectorType === 'hubspot')!;
    expect(hs.requiredScopes).toContain('crm.objects.contacts.read');
  });
});
