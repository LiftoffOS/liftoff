// Asserts every overlay tool whose action is external-facing carries
// the 'outbound' categoryOverride, so the tenant-runtime catalog
// filter (mcp-server.ts) gates them under communication='draft' /
// 'review' policies.
//
// History: when the structural draft-mode catalog filter was added
// to tenant-runtime, an audit (v0.1.6) tagged 'outbound'
// on tools that were bypassing it. The google_ads
// (create_campaign / update_campaign_status) and quickbooks
// (send_credit_memo) cases originally pinned here were REMOVED from
// the overlays entirely by the full-toolkit regeneration ("regenerate
// all 89 toolkits with real Composio slugs" — googleads is now reads +
// customer lists only; quickbooks lost its send tools), so those
// assertions guarded nothing and failed on the missing lookups from
// that commit onward. What remains pins the live outbound set so a
// future overlay edit that drops 'outbound' fails CI instead of
// silently bypassing the catalog filter on tenant-runtime.

import { COMPOSIO_TOOL_OVERLAYS } from '../overlays';

function getOverlay(toolkit: string, stableName: string) {
  const overlays = COMPOSIO_TOOL_OVERLAYS[toolkit];
  if (!overlays) throw new Error(`toolkit '${toolkit}' not found in COMPOSIO_TOOL_OVERLAYS`);
  for (const [, overlay] of Object.entries(overlays)) {
    if (overlay.stableName === stableName) return overlay;
  }
  throw new Error(`${toolkit}.${stableName} not found in overlays`);
}

describe('outbound categoryOverrides coverage', () => {
  describe('regression baseline: known outbound overlays remain tagged', () => {
    const baseline: Array<[string, string]> = [
      ['gmail', 'send_email'],
      ['gmail', 'reply_to_thread'],
      ['outlook', 'send_message'],
      ['outlook', 'reply_to_message'],
      ['mailchimp', 'send_campaign'],
    ];
    for (const [toolkit, name] of baseline) {
      it(`${toolkit}.${name} retains 'outbound'`, () => {
        const o = getOverlay(toolkit, name);
        expect(o.categoryOverrides).toContain('outbound');
      });
    }
  });

  describe('internal collaboration surfaces are NOT outbound', () => {
    // Slack is internal team collaboration, not a customer/external channel.
    // Tagging send_message 'outbound' put an internal CI ping under the
    // workspace Communication policy; with communication='draft' the call was
    // denied at canUseTool with no draftVariant to fall back to (Slack has no
    // draft endpoint) — a request nobody could approve. This overlay is the
    // LIVE category source for composio-managed slack (the registry's
    // SLACK_FUNCTIONS array is dead code there), so pin the fix HERE.
    it("slack.send_message does NOT carry 'outbound'", () => {
      const o = getOverlay('slack', 'send_message');
      expect(o.categoryOverrides).not.toContain('outbound');
      expect(o.categoryOverrides).toContain('write');
    });
  });
});
