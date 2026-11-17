# OAuth credentials a deployment provides

54 connectors authenticate with an OAuth application that the
DEPLOYMENT owns. This file lists them.

## Why these are deployment-level, not per-workspace

`readStaticClientCreds` (`src/credentials/oauth-providers/common.ts`) reads
`process.env[<VENDOR>_CLIENT_ID]` and `_CLIENT_SECRET` at call time. Per-tenant
storage would be the wrong shape here: in a self-hosted deployment the operator
registers the OAuth application with the vendor and owns it, so the credential
belongs to the deployment the same way a database password does.

A vendor whose variables are unset is not broken, it is unavailable: the
connector appears in the catalogue and its connect flow refuses with a reason.
Nothing else degrades.

## You probably do not need most of this

Composio holds the client credentials for roughly 105 connectors. With a
`COMPOSIO_API_KEY` and one run of the bootstrap, those work without registering
anything of your own. Around 53 more take a user's own API key, and 35 register
themselves at the issuer through Dynamic Client Registration.

The table below is what remains: connectors that use OAuth and are not brokered
by Composio. Register only the ones you want.

## Secret Manager

The Terraform expects each pair as a secret named
`<vendor>-oauth-client-id-<env>` and `<vendor>-oauth-client-secret-<env>`,
mounted into the connector service as the environment variables above.

## The list

| Environment variables | Connector |
|---|---|
| `AHREFS_CLIENT_ID` / `AHREFS_CLIENT_SECRET` | `ahrefs` |
| `AMPLITUDE_CLIENT_ID` / `AMPLITUDE_CLIENT_SECRET` | `amplitude` |
| `ASANA_CLIENT_ID` / `ASANA_CLIENT_SECRET` | `asana` |
| `ATTIO_CLIENT_ID` / `ATTIO_CLIENT_SECRET` | `attio` |
| `BAMBOOHR_CLIENT_ID` / `BAMBOOHR_CLIENT_SECRET` | `bamboohr` |
| `BOX_CLIENT_ID` / `BOX_CLIENT_SECRET` | `box` |
| `CALENDLY_CLIENT_ID` / `CALENDLY_CLIENT_SECRET` | `calendly` |
| `CLAY_CLIENT_ID` / `CLAY_CLIENT_SECRET` | `clay` |
| `COMMON_ROOM_CLIENT_ID` / `COMMON_ROOM_CLIENT_SECRET` | `common_room` |
| `COUPLER_CLIENT_ID` / `COUPLER_CLIENT_SECRET` | `coupler` |
| `CROSSBEAM_CLIENT_ID` / `CROSSBEAM_CLIENT_SECRET` | `crossbeam` |
| `CRUSTDATA_CLIENT_ID` / `CRUSTDATA_CLIENT_SECRET` | `crustdata` |
| `DEMANDBASE_CLIENT_ID` / `DEMANDBASE_CLIENT_SECRET` | `demandbase` |
| `DOCUSIGN_CLIENT_ID` / `DOCUSIGN_CLIENT_SECRET` | `docusign` |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | `github` |
| `GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET` | `gitlab` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | `google` |
| `GRANOLA_CLIENT_ID` / `GRANOLA_CLIENT_SECRET` | `granola` |
| `GUSTO_CLIENT_ID` / `GUSTO_CLIENT_SECRET` | `gusto` |
| `HUBSPOT_CLIENT_ID` / `HUBSPOT_CLIENT_SECRET` | `hubspot` |
| `KEYWORDS_EVERYWHERE_CLIENT_ID` / `KEYWORDS_EVERYWHERE_CLIENT_SECRET` | `keywords_everywhere` |
| `KIT_CLIENT_ID` / `KIT_CLIENT_SECRET` | `kit` |
| `KLAVIYO_CLIENT_ID` / `KLAVIYO_CLIENT_SECRET` | `klaviyo` |
| `LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET` | `linear` |
| `LIVESTORM_CLIENT_ID` / `LIVESTORM_CLIENT_SECRET` | `livestorm` |
| `MARKETO_CLIENT_ID` / `MARKETO_CLIENT_SECRET` | `marketo` |
| `MESH_CLIENT_ID` / `MESH_CLIENT_SECRET` | `mesh` |
| `META_CLIENT_ID` / `META_CLIENT_SECRET` | `meta` |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | `microsoft` |
| `NOTION_CLIENT_ID` / `NOTION_CLIENT_SECRET` | `notion` |
| `OMNISEND_CLIENT_ID` / `OMNISEND_CLIENT_SECRET` | `omnisend` |
| `OUTREACH_CLIENT_ID` / `OUTREACH_CLIENT_SECRET` | `outreach` |
| `PADDLE_CLIENT_ID` / `PADDLE_CLIENT_SECRET` | `paddle` |
| `PANDADOC_CLIENT_ID` / `PANDADOC_CLIENT_SECRET` | `pandadoc` |
| `PARTNERSTACK_CLIENT_ID` / `PARTNERSTACK_CLIENT_SECRET` | `partnerstack` |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | `paypal` |
| `PENDO_CLIENT_ID` / `PENDO_CLIENT_SECRET` | `pendo` |
| `RIPPLING_CLIENT_ID` / `RIPPLING_CLIENT_SECRET` | `rippling` |
| `SALESFORCE_CLIENT_ID` / `SALESFORCE_CLIENT_SECRET` | `salesforce` |
| `SALESLOFT_CLIENT_ID` / `SALESLOFT_CLIENT_SECRET` | `salesloft` |
| `SIMILARWEB_CLIENT_ID` / `SIMILARWEB_CLIENT_SECRET` | `similarweb` |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | `slack` |
| `SNOV_CLIENT_ID` / `SNOV_CLIENT_SECRET` | `snov` |
| `SPARKTORO_CLIENT_ID` / `SPARKTORO_CLIENT_SECRET` | `sparktoro` |
| `STRIPE_CONNECT_CLIENT_ID` / `STRIPE_CONNECT_CLIENT_SECRET` | `stripe_connect` |
| `STRIPE_MCP_CLIENT_ID` / `STRIPE_MCP_CLIENT_SECRET` | `stripe_mcp` |
| `SUPERMETRICS_CLIENT_ID` / `SUPERMETRICS_CLIENT_SECRET` | `supermetrics` |
| `TAPFILIATE_CLIENT_ID` / `TAPFILIATE_CLIENT_SECRET` | `tapfiliate` |
| `TYPEFULLY_CLIENT_ID` / `TYPEFULLY_CLIENT_SECRET` | `typefully` |
| `WEBFLOW_CLIENT_ID` / `WEBFLOW_CLIENT_SECRET` | `webflow` |
| `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` | `xero` |
| `ZENDESK_CLIENT_ID` / `ZENDESK_CLIENT_SECRET` | `zendesk` |
| `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET` | `zoom` |
| `ZOOMINFO_CLIENT_ID` / `ZOOMINFO_CLIENT_SECRET` | `zoominfo` |

## Redirect URI

Every one of these needs the same callback registered with the vendor:

```
https://<your-connector-service-host>/oauth/callback/<connector>
```

There is no Liftoff-owned domain in that URL. A deployment that has not set its
own public host cannot complete an OAuth flow, which is the intended failure.

---

*Generated from `src/catalog/connectors.ts`. Regenerate rather than edit: the
variables are read from the catalogue, so a hand-maintained copy drifts the
first time a connector is added.*
