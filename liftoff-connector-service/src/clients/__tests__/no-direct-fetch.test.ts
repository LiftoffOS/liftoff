// No NEW connector client may call fetch() directly.
//
// The transport decision — "does this connector's token go out as a bearer, or
// does Composio hold it and sign the call?" — used to live at every call site.
// Most clients had their own `fetch(` sites and never imported the Composio
// helper at all. Getting it wrong is silent: a composio_managed connector's
// `accessToken` is deliberately `''`, so the client sends
// `Authorization: Bearer ` and the vendor answers 401 — indistinguishable from
// an expired grant. A poller can do that indefinitely while its Composio
// account is healthy and the UI says Connected.
//
// Fixing the defect per call site only ever covers the call sites touched. `makeConnectorTransport` takes the
// decision once; a client handed a transport cannot get it wrong because it
// never sees a token.
//
// THIS IS A RATCHET, NOT A BAN. The list below is the debt that existed when
// the transport landed: those clients keep their direct `fetch` until they are
// migrated, and the list may only ever SHRINK. A new client — or a new method
// on an old one — that reaches for `fetch` fails here and is told to use the
// transport instead. Without this the migration decays, because the next person
// writing a client copies one of the 61 that still fetch directly.
//
// TO MIGRATE ONE: route its `request()` through `makeConnectorTransport`, delete
// its `tryComposioProxy` preamble, remove it from this list. See google-mail.ts
// and google-calendar.ts, which were migrated first because they were the ones
// that broke.
//
// KNOWN HARD CASES, deliberately still on the list:
//   jira, confluence  — Composio templates their base URL with a per-account
//                       subdomain it fills server-side, so the client cannot
//                       build the absolute URL the transport requires. Needs a
//                       base-relative mode on ConnectorRequest first.
//   binary paths      — downloads/uploads move bytes, which the proxy cannot
//                       carry (see commit 277f305). These stay direct, and for a
//                       composio_managed connector they legitimately cannot
//                       work; `bearerFor()` makes that say so rather than 401.
//
// WHEN THIS LIST IS EMPTY: `bearerFor` and `MissingBearerTokenError` in
// composio-transport.ts are scaffolding for a migration that is finished, and
// should be deleted along with this baseline.

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const CLIENT_DIR = join(__dirname, '..');

/** Clients that still take the transport decision themselves. May only shrink. */
const DIRECT_FETCH_BASELINE = new Set([
  'asana.ts',
  'attio.ts',
  'bamboohr.ts',
  'bigquery-provisioning.ts',
  'bigquery.ts',
  'box.ts',
  'cal-com.ts',
  'calendly.ts',
  'confluence.ts',
  'databricks-mcp.ts',
  'dayforce.ts',
  'deel.ts',
  'docusign.ts',
  'dropbox.ts',
  'elicit.ts',
  'factorial.ts',
  'gitlab.ts',
  'google-ads.ts',
  'google-docs.ts',
  'google-drive.ts',
  'google-sheets.ts',
  'google-slides.ts',
  'google-youtube.ts',
  'gusto.ts',
  'hibob.ts',
  'hubspot-write.ts',
  'intercom-mcp.ts',
  'intercom-write.ts',
  'jira.ts',
  'linear.ts',
  'mailchimp.ts',
  'microsoft-contacts.ts',
  'microsoft-onedrive.ts',
  'microsoft-onenote.ts',
  'microsoft-outlook-calendar.ts',
  'microsoft-outlook-mail.ts',
  'microsoft-planner.ts',
  'microsoft-sharepoint.ts',
  'microsoft-teams.ts',
  'microsoft-todo.ts',
  'namely.ts',
  'oracle-hcm.ts',
  'paypal.ts',
  'personio.ts',
  'pipedrive.ts',
  'plaid.ts',
  'rippling.ts',
  'salesforce.ts',
  'sap-successfactors.ts',
  'sendgrid.ts',
  'sentry.ts',
  'slack.ts',
  'square.ts',
  'trello.ts',
  'ukg-pro.ts',
  'ukg-ready.ts',
  'warp.ts',
  'woocommerce.ts',
  'workday.ts',
  'zendesk.ts',
  'zoom.ts',
]);

function clientsCallingFetchDirectly(): string[] {
  return readdirSync(CLIENT_DIR)
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.') && f !== 'connector-transport.ts')
    .filter((f) => /await fetch\(/.test(readFileSync(join(CLIENT_DIR, f), 'utf8')))
    .sort();
}

describe('connector clients use the shared transport', () => {
  const offenders = clientsCallingFetchDirectly();

  it('no client outside the frozen baseline calls fetch directly', () => {
    const added = offenders.filter((f) => !DIRECT_FETCH_BASELINE.has(f));
    expect({ newDirectFetchClients: added }).toEqual({ newDirectFetchClients: [] });
  });

  it('the baseline contains no client that has already been migrated', () => {
    // Keeps the ratchet honest in the other direction: a migrated client left
    // in the list would let a future one silently reintroduce `fetch`.
    const stale = [...DIRECT_FETCH_BASELINE].filter((f) => !offenders.includes(f)).sort();
    expect({ staleBaselineEntries: stale }).toEqual({ staleBaselineEntries: [] });
  });

  it('the two clients that broke are migrated and stay migrated', () => {
    expect(offenders).not.toContain('google-mail.ts');
    expect(offenders).not.toContain('google-calendar.ts');
  });
});
