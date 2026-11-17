// Vendor-hosted MCP classification. Documents the gating boundary: destructive /
// write / communication / financial operations map to the SensitivityCategory
// strings the HITL sensitive-work gate matches on (and destructive ops get the
// marker the level-2 gate keys on), while read-only operations classify to [] so
// they never spuriously gate.
//
// ⚠️ These assertions pin the heuristic, not a calibrated classifier (see
// vendor-mcp-classify.ts) — they document current behavior and the gated/ungated
// boundary, not a guarantee for any specific vendor's inventory.

import { classifyVendorMcpTool } from '../vendor-mcp-classify';

describe('classifyVendorMcpTool', () => {
  it('classifies a destructive op with the marker + dataChanges (gates under level-2 AND sensitive-work)', () => {
    const c = classifyVendorMcpTool('github-x', 'delete_repo');
    expect(c.destructive).toBe(true);
    expect(c.categories).toEqual(expect.arrayContaining(['destructive', 'dataChanges']));
  });

  it('classifies a financial op as financialActions', () => {
    const c = classifyVendorMcpTool('stripe-x', 'create_refund');
    expect(c.destructive).toBe(false);
    // 'create' → dataChanges, 'refund' → financialActions.
    expect(c.categories).toEqual(expect.arrayContaining(['financialActions', 'dataChanges']));
  });

  it('classifies an outbound communication op as customerCommunication', () => {
    expect(classifyVendorMcpTool('slack-x', 'send_message').categories).toContain('customerCommunication');
  });

  it('classifies a publishing op as externalPublishing', () => {
    expect(classifyVendorMcpTool('x-x', 'publish_post').categories).toContain('externalPublishing');
  });

  it('classifies read-only ops as ungated (empty categories) — the boundary', () => {
    expect(classifyVendorMcpTool('github-x', 'get_issue')).toEqual({ categories: [], destructive: false });
    expect(classifyVendorMcpTool('github-x', 'list_repos')).toEqual({ categories: [], destructive: false });
    expect(classifyVendorMcpTool('notion-x', 'search_pages')).toEqual({ categories: [], destructive: false });
  });
});
