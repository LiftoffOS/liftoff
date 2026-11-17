import {
  getMCPServerConfig,
  getMCPConnectorTypes,
  getConnectorMode,
  validateMCPUrl,
  ALLOWED_MCP_DOMAINS,
} from './mcp-server-registry.js';

describe('mcp-server-registry', () => {
  const ORIG_SIDECAR = process.env.MCP_SIDECAR_URL;
  afterAll(() => {
    if (ORIG_SIDECAR === undefined) delete process.env.MCP_SIDECAR_URL;
    else process.env.MCP_SIDECAR_URL = ORIG_SIDECAR;
  });

  it('returns vendor-hosted config without requiring MCP_SIDECAR_URL', () => {
    delete process.env.MCP_SIDECAR_URL;
    const cfg = getMCPServerConfig('stripe');
    expect(cfg).not.toBeNull();
    expect(cfg?.isVendorHosted).toBe(true);
    expect(cfg?.mcpUrl).toBe('https://mcp.stripe.com');
  });

  // zendesk, not salesforce: salesforce is composio_managed,
  // so it is not a self-hosted sidecar and resolves null at any
  // MCP_SIDECAR_URL. zendesk is still `kind: 'sidecar'` at '/zendesk'.
  it('returns null for self-hosted connectors when MCP_SIDECAR_URL is unset', () => {
    delete process.env.MCP_SIDECAR_URL;
    expect(getMCPServerConfig('zendesk')).toBeNull();
  });

  it('resolves self-hosted sidecar URLs from MCP_SIDECAR_URL at call time', () => {
    process.env.MCP_SIDECAR_URL = 'http://localhost:8100';
    const cfg = getMCPServerConfig('zendesk');
    expect(cfg).not.toBeNull();
    expect(cfg?.mcpUrl).toBe('http://localhost:8100/zendesk');
  });

  it('getConnectorMode returns mcp for registered types, rest otherwise', () => {
    expect(getConnectorMode('stripe')).toBe('mcp');
    expect(getConnectorMode('__nope__')).toBe('rest');
  });

  it('lists all registered connector types', () => {
    const types = getMCPConnectorTypes();
    expect(types.length).toBeGreaterThan(30);
    expect(types).toContain('stripe');
    expect(types).toContain('snowflake');
  });

  it('applies per-workspace urlResolver when connectorConfig is provided', () => {
    const cfg = getMCPServerConfig('snowflake', { accountIdentifier: 'acct-42' });
    expect(cfg?.mcpUrl).toBe('https://acct-42.snowflakecomputing.com/api/2.0/mcp');
  });

  describe('datadog is composio_managed (no vendor MCP server)', () => {
    it('returns null — datadog tools dispatch through Composio, not a vendor MCP host', () => {
      expect(getMCPServerConfig('datadog')).toBeNull();
      expect(getMCPServerConfig('datadog', { site: 'us3' })).toBeNull();
    });
  });

  describe('validateMCPUrl', () => {
    it('accepts allow-listed vendor hostnames', () => {
      expect(validateMCPUrl('https://mcp.stripe.com')).toBe(true);
      expect(validateMCPUrl('https://mcp.notion.com/mcp')).toBe(true);
    });
    it('rejects non-allowlisted hostnames', () => {
      expect(validateMCPUrl('https://evil.example.com')).toBe(false);
    });
    it('rejects URLs with userinfo', () => {
      expect(validateMCPUrl('https://a:b@mcp.stripe.com')).toBe(false);
    });
    it('rejects HTTP for non-localhost', () => {
      expect(validateMCPUrl('http://mcp.stripe.com')).toBe(false);
    });
    it('accepts HTTP for localhost', () => {
      expect(validateMCPUrl('http://localhost:8100/mcp')).toBe(true);
    });
    it('rejects private IPs', () => {
      expect(validateMCPUrl('https://10.0.0.1/mcp')).toBe(false);
      expect(validateMCPUrl('https://169.254.169.254/mcp')).toBe(false);
    });
  });

  it('ALLOWED_MCP_DOMAINS is a defensive set (frozen logically)', () => {
    expect(ALLOWED_MCP_DOMAINS.has('mcp.stripe.com')).toBe(true);
    expect(ALLOWED_MCP_DOMAINS.has('evil.com')).toBe(false);
  });

  describe('composio_managed entries (post-C5: branch removed)', () => {
    // Composio cutover-completion (C5): the composio_managed branch in
    // mcp-server-registry.ts was removed. composio_managed connectors no
    // longer return an MCP server config — tool dispatch happens in-process
    // in tenant-runtime via composio.tools.execute(). getMCPServerConfig
    // returns null for every composio_managed connector. The switchover
    // (COMPOSIO_DISABLED_CONNECTORS) is now handled in the boot block of
    // connector-functions-registry.ts via source-overrides.ts — covered by
    // that file's own tests (source-overrides.test.ts).

    it('returns null for every composio_managed connector type (no vendorMcpServers entry)', () => {
      const cfg = getMCPServerConfig('google_mail');
      expect(cfg).toBeNull();
    });

    it('returns null for composio_managed types regardless of COMPOSIO_DISABLED_CONNECTORS value', () => {
      const prev = process.env.COMPOSIO_DISABLED_CONNECTORS;
      try {
        process.env.COMPOSIO_DISABLED_CONNECTORS = 'google_mail,slack';
        jest.resetModules();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fresh = require('./mcp-server-registry.js') as typeof import('./mcp-server-registry.js');
        expect(fresh.getMCPServerConfig('google_mail')).toBeNull();
        // slack is kind:'sidecar' (own app) — it has a
        // real sidecar server config and is exempt from the composio-null rule.
        expect(fresh.getMCPServerConfig('slack')).not.toBeNull();
      } finally {
        if (prev === undefined) delete process.env.COMPOSIO_DISABLED_CONNECTORS;
        else process.env.COMPOSIO_DISABLED_CONNECTORS = prev;
        jest.resetModules();
      }
    });
  });
});

