# Connector Catalog

> Auto-generated from [`src/catalog/connectors.ts`](../src/catalog/connectors.ts).
> Do not edit by hand — regenerate with `npm run gen:connector-docs`.

**Catalog version**: `v3f98bab2`

**Totals**: 226 connectors · 191 available · 23 coming soon

## Auth kinds

| Auth kind | Count | Notes |
|---|---:|---|
| static_oauth | 81 | Provider-registered OAuth app (client id/secret from Secret Manager). |
| dcr_oauth | 35 | RFC 7591 dynamic client registration via `.well-known` discovery. |
| api_key | 106 | User-supplied API key stored in Secret Manager. |
| keypair | 1 | Asymmetric keypair auth (e.g. Snowflake RSA). |
| iam_grant | 1 | Keyless per-tenant SA impersonation + customer IAM grant (e.g. BigQuery). |
| custom_mcp | 1 | Tenant-registered MCP server; credentials stored per instance. |
| custom_api | 1 | An API a workspace described and connected from a conversation; the key is entered on a hosted capture page and the operations come from the provider's own OpenAPI specification. |

## MCP kinds

| MCP kind | Count | Notes |
|---|---:|---|
| vendor_hosted | 45 | Vendor operates the MCP server; we connect over SSE or Streamable HTTP. |
| sidecar | 34 | We operate an in-repo MCP sidecar fronting the vendor REST API. |
| composio_managed | 105 | Composio hosts the MCP server; tenant-runtime dispatches directly. |
| (none) | 41 | Pure REST connector with no MCP surface. |

## Accounting

| Type | Display name | Status | Auth | MCP | Capabilities |
|---|---|---|---|---|---|
| `freshbooks` | FreshBooks | ✅ available | static_oauth (0 scopes) | composio_managed · `freshbooks` | accounting |
| `quickbooks` | QuickBooks Online | ✅ available | static_oauth (0 scopes) | composio_managed · `quickbooks` | accounting |
| `xero` | Xero | ⏳ coming_soon — Composio does not operate managed credentials for Xero (the Composio API rejects use_composio_managed_auth). To enable: register a Xero OAuth app at developer.xero.com and plug it into Composio as use_custom_auth. 25-org cap until Xero certification. | static_oauth (3 scopes, PKCE) | vendor_hosted · sse | accounting |
| `zoho_books` | Zoho Books | ✅ available | static_oauth (0 scopes) | composio_managed · `zoho_books` | accounting |
| `zoho_invoice` | Zoho Invoice | ✅ available | static_oauth (0 scopes) | composio_managed · `zoho_invoice` | accounting |

## CRM & Sales

| Type | Display name | Status | Auth | MCP | Capabilities |
|---|---|---|---|---|---|
| `apollo` | Apollo.io | ✅ available | api_key | composio_managed · `apollo` | crm, enrichment |
| `attio` | Attio | ✅ available | dcr_oauth (discovery: mcp.attio.com) | vendor_hosted · streamable-http | crm |
| `clay` | Clay | ✅ available | dcr_oauth (discovery: api.clay.com) | vendor_hosted · streamable-http | crm, enrichment |
| `close` | Close | ✅ available | api_key | composio_managed · `close` | crm |
| `common_room` | Common Room | ⏳ coming_soon — Common Room has no self-serve signup — access is sales-gated; validation requires a sales-provisioned account. | dcr_oauth (discovery: mcp.commonroom.io) | vendor_hosted · streamable-http | crm |
| `contactout` | ContactOut | ✅ available | api_key | — | enrichment |
| `crustdata` | Crustdata | ✅ available | dcr_oauth (discovery: install.crustdata.com) | vendor_hosted · streamable-http | enrichment |
| `demandbase` | Demandbase | ⏳ coming_soon — Demandbase MCP requires Demandbase Support to allowlist the OAuth redirect URI per client id and to enable MCP on the tenant. | dcr_oauth (discovery: gateway.demandbase.com) | vendor_hosted · streamable-http | crm, enrichment |
| `folk` | Folk | ✅ available | api_key | composio_managed · `folk` | crm |
| `follow_up_boss` | Follow Up Boss | ✅ available | api_key | composio_managed · `follow_up_boss` | crm |
| `gong` | Gong | ✅ available | static_oauth (0 scopes) | composio_managed · `gong` | conversation_intelligence |
| `hubspot` | HubSpot | ✅ available | static_oauth (2 scopes, PKCE) | vendor_hosted · sse | crm, email_marketing |
| `hunterio` | Hunter | ✅ available | api_key | — | enrichment |
| `mesh` | Mesh | ✅ available | dcr_oauth (discovery: mcp.clay.earth) | vendor_hosted · streamable-http | crm |
| `microsoft_dynamics` | Microsoft Dynamics 365 | ✅ available | static_oauth (0 scopes) | composio_managed · `dynamics365` | crm |
| `outreach` | Outreach | ⏳ coming_soon — First-party MCP + DCR is fully wired (authorize URL + DCR registration supported); pending end-to-end validation against an Outreach account. | dcr_oauth (discovery: api.outreach.io) | vendor_hosted · streamable-http | crm |
| `pipedrive` | Pipedrive | ✅ available | api_key | composio_managed · `pipedrive` | crm |
| `salesforce` | Salesforce CRM | ✅ available | static_oauth (0 scopes) | composio_managed · `salesforce` | crm |
| `salesloft` | Salesloft | ⏳ coming_soon — Salesloft MCP dynamic client registration rejects OAuth callback domains it has not allowlisted: the registration endpoint returns invalid_redirect_uri "redirect_uris must belong to an allowed domain". Requires Salesloft to allowlist the OAuth callback domain of this deployment. | dcr_oauth (discovery: mcp.salesloft.com) | vendor_hosted · streamable-http | crm |
| `snov` | Snov.io | ✅ available | dcr_oauth (discovery: mcp.snov.io) | vendor_hosted · streamable-http | enrichment |
| `zoho` | Zoho CRM | ✅ available | static_oauth (0 scopes) | composio_managed · `zoho` | crm |
| `zoho_bigin` | Zoho Bigin | ✅ available | static_oauth (0 scopes) | composio_managed · `zoho_bigin` | crm |
| `zoominfo` | ZoomInfo | ⏳ coming_soon — ZoomInfo gates MCP OAuth behind an approved-vendor allowlist (client_name + redirect_uri must be whitelisted by ZoomInfo; open DCR returns "vendor not found"). Requires ZoomInfo vendor/partner onboarding for Liftoff. | dcr_oauth (discovery: mcp.zoominfo.com) | vendor_hosted · streamable-http | crm |

## Customer Support

| Type | Display name | Status | Auth | MCP | Capabilities |
|---|---|---|---|---|---|
| `freshdesk` | Freshdesk | ✅ available | api_key | composio_managed · `freshdesk` | support_helpdesk, support_ticketing |
| `intercom` | Intercom | ✅ available | static_oauth (0 scopes) | composio_managed · `intercom` | support_ticketing, support_helpdesk, email_marketing |
| `zendesk` | Zendesk | ✅ available | static_oauth (4 scopes) | sidecar · `/zendesk` | support_ticketing, support_helpdesk |
| `zoho_desk` | Zoho Desk | ✅ available | static_oauth (0 scopes) | composio_managed · `zoho_desk` | support_ticketing, support_helpdesk |

## Data & Analytics

| Type | Display name | Status | Auth | MCP | Capabilities |
|---|---|---|---|---|---|
| `airtable` | Airtable | ✅ available | static_oauth (0 scopes) | composio_managed · `airtable` | data_table |
| `alibaba` | Alibaba Model Studio | ⚠️  deprecated | api_key | — | media_generation |
| `amplitude` | Amplitude | ✅ available | dcr_oauth (discovery: mcp.amplitude.com) | vendor_hosted · streamable-http | product_analytics |
| `browserbase_x402` | Browserbase x402 | ⚠️  deprecated | api_key | — | browser_automation |
| `bytedance` | BytePlus ModelArk | ⚠️  deprecated | api_key | — | media_generation |
| `coupler` | Coupler.io | ⏳ coming_soon — Coupler.io MCP dynamic client registration rejects the OAuth callback: the registration endpoint returns invalid_redirect_uri "Redirect uri is invalid". Requires Coupler.io to allowlist the Liftoff callback URI. | dcr_oauth (discovery: mcp.coupler.io) | vendor_hosted · streamable-http | — |
| `crunchbase` | Crunchbase | ✅ available | api_key | — | enrichment |
| `databricks` | Databricks | ✅ available | api_key | vendor_hosted · streamable-http (resolver: `databricks_workspace`) | data_warehouse |
| `gloria` | Gloria | ✅ available | api_key | — | news_monitoring |
| `google_analytics` | Google Analytics | ✅ available | static_oauth (0 scopes) | composio_managed · `google_analytics` | web_analytics |
| `google_bigquery` | BigQuery | ✅ available | iam_grant (keyless per-tenant SA) | — | — |
| `google_firestore` | Firestore | ✅ available | static_oauth (3 scopes) | — | — |
| `google_trends` | Google Trends | ⚠️  deprecated | api_key | — | market_data |
| `kadec0` | kadec0 | ⚠️  deprecated | api_key | — | web_research |
| `locus` | Locus | ⚠️  deprecated | api_key | — | enrichment |
| `minimax` | MiniMax | ⚠️  deprecated | api_key | — | media_generation |
| `mixpanel` | Mixpanel | ✅ available | api_key | composio_managed · `mixpanel` | product_analytics |
| `pdl` | People Data Labs | ✅ available | api_key | — | enrichment |
| `pendo` | Pendo | ✅ available | dcr_oauth (discovery: app.pendo.io) | vendor_hosted · streamable-http | product_analytics |
| `plausible` | Plausible Analytics | ✅ available | api_key | composio_managed · `plausible_analytics` | web_analytics |
| `posthog` | PostHog | ✅ available | api_key | composio_managed · `posthog` | product_analytics |
| `snowflake` | Snowflake | ✅ available | keypair | vendor_hosted · streamable-http (resolver: `snowflake_account`) | data_warehouse |
| `strale` | Strale | ✅ available | api_key | — | compliance_checks, company_intelligence |
| `supabase` | Supabase | ✅ available | api_key | composio_managed · `supabase` | data_warehouse |
| `vaaya` | Vaaya | ⚠️  deprecated | api_key | — | enrichment, web_research |
| `ycombinator` | Y Combinator | ⚠️  deprecated | api_key | — | enrichment |

## E-Commerce

| Type | Display name | Status | Auth | MCP | Capabilities |
|---|---|---|---|---|---|
| `gumroad` | Gumroad | ✅ available | static_oauth (0 scopes) | composio_managed · `gumroad` | e_commerce |
| `shopify` | Shopify | ✅ available | api_key | composio_managed · `shopify` | e_commerce |
| `woocommerce` | WooCommerce | ✅ available | api_key | sidecar · `/woocommerce` | e_commerce |
| `zoho_inventory` | Zoho Inventory | ✅ available | static_oauth (0 scopes) | composio_managed · `zoho_inventory` | e_commerce |

## Engineering

| Type | Display name | Status | Auth | MCP | Capabilities |
|---|---|---|---|---|---|
| `bitbucket` | Bitbucket | ✅ available | static_oauth (0 scopes) | composio_managed · `bitbucket` | engineering |
| `buildkite` | Buildkite | ✅ available | api_key | composio_managed · `buildkite` | — |
| `codacy` | Codacy | ✅ available | api_key | composio_managed · `codacy` | — |
| `github` | GitHub | ✅ available | static_oauth (4 scopes) | vendor_hosted · streamable-http | version_control |
| `gitlab` | GitLab | ✅ available | static_oauth (4 scopes) | — | version_control |
| `linear` | Linear | ✅ available | dcr_oauth (discovery: mcp.linear.app) | vendor_hosted · streamable-http | project_management |
| `northflank` | Northflank | ✅ available | api_key | composio_managed · `northflank` | — |

## Finance & Payments

| Type | Display name | Status | Auth | MCP | Capabilities |
|---|---|---|---|---|---|
| `defillama` | DefiLlama | ⚠️  deprecated | api_key | — | market_data |
| `lemon_squeezy` | Lemon Squeezy | ✅ available | api_key | composio_managed · `lemon_squeezy` | e_commerce |
| `nasdaq` | Nasdaq | ⚠️  deprecated | api_key | — | market_data |
| `paddle` | Paddle | ✅ available | dcr_oauth (discovery: mcp.paddle.com) | vendor_hosted · streamable-http | e_commerce |
| `paypal` | PayPal | ✅ available | dcr_oauth (discovery: mcp.paypal.com) | vendor_hosted · sse | — |
| `plaid` | Plaid | ⏳ coming_soon — Plaid partner program approval required (plaid.com/partners) | api_key | sidecar · `/plaid` | — |
| `square` | Square | ✅ available | static_oauth (0 scopes) | composio_managed · `square` | e_commerce |
| `stripe` | Stripe | ✅ available | dcr_oauth (discovery: mcp.stripe.com) | vendor_hosted · sse | — |

## HR & Payroll

| Type | Display name | Status | Auth | MCP | Capabilities |
|---|---|---|---|---|---|
| `adp_run` | ADP RUN | ✅ available | api_key | sidecar · `/adp_run` | hris |
| `adp_workforce_now` | ADP Workforce Now | ✅ available | api_key | sidecar · `/adp_workforce_now` | hris |
| `ashby` | Ashby | ✅ available | api_key | composio_managed · `ashby` | ats |
| `bamboohr` | BambooHR | ✅ available | static_oauth (193 scopes) | sidecar · `/bamboohr` | hris |
| `dayforce` | Dayforce | ✅ available | api_key | sidecar · `/dayforce` | hris |
| `deel` | Deel | ✅ available | api_key | sidecar · `/deel` | hris |
| `factorial` | Factorial | ✅ available | api_key | sidecar · `/factorial` | hris |
| `greenhouse` | Greenhouse | ✅ available | static_oauth (0 scopes) | composio_managed · `greenhouse` | ats |
| `gusto` | Gusto | ✅ available | static_oauth (10 scopes) | sidecar · `/gusto` | hris |
| `hibob` | HiBob | ✅ available | api_key | sidecar · `/hibob` | hris |
| `justworks` | Justworks | ⏳ coming_soon — Native in-house HRIS integration pending | api_key | — | hris |
| `lever` | Lever | ✅ available | api_key | composio_managed · `lever` | ats |
| `namely` | Namely | ✅ available | api_key | sidecar · `/namely` | hris |
| `oracle_hcm` | Oracle Cloud HCM | ✅ available | api_key | sidecar · `/oracle_hcm` | hris |
| `paychex` | Paychex | ⏳ coming_soon — Native in-house HRIS integration pending | api_key | — | hris |
| `paycor` | Paycor | ⏳ coming_soon — Native in-house HRIS integration pending | api_key | — | hris |
| `paylocity` | Paylocity | ⏳ coming_soon — Native in-house HRIS integration pending | api_key | — | hris |
| `personio` | Personio | ✅ available | api_key | sidecar · `/personio` | hris |
| `rippling` | Rippling | ✅ available | static_oauth (2 scopes) | sidecar · `/rippling` | hris |
| `sap_successfactors` | SAP SuccessFactors | ✅ available | api_key | sidecar · `/sap_successfactors` | hris |
| `ukg_pro` | UKG Pro | ✅ available | api_key | sidecar · `/ukg_pro` | hris |
| `ukg_ready` | UKG Ready | ✅ available | api_key | sidecar · `/ukg_ready` | hris |
| `warp` | Warp | ✅ available | api_key | sidecar · `/warp` | hris |
| `workable` | Workable | ✅ available | api_key | composio_managed · `workable` | ats |
| `workday` | Workday | ✅ available | api_key | sidecar · `/workday` | hris |
| `zenefits` | Zenefits | ⏳ coming_soon — Native in-house HRIS integration pending | api_key | — | hris |
| `zoho_people` | Zoho People | ⏳ coming_soon — Native in-house HRIS integration pending | api_key | — | hris |

## Infrastructure

| Type | Display name | Status | Auth | MCP | Capabilities |
|---|---|---|---|---|---|
| `custom_api_connector` | Custom API | ✅ available | custom_api | — | — |
| `custom_mcp_server` | MCP Server | ✅ available | custom_mcp | sidecar · `undefined` | — |

## Knowledge

| Type | Display name | Status | Auth | MCP | Capabilities |
|---|---|---|---|---|---|
| `atlassian_confluence` | Atlassian Confluence | ✅ available | static_oauth (0 scopes) | composio_managed · `confluence` | — |
| `coda` | Coda | ✅ available | api_key | composio_managed · `coda` | documents, data_table |
| `dovetail` | Dovetail | ✅ available | api_key | composio_managed · `dovetail` | — |
| `elicit` | Elicit | ✅ available | api_key | sidecar · `/elicit` | web_research |
| `mem` | Mem | ✅ available | api_key | composio_managed · `mem` | — |
| `microsoft_onenote` | Microsoft OneNote | ✅ available | static_oauth (2 scopes) | sidecar · `/microsoft/onenote` | documents |
| `microsoft_sharepoint` | Microsoft SharePoint | ✅ available | static_oauth (2 scopes) | sidecar · `/microsoft/sharepoint` | cloud_storage |
| `notion` | Notion | ✅ available | dcr_oauth (discovery: mcp.notion.com) | vendor_hosted · streamable-http | documents, data_table |

## Marketing

| Type | Display name | Status | Auth | MCP | Capabilities |
|---|---|---|---|---|---|
| `activecampaign` | ActiveCampaign | ✅ available | api_key | composio_managed · `active_campaign` | email_marketing |
| `ahrefs` | Ahrefs | ⏳ coming_soon — Requires a paid Ahrefs subscription for API/MCP access; pending end-to-end validation with a paid account. | dcr_oauth (discovery: api.ahrefs.com) | vendor_hosted · streamable-http | — |
| `brevo` | Brevo | ✅ available | api_key | composio_managed · `brevo` | email_marketing |
| `clicksend` | ClickSend | ✅ available | api_key | composio_managed · `clicksend` | — |
| `crossbeam` | Crossbeam | ✅ available | dcr_oauth (discovery: mcp.crossbeam.com) | vendor_hosted · streamable-http | partner_management |
| `dataforseo` | DataForSEO | ✅ available | api_key | composio_managed · `dataforseo` | seo |
| `google_ads` | Google Ads | ✅ available | static_oauth (0 scopes) | composio_managed · `googleads` | advertising |
| `google_search_console` | Google Search Console | ✅ available | static_oauth (0 scopes) | composio_managed · `google_search_console` | seo |
| `instantly` | Instantly | ✅ available | api_key | composio_managed · `instantly` | email_marketing |
| `keywords_everywhere` | Keywords Everywhere | ✅ available | dcr_oauth (discovery: mcp.keywordseverywhere.com) | vendor_hosted · streamable-http | seo |
| `kit` | Kit | ✅ available | dcr_oauth (discovery: app.kit.com) | vendor_hosted · streamable-http | email_marketing |
| `klaviyo` | Klaviyo | ✅ available | dcr_oauth (discovery: mcp.klaviyo.com) | vendor_hosted · streamable-http | email_marketing |
| `lemlist` | Lemlist | ✅ available | api_key | composio_managed · `lemlist` | email_marketing |
| `livestorm` | Livestorm | ✅ available | dcr_oauth (discovery: mcp.livestorm.co) | vendor_hosted · streamable-http | — |
| `loops` | Loops | ✅ available | api_key | composio_managed · `loops_so` | email_marketing |
| `mailchimp` | Mailchimp | ✅ available | static_oauth (0 scopes) | composio_managed · `mailchimp` | email_marketing |
| `mailerlite` | MailerLite | ✅ available | api_key | composio_managed · `mailerlite` | email_marketing |
| `mailersend` | MailerSend | ✅ available | api_key | composio_managed · `mailersend` | email_marketing |
| `marketo` | Marketo | ⏳ coming_soon — Marketo OAuth app registration pending (developers.marketo.com) | static_oauth (3 scopes) | sidecar · `/marketo` | email_marketing |
| `meta_ads` | Meta Ads | ⏳ coming_soon — Meta (Facebook) OAuth app registration pending at developers.facebook.com | static_oauth (4 scopes) | vendor_hosted · sse | — |
| `omnisend` | Omnisend | ⏳ coming_soon — Omnisend gates MCP dynamic client registration on an approved application name: the registration endpoint returns invalid_client_metadata "unknown application: Liftoff". Requires Omnisend to allowlist the Liftoff client. | dcr_oauth (discovery: mcp.omnisend.com) | vendor_hosted · streamable-http | email_marketing |
| `partnerstack` | PartnerStack | ✅ available | dcr_oauth (discovery: mcp.partnerstack.com) | vendor_hosted · streamable-http | partner_management |
| `reddit_ads` | Reddit Ads | ✅ available | static_oauth (0 scopes) | composio_managed · `reddit_ads` | advertising |
| `sendgrid` | SendGrid | ✅ available | api_key | sidecar · `/sendgrid` | email_marketing |
| `similarweb` | Similarweb | ⏳ coming_soon — Similarweb grants no API access on the free trial — a paid plan is required for any API/MCP access (same posture as ZoomInfo); validation requires a paid account. | dcr_oauth (discovery: mcp.similarweb.com) | vendor_hosted · streamable-http | — |
| `smartlead` | Smartlead | ⏳ coming_soon — Smartlead API integration pending (api.smartlead.ai) | api_key | sidecar · `/smartlead` | email_marketing |
| `sparktoro` | SparkToro | ✅ available | dcr_oauth (discovery: mcp.sparktoro.com) | vendor_hosted · streamable-http | web_research |
| `supermetrics` | Supermetrics | ⏳ coming_soon — Requires a paid Supermetrics plan for API access; pending end-to-end validation with a paid account. | dcr_oauth (discovery: mcp.supermetrics.com) | vendor_hosted · streamable-http | — |
| `tapfiliate` | Tapfiliate | ⏳ coming_soon — Tapfiliate MCP dynamic client registration rejects the OAuth callback: the registration endpoint returns invalid_client_metadata "redirect_uri is not allowed". Requires Tapfiliate to allowlist the Liftoff callback URI. | dcr_oauth (discovery: mcp.tapfiliate.com) | vendor_hosted · streamable-http | partner_management |
| `tolt` | Tolt | ✅ available | api_key | vendor_hosted · streamable-http | partner_management |
| `typeform` | Typeform | ✅ available | static_oauth (0 scopes) | composio_managed · `typeform` | — |
| `typefully` | Typefully | ✅ available | dcr_oauth (discovery: mcp.typefully.com) | vendor_hosted · streamable-http | social_media |
| `webflow` | Webflow | ✅ available | dcr_oauth (discovery: mcp.webflow.com) | vendor_hosted · streamable-http | cms |

## Meetings & Scheduling

| Type | Display name | Status | Auth | MCP | Capabilities |
|---|---|---|---|---|---|
| `cal_com` | Cal.com | ✅ available | static_oauth (0 scopes) | composio_managed · `cal` | calendar |
| `calendly` | Calendly | ✅ available | dcr_oauth (discovery: mcp.calendly.com) | vendor_hosted · streamable-http | calendar |
| `fathom` | Fathom | ✅ available | static_oauth (0 scopes) | composio_managed · `fathom` | meeting_notes, conversation_intelligence |
| `fireflies` | Fireflies | ✅ available | api_key | composio_managed · `fireflies` | meeting_notes, conversation_intelligence |
| `google_calendar` | Google Calendar | ✅ available | static_oauth (0 scopes) | composio_managed · `googlecalendar` | calendar |
| `google_meet` | Google Meet | ✅ available | static_oauth (0 scopes) | composio_managed · `googlemeet` | — |
| `granola` | Granola | ✅ available | dcr_oauth (discovery: mcp.granola.ai) | vendor_hosted · streamable-http | meeting_notes |
| `microsoft_outlook_calendar` | Outlook Calendar | ✅ available | static_oauth (2 scopes) | sidecar · `/microsoft/outlook-calendar` | calendar |
| `zoom` | Zoom | ✅ available | static_oauth (4 scopes) | vendor_hosted · streamable-http | meeting_notes |

## Observability

| Type | Display name | Status | Auth | MCP | Capabilities |
|---|---|---|---|---|---|
| `datadog` | Datadog | ✅ available | api_key | composio_managed · `datadog` | error_tracking |
| `incident_io` | Incident.io | ✅ available | api_key | composio_managed · `incident_io` | incident_management |
| `new_relic` | New Relic | ✅ available | api_key | composio_managed · `new_relic` | incident_management |
| `pagerduty` | PagerDuty | ✅ available | static_oauth (0 scopes) | composio_managed · `pagerduty` | incident_management |
| `sentry` | Sentry | ✅ available | api_key | vendor_hosted · streamable-http | error_tracking |

## Productivity & Communication

| Type | Display name | Status | Auth | MCP | Capabilities |
|---|---|---|---|---|---|
| `baserow` | Baserow | ✅ available | api_key | composio_managed · `baserow` | data_table |
| `canva` | Canva | ✅ available | static_oauth (0 scopes) | composio_managed · `canva` | — |
| `discord` | Discord | ✅ available | static_oauth (0 scopes) | composio_managed · `discord` | team_chat |
| `documint` | Documint | ✅ available | api_key | composio_managed · `documint` | documents |
| `docusign` | DocuSign | ⏳ coming_soon — DocuSign Partner Program approval pending. OAuth is fully wired (environment-scoped host + secrets); becomes available once the Partner Program account is approved. | static_oauth (2 scopes) | sidecar · `/docusign` | e_sign |
| `figma` | Figma | ✅ available | static_oauth (0 scopes) | composio_managed · `figma` | — |
| `fillout` | Fillout | ✅ available | api_key | composio_managed · `fillout_forms` | — |
| `google_contacts` | Google Contacts | ✅ available | static_oauth (3 scopes) | — | — |
| `google_docs` | Google Docs | ✅ available | static_oauth (0 scopes) | composio_managed · `googledocs` | documents |
| `google_mail` | Gmail | ✅ available | static_oauth (0 scopes) | composio_managed · `gmail` | email_communication, support_helpdesk |
| `google_sheets` | Google Sheets | ✅ available | static_oauth (0 scopes) | composio_managed · `googlesheets` | data_table |
| `google_slides` | Google Slides | ✅ available | static_oauth (0 scopes) | composio_managed · `googleslides` | — |
| `google_tasks` | Google Tasks | ✅ available | static_oauth (3 scopes) | — | — |
| `harvest` | Harvest | ✅ available | static_oauth (0 scopes) | composio_managed · `harvest` | — |
| `jotform` | Jotform | ✅ available | api_key | composio_managed · `jotform` | — |
| `microsoft_contacts` | Microsoft Contacts | ✅ available | static_oauth (2 scopes) | sidecar · `/microsoft/contacts` | — |
| `microsoft_excel` | Microsoft Excel | ✅ available | static_oauth (0 scopes) | composio_managed · `excel` | data_table |
| `microsoft_outlook_mail` | Outlook Mail | ✅ available | static_oauth (0 scopes) | composio_managed · `outlook` | email_communication, support_helpdesk |
| `microsoft_teams` | Microsoft Teams | ✅ available | static_oauth (5 scopes) | sidecar · `/microsoft/teams` | team_chat |
| `microsoft_todo` | Microsoft To Do | ✅ available | static_oauth (2 scopes) | sidecar · `/microsoft/todo` | — |
| `missive` | Missive | ✅ available | api_key | composio_managed · `missive` | email_communication |
| `pandadoc` | PandaDoc | ✅ available | dcr_oauth (discovery: mcp.pandadoc.com) | vendor_hosted · streamable-http | e_sign |
| `paperform` | Paperform | ✅ available | api_key | composio_managed · `paperform` | — |
| `slack` | Slack | ✅ available | static_oauth (14 scopes) | sidecar · `/slack` | team_chat |
| `tally` | Tally | ✅ available | api_key | composio_managed · `tally` | — |
| `ticktick` | TickTick | ✅ available | static_oauth (0 scopes) | composio_managed · `ticktick` | project_management |
| `toggl` | Toggl | ✅ available | api_key | composio_managed · `toggl` | — |
| `zoho_mail` | Zoho Mail | ✅ available | static_oauth (0 scopes) | composio_managed · `zoho_mail` | email_communication |

## Project Management

| Type | Display name | Status | Auth | MCP | Capabilities |
|---|---|---|---|---|---|
| `asana` | Asana | ✅ available | static_oauth (1 scopes, PKCE) | vendor_hosted · streamable-http | project_management |
| `atlassian_jira` | Atlassian Jira | ✅ available | static_oauth (0 scopes) | composio_managed · `jira` | project_management |
| `clickup` | ClickUp | ✅ available | static_oauth (0 scopes) | composio_managed · `clickup` | project_management |
| `fibery` | Fibery | ✅ available | api_key | composio_managed · `fibery` | project_management |
| `microsoft_planner` | Microsoft Planner | ✅ available | static_oauth (2 scopes) | sidecar · `/microsoft/planner` | — |
| `monday` | Monday.com | ✅ available | static_oauth (0 scopes) | composio_managed · `monday` | project_management |
| `todoist` | Todoist | ✅ available | static_oauth (0 scopes) | composio_managed · `todoist` | project_management |
| `trello` | Trello | ✅ available | static_oauth (0 scopes) | composio_managed · `trello` | project_management |

## Social & Messaging

| Type | Display name | Status | Auth | MCP | Capabilities |
|---|---|---|---|---|---|
| `dialpad` | Dialpad | ✅ available | static_oauth (0 scopes) | composio_managed · `dialpad` | — |
| `facebook` | Facebook | ✅ available | static_oauth (0 scopes) | composio_managed · `facebook` | social_media |
| `instagram` | Instagram | ✅ available | static_oauth (0 scopes) | composio_managed · `instagram` | social_media |
| `linkedin` | LinkedIn | ✅ available | static_oauth (0 scopes) | composio_managed · `linkedin` | — |
| `reddit` | Reddit | ✅ available | static_oauth (0 scopes) | composio_managed · `reddit` | social_media |
| `saperly` | Saperly | ✅ available | api_key | — | messaging |
| `telegram` | Telegram | ✅ available | api_key | composio_managed · `telegram` | messaging |
| `whatsapp` | WhatsApp | ✅ available | static_oauth (0 scopes) | composio_managed · `whatsapp` | messaging |
| `youtube` | YouTube | ✅ available | static_oauth (0 scopes) | composio_managed · `youtube` | social_media |

## Storage

| Type | Display name | Status | Auth | MCP | Capabilities |
|---|---|---|---|---|---|
| `box` | Box | ✅ available | static_oauth (1 scopes) | sidecar · `/box` | cloud_storage |
| `dropbox` | Dropbox | ✅ available | static_oauth (0 scopes) | composio_managed · `dropbox` | cloud_storage |
| `google_drive` | Google Drive | ✅ available | static_oauth (0 scopes) | composio_managed · `googledrive` | cloud_storage |
| `microsoft_onedrive` | Microsoft OneDrive | ✅ available | static_oauth (0 scopes) | composio_managed · `one_drive` | cloud_storage |

## Web Tools

| Type | Display name | Status | Auth | MCP | Capabilities |
|---|---|---|---|---|---|
| `anchor_browser` | Anchor Browser | ✅ available | api_key | — | browser_automation |
| `apify` | Apify | ✅ available | api_key | — | web_scraping |
| `browseai` | Browse AI | ✅ available | api_key | composio_managed · `browseai` | web_scraping |
| `browser_use` | Browser Use | ✅ available | api_key | — | browser_automation |
| `browserbase` | Browserbase | ✅ available | api_key | — | browser_automation |
| `elevenlabs` | ElevenLabs | ✅ available | api_key | composio_managed · `elevenlabs` | — |
| `exa` | Exa | ✅ available | api_key | — | web_research |
| `firecrawl` | Firecrawl | ✅ available | api_key | — | web_scraping |
| `heygen` | HeyGen | ✅ available | api_key | composio_managed · `heygen` | — |
| `imgbb` | ImgBB | ✅ available | api_key | composio_managed · `imgbb` | — |
| `onepassword` | 1Password | ✅ available | api_key | — | — |
| `scrapingbee` | ScrapingBee | ✅ available | api_key | composio_managed · `scrapingbee` | web_scraping |
| `steel` | Steel | ✅ available | api_key | — | browser_automation |
| `tavily` | Tavily | ✅ available | api_key | — | web_research |
| `tikhub` | TikHub | ⚠️  deprecated | api_key | — | social_media, web_scraping |
| `webclaw` | WebClaw | ✅ available | api_key | — | web_scraping |

---

See also:
- [`src/catalog/connectors.ts`](../src/catalog/connectors.ts) — the registry
- [`src/catalog/projections.ts`](../src/catalog/projections.ts) — derived views
- [`src/catalog/mcp-server-registry.ts`](../src/catalog/mcp-server-registry.ts) — MCP URLs, transports
- [`src/catalog/connector-capabilities.ts`](../src/catalog/connector-capabilities.ts) — capability → scope maps
