// URL guard tests covering the per-tenant allowlist layer added by the
// tunnels + custom-mcp-servers plan (§Phase 2).
//
// Covers (per plan §Verification):
//   - vendor allowlist still works
//   - tenant allowlist accepts registered URLs
//   - tenant allowlist rejects unregistered URLs
//   - cross-tenant leakage prevented
//   - HTTPS-only / IP literal / userinfo / private CIDR still enforced
//
// These tests don't touch the network or the platform-backend HTTP fetch —
// they exercise the pure guard logic with hand-crafted allowlist snapshots.

import {
  assertAllowlistMatchesTenant,
  assertMcpUrlAllowed,
  isMcpUrlAllowed,
  McpUrlRejected,
  type TenantAllowlistContext,
} from '../mcp-url-guard';

function makeAllowlist(urls: string[], tenantId = 'tenant-a'): TenantAllowlistContext {
  return { tenantId, urls, version: 'v-test' };
}

describe('mcp-url-guard tenant allowlist', () => {
  it('still accepts vendor allowlist URLs with no tenant context', () => {
    expect(() => assertMcpUrlAllowed('https://mcp.stripe.com/')).not.toThrow();
    expect(() => assertMcpUrlAllowed('https://mcp.hubspot.com/')).not.toThrow();
  });

  it('still accepts self-hosted *.run.app URLs', () => {
    expect(() => assertMcpUrlAllowed('https://salesforce-sidecar-abc-uw.a.run.app/mcp')).not.toThrow();
  });

  it('rejects an unknown host with no tenant context', () => {
    expect(() => assertMcpUrlAllowed('https://mcp.acme.com/mcp')).toThrow(McpUrlRejected);
  });

  it('accepts a URL listed in the tenant allowlist', () => {
    const ctx = makeAllowlist(['https://mcp.acme.com/mcp']);
    expect(() => assertMcpUrlAllowed('https://mcp.acme.com/mcp', ctx)).not.toThrow();
  });

  it('accepts a *.tunnels.example.com URL listed in the tenant allowlist', () => {
    const ctx = makeAllowlist(['https://acme-jira.tunnels.example.com/mcp']);
    expect(() =>
      assertMcpUrlAllowed('https://acme-jira.tunnels.example.com/mcp', ctx),
    ).not.toThrow();
  });

  it('rejects a URL that is NOT in the tenant allowlist (even if same TLD)', () => {
    const ctx = makeAllowlist(['https://acme-jira.tunnels.example.com/mcp']);
    expect(() =>
      assertMcpUrlAllowed('https://acme-confluence.tunnels.example.com/mcp', ctx),
    ).toThrow(McpUrlRejected);
  });

  it('does not leak across tenants — A allowlist must not accept B-only URLs', () => {
    const tenantAAllow = makeAllowlist(['https://mcp.acme.com/mcp'], 'tenant-a');
    // tenant B-only URL is rejected when guarded with tenant-A's snapshot
    expect(() =>
      assertMcpUrlAllowed('https://mcp.bravo.com/mcp', tenantAAllow),
    ).toThrow(McpUrlRejected);
  });

  it('normalises trailing slashes when matching', () => {
    const ctx = makeAllowlist(['https://mcp.acme.com/mcp/']);
    expect(() => assertMcpUrlAllowed('https://mcp.acme.com/mcp', ctx)).not.toThrow();
    expect(() => assertMcpUrlAllowed('https://mcp.acme.com/mcp/', ctx)).not.toThrow();
  });

  it('normalises scheme/host case-insensitively', () => {
    const ctx = makeAllowlist(['https://MCP.Acme.com/mcp']);
    expect(() => assertMcpUrlAllowed('https://mcp.acme.com/mcp', ctx)).not.toThrow();
  });

  it('still rejects non-HTTPS even when in the tenant allowlist', () => {
    const ctx = makeAllowlist(['http://mcp.acme.com/mcp']);
    expect(() => assertMcpUrlAllowed('http://mcp.acme.com/mcp', ctx)).toThrow(McpUrlRejected);
  });

  it('still rejects IP literals even when listed', () => {
    const ctx = makeAllowlist(['https://10.0.0.1/mcp']);
    expect(() => assertMcpUrlAllowed('https://10.0.0.1/mcp', ctx)).toThrow(McpUrlRejected);
  });

  it('still rejects URLs with userinfo even when listed', () => {
    const ctx = makeAllowlist(['https://user:pass@mcp.acme.com/mcp']);
    expect(() => assertMcpUrlAllowed('https://user:pass@mcp.acme.com/mcp', ctx)).toThrow(
      McpUrlRejected,
    );
  });

  it('still rejects private CIDR IP literals even when the URL is listed', () => {
    const ctx = makeAllowlist(['https://192.168.1.1/mcp']);
    expect(() => assertMcpUrlAllowed('https://192.168.1.1/mcp', ctx)).toThrow(McpUrlRejected);
  });

  it('isMcpUrlAllowed returns true for allowlisted URLs', () => {
    const ctx = makeAllowlist(['https://mcp.acme.com/mcp']);
    expect(isMcpUrlAllowed('https://mcp.acme.com/mcp', ctx)).toBe(true);
    expect(isMcpUrlAllowed('https://mcp.bravo.com/mcp', ctx)).toBe(false);
  });

  describe('matchesTenantAllowlist defensive checks', () => {
    it('rejects a malformed context with empty tenantId even if URLs match', () => {
      const broken = { tenantId: '', urls: ['https://mcp.acme.com/mcp'], version: 'v' } as TenantAllowlistContext;
      expect(() => assertMcpUrlAllowed('https://mcp.acme.com/mcp', broken)).toThrow(McpUrlRejected);
    });

    it('rejects a malformed context with non-array urls', () => {
      const broken = { tenantId: 'tenant-a', urls: 'oops' as unknown as string[], version: 'v' } as TenantAllowlistContext;
      expect(() => assertMcpUrlAllowed('https://mcp.acme.com/mcp', broken)).toThrow(McpUrlRejected);
    });
  });

  describe('assertAllowlistMatchesTenant', () => {
    it('passes when context.tenantId matches expected', () => {
      const ctx = makeAllowlist(['https://x'], 'tenant-a');
      expect(() => assertAllowlistMatchesTenant(ctx, 'tenant-a')).not.toThrow();
    });

    it('throws when context.tenantId is for a different tenant', () => {
      const ctx = makeAllowlist(['https://x'], 'tenant-a');
      expect(() => assertAllowlistMatchesTenant(ctx, 'tenant-b')).toThrow(/tenant allowlist snapshot mismatch/);
    });

    it('is a no-op when no context is supplied', () => {
      expect(() => assertAllowlistMatchesTenant(undefined, 'tenant-a')).not.toThrow();
    });
  });
});
