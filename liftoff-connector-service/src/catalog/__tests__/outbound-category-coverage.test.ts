// Asserts every connector function whose action is external-facing
// carries the 'outbound' category, so the tenant-runtime catalog
// filter (mcp-server.ts) gates them under communication='draft' /
// 'review' policies.
//
// Why: the structural draft-mode catalog filter in tenant-runtime
// only gates tools tagged 'outbound', and several connector tools
// whose action is outbound were tagged only ['write']:
//   - atlassian_jira.add_comment — visible to project members + external
//     watchers in customer-portal mode; the Composio overlay had the
//     correct tag, the native registry didn't.
//   - zendesk.add_comment — defaults to public=true (customer-facing
//     reply); the native registry now tags it 'outbound' so the catalog
//     filter wraps it with HitlGateError under draft policy regardless
//     of intent.
//
// Two connectors are intentionally NOT asserted here despite their
// outbound-category edits in the same commit, because of a latent
// plumbing bug surfaced by this audit:
//
//   - google_ads: connectors.ts wires toolkitSlug='googleads' but the
//     Composio overlay + schema indexes use key 'google_ads' (matching
//     the GOOGLE_ADS_* tool-slug prefix).
//   - atlassian_jira: connectors.ts wires toolkitSlug='jira' and the
//     overlays index key is 'jira' (matches), but the SCHEMAS index
//     key is 'atlassian_jira' (matches connector type, not slug).
//
// In both cases buildComposioFunctions looks up schemas/overlays by
// toolkitSlug, so the mismatched index entry resolves to [] and the
// connector ships zero tools at runtime. The native registry + overlay
// edits for these connectors in this commit are defensive scaffolding
// for the day someone reconciles the slug-vs-index keys (which needs
// Composio-API verification of the real slug Composio expects before
// renaming either side). When that lands, add the google_ads and
// atlassian_jira cases back here.
//
// This test pins the post-fix categories so a future edit that drops
// 'outbound' fails CI instead of silently bypassing the catalog
// filter on tenant-runtime.

import { getConnectorFunctions } from '../connector-functions-registry.js';

function findFn(connectorType: string, name: string) {
  const fns = getConnectorFunctions(connectorType);
  const fn = fns.find((f) => f.name === name);
  if (!fn) throw new Error(`${connectorType}.${name} not found in registry`);
  return fn;
}

describe('outbound category coverage', () => {
  describe('zendesk', () => {
    it("add_comment carries 'outbound' — defaults to public=true (customer-facing)", () => {
      const fn = findFn('zendesk', 'add_comment');
      expect(fn.categories).toContain('outbound');
    });
  });

  describe('regression baseline: existing outbound tools remain tagged', () => {
    // Names are the post-Composio-merge stableName for composio_managed
    // connectors (gmail/outlook/slack route through overlays/{gmail,outlook,
    // slack}.ts in @liftoffos/composio-overlays — the overlay is the LIVE
    // category source; the manual *_FUNCTIONS arrays in
    // connector-functions-registry.ts are dead code for composio_managed
    // types). For native connectors (sendgrid here) it's the function name
    // declared in connector-functions-registry.ts.
    const baseline: Array<[string, string]> = [
      ['google_mail', 'send_email'],
      ['google_mail', 'reply_to_thread'],
      ['microsoft_outlook_mail', 'send_message'],
      ['microsoft_outlook_mail', 'reply_to_message'],
      ['sendgrid', 'send_email'],
    ];
    for (const [connectorType, fnName] of baseline) {
      it(`${connectorType}.${fnName} retains 'outbound'`, () => {
        const fn = findFn(connectorType, fnName);
        expect(fn.categories).toContain('outbound');
      });
    }
  });

  describe('internal collaboration surfaces are NOT outbound', () => {
    // Slack is internal team collaboration, not a customer/external channel.
    // The 'outbound' tag put a post to an internal channel like #ci-alerts
    // under the workspace Communication policy; with communication='draft'
    // the call was denied at canUseTool with no draftVariant to fall back to
    // (Slack has no draft endpoint) — a request nobody could approve. The
    // fix lives in the slack OVERLAY (@liftoffos/composio-overlays), because
    // slack is composio_managed and getConnectorFunctions serves the
    // overlay-built set — this asserts what the registry actually SERVES.
    //
    // Teams (mcp.kind='sidecar', native) was retagged directly in
    // connector-functions-registry.ts for the same reason.
    for (const [connectorType, fnName] of [
      ['slack', 'send_message'],
      ['microsoft_teams', 'send_message'],
    ] as Array<[string, string]>) {
      it(`${connectorType}.${fnName} does NOT carry 'outbound'`, () => {
        const fn = findFn(connectorType, fnName);
        expect(fn.categories).not.toContain('outbound');
        expect(fn.categories).toContain('write');
      });
    }
  });
});
