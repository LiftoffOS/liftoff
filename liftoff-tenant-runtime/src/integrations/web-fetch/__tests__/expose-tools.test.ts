const mockGetAllVendorFlags = jest.fn();
const mockGetTenantConnectedWebVendors = jest.fn();

// isVendorExcludedForTenant is mocked alongside the flags because the platform
// pane gate reads BOTH switches. Left out, the gate's lookup throws, it fails
// closed, and every case below would be asserting connector behaviour while
// believing it had also covered the platform tier.
const mockIsVendorExcludedForTenant = jest.fn();
jest.mock('../global-flags', () => ({
  getAllVendorFlags: (...a: unknown[]) => mockGetAllVendorFlags(...a),
  isVendorExcludedForTenant: (...a: unknown[]) => mockIsVendorExcludedForTenant(...a),
}));

// The platform pane gate also asks whether the platform actually HOLDS the
// vendor's key, so the mock answers that too: a mock without it throws inside
// the gate, which fails closed, and the platform-tier cases would prove the
// opposite of what they say.
const mockGetWebToolSecret = jest.fn();
jest.mock('../web-tool-secrets', () => ({
  getTenantConnectedWebVendors: (...a: unknown[]) => mockGetTenantConnectedWebVendors(...a),
  getWebToolSecret: (...a: unknown[]) => mockGetWebToolSecret(...a),
}));

import { buildExposedStandardTools } from '../expose-tools';
import { _resetPlatformKeyCache } from '../../../browser-sessions/session-vendor-connectors';

const ALL_WEB_TOOLS = [
  { name: 'web_fetch_advanced' },
  { name: 'web_extract' },
  { name: 'web_task' },
  { name: 'web_research' },
  { name: 'web_people_search' },
  { name: 'web_finance_search' },
  { name: 'web_deep_research' },
  { name: 'web_diff' },
  { name: 'web_identity_connect' },
  { name: 'web_session_save' },
  { name: 'web_session_list' },
  { name: 'web_session_forget' },
  { name: 'web_session_close' },
];

const NON_WEB_TOOL = { name: 'memory_save' };

// Every vendor in the VendorFlags union. browser_use was missing, which mattered
// once the platform pane gate started reading it: an absent flag is falsy, the
// gate fails closed, and a case meaning to exercise the platform browser would
// have proven the opposite while looking correct.
const allOn = {
  webclaw: true, firecrawl: true, perplexity: true, anchor: true,
  browserbase: true, tavily: true, exa: true, openai: true, google: true,
  browser_use: true, xai: true, steel: true,
};

const ALL_BYOK_CONNECTED = new Set(['webclaw', 'firecrawl', 'anchor_browser', 'browserbase', 'tavily', 'exa']);

beforeEach(() => {
  jest.clearAllMocks();
  _resetPlatformKeyCache();
  mockGetWebToolSecret.mockResolvedValue('platform-key');
  mockGetTenantConnectedWebVendors.mockResolvedValue(new Set());
  // Default the PLATFORM browser off, so each case below is about the
  // connectors it names. The cases that are about the platform tier turn it on.
  mockIsVendorExcludedForTenant.mockResolvedValue(true);
});

function names(arr: Array<{ name: string }>) { return arr.map(t => t.name).sort(); }

// The bridged basic search. Offered only where the run's engine attaches no
// vendor search of its own, on the backend the provider owns.
describe('buildExposedStandardTools — web_search', () => {
  const SEARCH = [{ name: 'web_search' }];

  it('is offered to a run whose engine has no native search, on Perplexity', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn });
    const out = await buildExposedStandardTools(SEARCH, 'tenant-1', { nativeWebSearch: false, provider: 'glm' });
    expect(names(out)).toEqual(['web_search']);
  });

  it('is withheld from a run whose engine searches natively, so the model never sees two searches', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn });
    const out = await buildExposedStandardTools(SEARCH, 'tenant-1', { nativeWebSearch: true, provider: 'openai' });
    expect(names(out)).toEqual([]);
  });

  it('is offered for a Grok run on xAI\'s backend, and still on Perplexity\'s when xAI is off', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, xai: true });
    expect(names(await buildExposedStandardTools(SEARCH, 'tenant-1', { nativeWebSearch: false, provider: 'xai' }))).toEqual(['web_search']);
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, xai: false, perplexity: true });
    expect(names(await buildExposedStandardTools(SEARCH, 'tenant-1', { nativeWebSearch: false, provider: 'xai' }))).toEqual(['web_search']);
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, xai: false, perplexity: false });
    expect(names(await buildExposedStandardTools(SEARCH, 'tenant-1', { nativeWebSearch: false, provider: 'xai' }))).toEqual([]);
  });

  it('is withheld when Perplexity is off for a non-Grok run, whatever xAI says', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, xai: true, perplexity: false });
    const out = await buildExposedStandardTools(SEARCH, 'tenant-1', { nativeWebSearch: false, provider: 'qwen' });
    expect(names(out)).toEqual([]);
  });

  it('is offered rather than withheld when the caller knows no run', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn });
    const out = await buildExposedStandardTools(SEARCH, 'tenant-1');
    expect(names(out)).toEqual(['web_search']);
  });
});

describe('buildExposedStandardTools', () => {
  it('all flags true + all BYOK connected → every web tool is present', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn });
    mockGetTenantConnectedWebVendors.mockResolvedValue(ALL_BYOK_CONNECTED);
    const out = await buildExposedStandardTools([...ALL_WEB_TOOLS, NON_WEB_TOOL], 'tenant-1');
    expect(names(out)).toEqual([
      'memory_save',
      'web_deep_research',
      'web_diff',
      'web_extract',
      'web_fetch_advanced',
      'web_finance_search',
      'web_identity_connect',
      'web_people_search',
      'web_research',
      'web_session_close',
      'web_session_forget',
      'web_session_list',
      'web_session_save',
      'web_task',
    ]);
  });

  it('anchor_browser not connected removes the Anchor-shaped tools, and only those', async () => {
    // web_task, web_identity_connect and web_session_save need Anchor's own
    // in-session agent and hosted credential capture, which no other vendor
    // has. The pane tools are a different question: browserbase is connected
    // here and drives the pane, so withholding them would hide a browser the
    // workspace can actually use.
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, openai: false, google: false });
    mockGetTenantConnectedWebVendors.mockResolvedValue(new Set(['webclaw', 'firecrawl', 'browserbase', 'tavily', 'exa']));
    const out = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1');
    const result = names(out);
    expect(result).not.toContain('web_task');
    expect(result).not.toContain('web_identity_connect');
    expect(result).not.toContain('web_session_save');
    expect(result).toContain('web_session_list');
    expect(result).toContain('web_session_forget');
    expect(result).toContain('web_fetch_advanced');
    expect(result).toContain('web_extract');
  });

  it('withholds the pane tools when NO vendor can own a browser', async () => {
    // No pane-capable connector and the platform browser switched off for this
    // workspace. This is the case the assertion above used to cover, before
    // browserbase became a pane vendor.
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, openai: false, google: false });
    mockGetTenantConnectedWebVendors.mockResolvedValue(new Set(['webclaw', 'firecrawl', 'tavily', 'exa']));
    const out = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1');
    const result = names(out);
    expect(result).not.toContain('web_session_list');
    expect(result).not.toContain('web_session_forget');
  });

  it('gives the pane tools to an agent bound to nothing when the platform backs a browser', async () => {
    // The platform key makes the browser a product default: no connector, no
    // binding, still a browser. Gated only on the operator kill-switches.
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, openai: false, google: false });
    mockGetTenantConnectedWebVendors.mockResolvedValue(new Set());
    mockIsVendorExcludedForTenant.mockResolvedValue(false);
    const out = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1', {
      allowedConnectors: ['gmail'],
    });
    const result = names(out);
    expect(result).toContain('web_session_list');
    expect(result).toContain('web_session_close');
  });

  it('webclaw + firecrawl not connected AND every platform research key disabled removes web_research; web_diff drops with webclaw', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, perplexity: false, openai: false, google: false, tavily: false, exa: false });
    mockGetTenantConnectedWebVendors.mockResolvedValue(new Set(['anchor_browser', 'browserbase']));
    const out = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1');
    const result = names(out);
    expect(result).not.toContain('web_research');
    expect(result).not.toContain('web_diff');
    expect(result).toContain('web_task');
    expect(result).toContain('web_fetch_advanced');
  });

  it('firecrawl not connected but webclaw connected → web_research still exposed; web_diff exposed', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, perplexity: true, openai: false, google: false });
    mockGetTenantConnectedWebVendors.mockResolvedValue(new Set(['webclaw', 'anchor_browser', 'browserbase', 'tavily', 'exa']));
    const out = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1');
    expect(names(out)).toContain('web_research');
    expect(names(out)).toContain('web_diff');
  });

  it('webclaw not connected but firecrawl connected → web_research still exposed, web_diff dropped', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, perplexity: true, openai: false, google: false });
    mockGetTenantConnectedWebVendors.mockResolvedValue(new Set(['firecrawl', 'anchor_browser', 'browserbase', 'tavily', 'exa']));
    const out = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1');
    const result = names(out);
    expect(result).toContain('web_research');
    expect(result).not.toContain('web_diff');
  });

  it('all platform flags off + no BYOK connected removes every web tool', async () => {
    // tavily and exa are platform flags too: the platform's
    // own pay-as-you-go keys serve a workspace that connected neither.
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, perplexity: false, openai: false, google: false, tavily: false, exa: false });
    mockGetTenantConnectedWebVendors.mockResolvedValue(new Set());
    const out = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1');
    expect(out).toHaveLength(0);
  });

  it('passes non-web tools through unchanged', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, perplexity: false, openai: false, google: false });
    mockGetTenantConnectedWebVendors.mockResolvedValue(new Set());
    const out = await buildExposedStandardTools([NON_WEB_TOOL], 'tenant-1');
    expect(out).toEqual([NON_WEB_TOOL]);
  });

  it('exposes web_deep_research when perplexity enabled', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn });
    mockGetTenantConnectedWebVendors.mockResolvedValue(ALL_BYOK_CONNECTED);
    const tools = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1');
    expect(tools.map(t => t.name)).toContain('web_deep_research');
  });

  it('hides web_deep_research when perplexity disabled', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, perplexity: false, openai: false, google: false });
    mockGetTenantConnectedWebVendors.mockResolvedValue(ALL_BYOK_CONNECTED);
    const tools = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1');
    expect(tools.map(t => t.name)).not.toContain('web_deep_research');
  });

  it('exposes web_people_search when perplexity enabled', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn });
    mockGetTenantConnectedWebVendors.mockResolvedValue(ALL_BYOK_CONNECTED);
    const tools = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1');
    expect(tools.map(t => t.name)).toContain('web_people_search');
  });

  it('hides web_people_search when perplexity disabled', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, perplexity: false });
    mockGetTenantConnectedWebVendors.mockResolvedValue(ALL_BYOK_CONNECTED);
    const tools = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1');
    expect(tools.map(t => t.name)).not.toContain('web_people_search');
  });

  it('exposes web_finance_search when perplexity enabled', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn });
    mockGetTenantConnectedWebVendors.mockResolvedValue(ALL_BYOK_CONNECTED);
    const tools = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1');
    expect(tools.map(t => t.name)).toContain('web_finance_search');
  });

  it('hides web_finance_search when perplexity disabled', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, perplexity: false });
    mockGetTenantConnectedWebVendors.mockResolvedValue(ALL_BYOK_CONNECTED);
    const tools = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1');
    expect(tools.map(t => t.name)).not.toContain('web_finance_search');
  });

  it('web_research stays exposed when only perplexity is enabled', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, perplexity: true, openai: false, google: false });
    mockGetTenantConnectedWebVendors.mockResolvedValue(new Set());
    const tools = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1');
    expect(tools.map(t => t.name)).toContain('web_research');
  });

  it('web_extract NOT exposed when only perplexity is enabled (perplexity is not in the extract chain)', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, perplexity: true, openai: false, google: false });
    mockGetTenantConnectedWebVendors.mockResolvedValue(new Set());
    const tools = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1');
    expect(tools.map(t => t.name)).not.toContain('web_extract');
  });

  it('nothing connected and Perplexity off → the platform\'s pay-as-you-go Tavily and Exa still expose web_fetch_advanced + web_research', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, perplexity: false, openai: false, google: false, steel: false, browser_use: false });
    mockGetTenantConnectedWebVendors.mockResolvedValue(new Set());
    const result = names(await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1'));
    expect(result).toContain('web_fetch_advanced');
    expect(result).toContain('web_research');
    expect(result).not.toContain('web_extract');
    const off = names(await (async () => {
      mockGetAllVendorFlags.mockResolvedValue({ ...allOn, perplexity: false, openai: false, google: false, steel: false, browser_use: false, tavily: false, exa: false });
      return buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1');
    })());
    expect(off).not.toContain('web_fetch_advanced');
    expect(off).not.toContain('web_research');
  });

  it('the platform\'s Locus web rung exposes web_extract to a workspace with no extract key of its own, and web_search with Perplexity off', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, perplexity: false, openai: false, google: false, xai: false, locus_web: true });
    mockGetTenantConnectedWebVendors.mockResolvedValue(new Set());
    const withSearch = [...ALL_WEB_TOOLS, { name: 'web_search' }];
    const result = names(await buildExposedStandardTools(withSearch, 'tenant-1', { surface: 'run' }));
    expect(result).toContain('web_extract');
    expect(result).toContain('web_search');
    expect(result).toContain('web_fetch_advanced');
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, perplexity: false, openai: false, google: false, xai: false, locus_web: false, tavily: false, exa: false });
    const off = names(await buildExposedStandardTools(withSearch, 'tenant-1', { surface: 'run' }));
    expect(off).not.toContain('web_extract');
    expect(off).not.toContain('web_search');
  });

  it('only tavily connected → web_fetch_advanced + web_research stay; extract/task/diff/identity/people/finance/deep filtered', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, perplexity: false, openai: false, google: false });
    mockGetTenantConnectedWebVendors.mockResolvedValue(new Set(['tavily']));
    const tools = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1');
    const result = names(tools);
    expect(result).toContain('web_fetch_advanced');
    expect(result).toContain('web_research');
    expect(result).not.toContain('web_extract');
    expect(result).not.toContain('web_task');
    expect(result).not.toContain('web_diff');
    expect(result).not.toContain('web_identity_connect');
    expect(result).not.toContain('web_session_save');
    expect(result).not.toContain('web_people_search');
    expect(result).not.toContain('web_finance_search');
    expect(result).not.toContain('web_deep_research');
  });

  it('only exa connected → web_fetch_advanced + web_research stay; extract/task/diff/identity/people/finance/deep filtered', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, perplexity: false, openai: false, google: false });
    mockGetTenantConnectedWebVendors.mockResolvedValue(new Set(['exa']));
    const tools = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1');
    const result = names(tools);
    expect(result).toContain('web_fetch_advanced');
    expect(result).toContain('web_research');
    expect(result).not.toContain('web_extract');
    expect(result).not.toContain('web_task');
    expect(result).not.toContain('web_diff');
    expect(result).not.toContain('web_identity_connect');
    expect(result).not.toContain('web_session_save');
    expect(result).not.toContain('web_people_search');
    expect(result).not.toContain('web_finance_search');
    expect(result).not.toContain('web_deep_research');
  });

  it('only openai enabled → web_deep_research still exposed', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, perplexity: false, openai: true, google: false });
    mockGetTenantConnectedWebVendors.mockResolvedValue(new Set());
    const tools = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1');
    expect(tools.map(t => t.name)).toContain('web_deep_research');
  });

  it('only google enabled → web_deep_research still exposed', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, perplexity: false, openai: false, google: true });
    mockGetTenantConnectedWebVendors.mockResolvedValue(new Set());
    const tools = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1');
    expect(tools.map(t => t.name)).toContain('web_deep_research');
  });

  it('perplexity/openai/google all disabled → web_deep_research filtered out', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, perplexity: false, openai: false, google: false });
    mockGetTenantConnectedWebVendors.mockResolvedValue(ALL_BYOK_CONNECTED);
    const tools = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1');
    expect(tools.map(t => t.name)).not.toContain('web_deep_research');
  });

  it('no connectors connected → all BYOK-only tools filtered, platform-backed tools stay', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn });
    mockGetTenantConnectedWebVendors.mockResolvedValue(new Set());
    const out = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1');
    const result = names(out);
    // Platform-backed tools stay
    expect(result).toContain('web_fetch_advanced');
    expect(result).toContain('web_research');
    expect(result).toContain('web_people_search');
    expect(result).toContain('web_finance_search');
    expect(result).toContain('web_deep_research');
    // BYOK-only tools filtered
    expect(result).not.toContain('web_extract');
    expect(result).not.toContain('web_task');
    expect(result).not.toContain('web_diff');
    expect(result).not.toContain('web_identity_connect');
    expect(result).not.toContain('web_session_save');
  });

  it('only firecrawl connected → web_extract becomes available; web_task/diff still filtered', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn });
    mockGetTenantConnectedWebVendors.mockResolvedValue(new Set(['firecrawl']));
    const out = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1');
    const result = names(out);
    expect(result).toContain('web_extract');
    expect(result).not.toContain('web_task');
    expect(result).not.toContain('web_diff');
  });

  it('only anchor_browser connected → web_task/identity/session become available', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn });
    mockGetTenantConnectedWebVendors.mockResolvedValue(new Set(['anchor_browser']));
    const out = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1');
    const result = names(out);
    expect(result).toContain('web_task');
    expect(result).toContain('web_identity_connect');
    expect(result).toContain('web_session_save');
    expect(result).toContain('web_extract');     // anchor is also in extract chain
    expect(result).not.toContain('web_diff');    // diff needs webclaw
  });

  it('platform vendor flag off (perplexity disabled) → platform-backed tools filtered even with BYOK connected', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, perplexity: false });
    mockGetTenantConnectedWebVendors.mockResolvedValue(new Set(['firecrawl', 'tavily', 'exa']));
    const out = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1');
    const result = names(out);
    // web_research still exposed (firecrawl/tavily/exa back it)
    expect(result).toContain('web_research');
    // people/finance/deep need perplexity specifically — filtered when perplexity flag off
    expect(result).not.toContain('web_people_search');
    expect(result).not.toContain('web_finance_search');
    // web_deep_research can still go via openai/google if those flags on
  });

  // ── Per-agent binding gate (ctx.allowedConnectors) ──────────────────────
  // BYOK-exclusive tools (web_extract, web_diff, Anchor browser/session) require
  // the AGENT to be bound, not just the tenant connected. Native-backed tools
  // (research/fetch/search) stay tenant-level regardless of binding.
  describe('per-agent binding (ctx.allowedConnectors)', () => {
    it('tenant has anchor but agent NOT bound → Anchor tools hidden; native tools stay', async () => {
      mockGetAllVendorFlags.mockResolvedValue({ ...allOn });
      mockGetTenantConnectedWebVendors.mockResolvedValue(ALL_BYOK_CONNECTED);
      // Agent bound to an unrelated connector only.
      const out = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1', {
        allowedConnectors: ['slack'],
      });
      const result = names(out);
      expect(result).not.toContain('web_task');
      expect(result).not.toContain('web_identity_connect');
      expect(result).not.toContain('web_session_save');
      expect(result).not.toContain('web_session_close');
      // Native-backed tools are NOT gated by binding.
      expect(result).toContain('web_research');
      expect(result).toContain('web_fetch_advanced');
      expect(result).toContain('web_people_search');
    });

    it('tenant has all BYOK but agent bound to none → every BYOK-exclusive tool hidden, natives remain', async () => {
      mockGetAllVendorFlags.mockResolvedValue({ ...allOn });
      mockGetTenantConnectedWebVendors.mockResolvedValue(ALL_BYOK_CONNECTED);
      const out = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1', {
        allowedConnectors: [],
      });
      const result = names(out);
      expect(result).not.toContain('web_extract');
      expect(result).not.toContain('web_diff');
      expect(result).not.toContain('web_task');
      expect(result).not.toContain('web_identity_connect');
      expect(result).not.toContain('web_session_save');
      expect(result).not.toContain('web_session_close');
      expect(result).toContain('web_research');
      expect(result).toContain('web_fetch_advanced');
      expect(result).toContain('web_deep_research');
    });

    it('agent bound to anchor_browser → Anchor + extract tools exposed; web_diff still needs webclaw binding', async () => {
      mockGetAllVendorFlags.mockResolvedValue({ ...allOn });
      mockGetTenantConnectedWebVendors.mockResolvedValue(ALL_BYOK_CONNECTED);
      const out = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1', {
        allowedConnectors: ['anchor_browser'],
      });
      const result = names(out);
      expect(result).toContain('web_task');
      expect(result).toContain('web_identity_connect');
      expect(result).toContain('web_session_save');
      expect(result).toContain('web_session_close');
      expect(result).toContain('web_extract'); // anchor backs extract
      expect(result).not.toContain('web_diff'); // diff needs webclaw, not bound
    });

    it('agent bound to webclaw → web_diff + web_extract exposed; Anchor tools hidden', async () => {
      mockGetAllVendorFlags.mockResolvedValue({ ...allOn });
      mockGetTenantConnectedWebVendors.mockResolvedValue(ALL_BYOK_CONNECTED);
      const out = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1', {
        allowedConnectors: ['webclaw'],
      });
      const result = names(out);
      expect(result).toContain('web_diff');
      expect(result).toContain('web_extract');
      expect(result).not.toContain('web_task');
    });

    it('agent bound to anchor but tenant has NOT connected it → still hidden (binding needs an active connector)', async () => {
      mockGetAllVendorFlags.mockResolvedValue({ ...allOn });
      mockGetTenantConnectedWebVendors.mockResolvedValue(new Set(['webclaw']));
      const out = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1', {
        allowedConnectors: ['anchor_browser'],
      });
      const result = names(out);
      expect(result).not.toContain('web_task');
      expect(result).not.toContain('web_session_save');
    });

    it('undefined allowedConnectors → legacy tenant-level behavior (BYOK-exclusive tools follow tenant connection)', async () => {
      mockGetAllVendorFlags.mockResolvedValue({ ...allOn });
      mockGetTenantConnectedWebVendors.mockResolvedValue(ALL_BYOK_CONNECTED);
      const out = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1');
      const result = names(out);
      expect(result).toContain('web_task');
      expect(result).toContain('web_diff');
      expect(result).toContain('web_extract');
    });

    it('web_session_close is available on an ACTIVE session even when the agent is NOT anchor-bound (closing operates on an existing session, like read/run-task)', async () => {
      mockGetAllVendorFlags.mockResolvedValue({ ...allOn });
      mockGetTenantConnectedWebVendors.mockResolvedValue(ALL_BYOK_CONNECTED);
      const out = await buildExposedStandardTools(ALL_WEB_TOOLS, 'tenant-1', {
        allowedConnectors: ['slack'],     // agent NOT bound to anchor
        hasActiveBrowserSession: true,    // but there IS a session to close
      });
      const result = names(out);
      expect(result).toContain('web_session_close');   // closeable: a session exists
      expect(result).not.toContain('web_session_save'); // setup tool stays anchor-only
      expect(result).not.toContain('web_task');         // drive/spawn stays anchor-only
    });
  });
});

// The fine-grained pane tools act on an EXISTING session; the record read
// outlives the session, because a person may ask what they did in a browser
// that has since closed.
describe('buildExposedStandardTools — the pane tools and the record', () => {
  const PANE_TOOLS = [
    { name: 'read_browser_session_controls' },
    { name: 'act_in_browser_session' },
    { name: 'ask_person_to_take_over_browser_session' },
    { name: 'read_browser_session_activity' },
  ];

  it('offers the controls, the action and the request only on an active session', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn });
    const withSession = names(await buildExposedStandardTools(PANE_TOOLS, 'tenant-1', { hasActiveBrowserSession: true }));
    expect(withSession).toEqual(['act_in_browser_session', 'ask_person_to_take_over_browser_session', 'read_browser_session_activity', 'read_browser_session_controls']);
    const without = names(await buildExposedStandardTools(PANE_TOOLS, 'tenant-1', { hasActiveBrowserSession: false }));
    expect(without).toEqual([]);
  });

  it('offers the record read on a thread with a record and no session, and withholds it with neither', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn });
    const record = names(await buildExposedStandardTools(PANE_TOOLS, 'tenant-1', { hasActiveBrowserSession: false, threadHasBrowserRecord: true }));
    expect(record).toEqual(['read_browser_session_activity']);
    const neither = names(await buildExposedStandardTools(PANE_TOOLS, 'tenant-1', { hasActiveBrowserSession: false, threadHasBrowserRecord: false }));
    expect(neither).toEqual([]);
  });
});

// A run with no thread may own a browser of its own. The spawning tools were
// withheld from any run with nobody on the thread, which is every scheduled
// run: an automated team could not browse at all. They are offered on a run
// that says so, on the same vendor condition a person's thread needs.
describe('buildExposedStandardTools — a run with no thread', () => {
  const SPAWNERS = [
    { name: 'start_browser_session' },
    { name: 'navigate_browser_session' },
    { name: 'run_browser_task' },
  ];

  it('offers the spawning browser tools to an autonomous run the platform browser backs', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, openai: false, google: false });
    mockGetTenantConnectedWebVendors.mockResolvedValue(new Set());
    mockIsVendorExcludedForTenant.mockResolvedValue(false);
    const out = await buildExposedStandardTools(SPAWNERS, 'tenant-1', {
      allowedConnectors: ['gmail'],
      autonomousRun: true,
    });
    expect(names(out)).toEqual(['navigate_browser_session', 'run_browser_task', 'start_browser_session']);
  });

  it('still withholds them from a thread with nobody on it', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, openai: false, google: false });
    mockGetTenantConnectedWebVendors.mockResolvedValue(new Set());
    mockIsVendorExcludedForTenant.mockResolvedValue(false);
    const out = await buildExposedStandardTools(SPAWNERS, 'tenant-1', {
      allowedConnectors: ['gmail'],
      threadId: 'thread-1',
      autonomousRun: false,
    });
    // run_browser_task's own gate is unchanged: it is offered wherever a
    // session vendor serves the agent, and its handler refuses a thread with
    // nobody to spawn under. The two tools that only spawn are withheld.
    expect(names(out)).toEqual(['run_browser_task']);
  });

  it('withholds them from an autonomous run when no vendor can own a browser', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...allOn, openai: false, google: false });
    mockIsVendorExcludedForTenant.mockResolvedValue(true);
    mockGetTenantConnectedWebVendors.mockResolvedValue(new Set(['webclaw']));
    const out = await buildExposedStandardTools(SPAWNERS, 'tenant-1', {
      allowedConnectors: ['gmail'],
      autonomousRun: true,
    });
    expect(names(out)).toEqual([]);
  });
});
