// API Key Authentication Router.
//
// Ported from platform-backend/src/connectors/apikey-router.ts. Adapts:
//   - Secret Manager access → credentialService.storeCredentials
//     (connector-{tenantId}-{connectorId} naming in secrets/client.ts)
//   - Connector CRUD → oauth/connector-ops.ts (tenant-scoped via
//     withTenantScope + app.tenant_id)
//   - Firebase account lookup is replaced by the canonical
//     x-account-id header that the web-tier (platform-backend) passes
//     over X-Service-Auth after its own Firebase check.
//   - Hosting-mode aware secret project resolution is inside
//     secrets/client.ts — it reads TENANT_HOSTING_MODE env; no per-request
//     tenants-table lookup is needed here.
//
// Mount path: /api/connectors/apikey (see server.ts).

import { Router, Request, Response } from 'express';
import { AuthScheme } from '@composio/core';
import { logger } from '../infra/logging.js';
import { ConnectorType } from '../types.js';
import { CONNECTORS } from '../catalog/connectors.js';
import { isNativeHrisConnector } from '../catalog/source-overrides.js';
import { credentialService } from '../credentials/service.js';
import { emitCredentialsStored } from '../events/publisher.js';
import { publishAuditEvent } from '../events/audit-publisher.js';
import {
  findConnectorByTenantAndType,
  getConnectorById,
  createConnectorReusingOnAccountConflict,
  findConnectorByTenantTypeAndExternalAccountId,
  createConnector,
  updateConnectorStatus,
  updateApiKeyHint,
  mergeConnectorConfig,
} from './connector-ops.js';
import {
  fetchApiKeyIdentity,
  InvalidCredentialError,
  STRICT_VALIDATION_CONNECTOR_TYPES,
} from './api-key-identity-fetchers.js';
import { extractComposioIdentity } from './identity-fetchers.js';
import { getComposio, pollConnectedAccountActive, deleteComposioConnectedAccount } from './composio-client.js';
import { composioAuthConfigId } from '../catalog/composio-resources';

// Connector types that use API key authentication
export const API_KEY_CONNECTOR_CONFIGS: Record<
  string,
  {
    displayName: string;
    // The sentence the connect modal shows above the fields. Absent, the modal
    // says "Connect your <name> account to give your AI teams access to this
    // app. Paste your API key to continue.", which is wrong for a connector
    // whose credential is not an API key.
    description?: string;
    // Composio connected_account_initiation auth scheme. Defaults to API_KEY
    // (AuthScheme.APIKey). Set 'BASIC' for connectors whose Composio toolkit
    // uses BASIC auth (e.g. mixpanel: username + secret -> AuthScheme.Basic).
    composioAuthScheme?: 'API_KEY' | 'BASIC';
    // Composio fields with a CONSTANT value the user must NOT set — injected
    // into the AuthScheme payload verbatim and never shown in the connect form.
    // e.g. Supabase Management API base URL `full` is always api.supabase.com;
    // exposing it as an editable field led users to paste a project URL and
    // every management call 404'd.
    fixedComposioValues?: Record<string, string>;
    fields: Array<{
      name: string;
      label: string;
      // 'textarea' is a multi-line variant of 'text' — the connect modal renders
      // it as a <textarea> (for pasted PEM certificate/key blocks, e.g. ADP).
      type: 'text' | 'password' | 'select' | 'textarea';
      required: boolean;
      placeholder: string;
      // For type 'select': dropdown options (value = stored value).
      options?: Array<{ value: string; label: string }>;
      // For composio_managed api_key connectors: the Composio
      // connected_account_initiation field this value maps to. The connect
      // handler builds the AuthScheme.APIKey payload from fields that set this.
      composioField?: string;
      // Optional normalization of the submitted value before it's sent to
      // Composio. Maps legacy/alternate inputs to the canonical token Composio
      // expects; values absent from the map pass through unchanged. (Datadog
      // region: a stale UI may submit the full host `us3.datadoghq.com` where
      // Composio wants the bare code `us3` — without this the connected
      // account's base_url becomes `api.us3.datadoghq.com.datadoghq.com`.)
      composioValueMap?: Record<string, string>;
      // Optional value transform applied before sending to Composio.
      //   'subdomain' — extract the bare account subdomain from whatever the
      //     user pastes: strips scheme + path and keeps the first DNS label, so
      //     `acme`, `acme.pipedrive.com`, and `https://acme.pipedrive.com/` all
      //     become `acme`. Prevents the host getting templated to
      //     `acme.pipedrive.com.pipedrive.com` (same bug class as datadog region).
      composioNormalize?: 'subdomain';
      // Optional default applied when the user leaves the field blank (e.g.
      // Supabase Base URL → https://api.supabase.com, the management-API host
      // that never changes). Keeps the Composio-required field present without
      // forcing the user to type a constant.
      default?: string;
      // 0-based index into `steps`; absent ⇒ step 0 (single-step form).
      step?: number;
    }>;
    // Optional multi-step grouping for long forms; the UI paginates fields by `field.step`.
    steps?: Array<{ title: string; description?: string; helpUrl?: string }>;
  }
> = {
  datadog: {
    displayName: 'Datadog',
    fields: [
      {
        name: 'site',
        label: 'Datadog Region',
        type: 'select',
        required: true,
        placeholder: 'Select your Datadog region',
        // Values are Composio region codes (the `region` field of Datadog's
        // datadog_api_key auth scheme); labels mirror Datadog's own login list.
        composioField: 'region',
        // Defensive: a stale UI (cached older config) may submit the
        // full host instead of the code. Normalize so Composio still builds a
        // correct base_url. Bare codes are absent here → pass through unchanged.
        composioValueMap: {
          'datadoghq.com': 'us1',
          'us3.datadoghq.com': 'us3',
          'us5.datadoghq.com': 'us5',
          'datadoghq.eu': 'eu',
          'ap1.datadoghq.com': 'ap1',
          'ap2.datadoghq.com': 'ap2',
        },
        options: [
          { value: 'us1', label: 'US1 - East (datadoghq.com)' },
          { value: 'us3', label: 'US3 - West (us3.datadoghq.com)' },
          { value: 'us5', label: 'US5 - Central (us5.datadoghq.com)' },
          { value: 'eu', label: 'EU1 - Europe (datadoghq.eu)' },
          { value: 'ap1', label: 'AP1 - Japan (ap1.datadoghq.com)' },
          { value: 'ap2', label: 'AP2 - Australia (ap2.datadoghq.com)' },
        ],
      },
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Your Datadog API key', composioField: 'generic_api_key' },
      { name: 'appKey', label: 'Application Key', type: 'password', required: true, placeholder: 'Your Datadog application key', composioField: 'generic_id' },
    ],
  },
  // Composio-managed API_KEY connectors (routed via connectComposioApiKeyConnector).
  apollo: {
    displayName: 'Apollo.io',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Your Apollo API key', composioField: 'generic_api_key' },
    ],
  },
  lever: {
    displayName: 'Lever',
    fields: [
      { name: 'apiKey', label: 'API Key (Base64)', type: 'password', required: true, placeholder: 'Your base64-encoded Lever API key', composioField: 'generic_api_key' },
    ],
  },
  workable: {
    displayName: 'Workable',
    fields: [
      { name: 'subdomain', label: 'Account Subdomain', type: 'text', required: true, placeholder: 'yourcompany', composioField: 'subdomain', composioNormalize: 'subdomain' },
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Your Workable API key', composioField: 'generic_api_key' },
    ],
  },
  pipedrive: {
    displayName: 'Pipedrive',
    fields: [
      { name: 'subdomain', label: 'Account Subdomain', type: 'text', required: true, placeholder: 'yourcompany', composioField: 'subdomain', composioNormalize: 'subdomain' },
      { name: 'apiKey', label: 'API Token', type: 'password', required: true, placeholder: 'Your Pipedrive API token', composioField: 'generic_api_key' },
    ],
  },
  instantly: {
    displayName: 'Instantly',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Your Instantly API key', composioField: 'generic_api_key' },
    ],
  },
  freshdesk: {
    displayName: 'Freshdesk',
    fields: [
      { name: 'subdomain', label: 'Account Subdomain', type: 'text', required: true, placeholder: 'yourcompany', composioField: 'subdomain', composioNormalize: 'subdomain' },
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Your Freshdesk API key', composioField: 'generic_api_key' },
    ],
  },
  ashby: {
    displayName: 'Ashby',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Your Ashby API key', composioField: 'generic_api_key' },
    ],
  },
  coda: {
    displayName: 'Coda',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Your Coda API token', composioField: 'generic_api_key' },
    ],
  },
  missive: {
    displayName: 'Missive',
    fields: [
      { name: 'apiKey', label: 'API Token', type: 'password', required: true, placeholder: 'Your Missive API token', composioField: 'bearer_token' },
    ],
  },
  shopify: {
    displayName: 'Shopify',
    fields: [
      { name: 'subdomain', label: 'Account Subdomain', type: 'text', required: true, placeholder: 'yourcompany', composioField: 'subdomain', composioNormalize: 'subdomain' },
      { name: 'apiKey', label: 'Admin API access token', type: 'password', required: true, placeholder: 'shpat_...', composioField: 'generic_api_key' },
    ],
  },
  fireflies: {
    displayName: 'Fireflies',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Your Fireflies API key', composioField: 'generic_api_key' },
    ],
  },
  close: {
    displayName: 'Close',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Your Close API key', composioField: 'generic_api_key' },
    ],
  },
  browseai: {
    displayName: 'Browse AI',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Your Browse AI API key', composioField: 'generic_api_key' },
    ],
  },
  documint: {
    displayName: 'Documint',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Your Documint API key', composioField: 'generic_api_key' },
    ],
  },
  posthog: {
    displayName: 'PostHog',
    fields: [
      { name: 'subdomain', label: 'Region or Host', type: 'text', required: true, placeholder: 'us.posthog.com or eu.posthog.com', composioField: 'subdomain' },
      { name: 'apiKey', label: 'Personal API Key', type: 'password', required: true, placeholder: 'phx_...', composioField: 'generic_api_key' },
    ],
  },
  mixpanel: {
    displayName: 'Mixpanel',
    composioAuthScheme: 'BASIC',
    fields: [
      { name: 'username', label: 'Service Account Username', type: 'text', required: true, placeholder: 'my-sa.abc123.mp-service-account', composioField: 'username' },
      { name: 'password', label: 'Service Account Secret', type: 'password', required: true, placeholder: 'Your Mixpanel service account secret', composioField: 'password' },
    ],
  },
  sendgrid: {
    displayName: 'SendGrid',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'SG.xxxx...' },
    ],
  },
  trello: {
    displayName: 'Trello',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Your Trello API key' },
      { name: 'apiToken', label: 'API Token', type: 'password', required: true, placeholder: 'Your Trello token' },
    ],
  },
  woocommerce: {
    displayName: 'WooCommerce',
    fields: [
      { name: 'siteUrl', label: 'Store URL', type: 'text', required: true, placeholder: 'https://yourstore.com' },
      { name: 'consumerKey', label: 'Consumer Key', type: 'password', required: true, placeholder: 'ck_xxxx...' },
      { name: 'consumerSecret', label: 'Consumer Secret', type: 'password', required: true, placeholder: 'cs_xxxx...' },
    ],
  },
  bamboohr: {
    displayName: 'BambooHR',
    fields: [
      { name: 'subdomain', label: 'Subdomain', type: 'text', required: true, placeholder: 'yourcompany' },
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Your BambooHR API key' },
    ],
  },
  // Elicit — native sidecar (direct-vault; no composioField → persists to
  // connector.config.apiKey, read by ElicitClient). Key from elicit.com/settings (Pro plan).
  elicit: {
    displayName: 'Elicit',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'elk_live_...' },
    ],
  },
  // BYO-only data / telephony vendors — native REST, no Composio (direct-vault;
  // no composioField → the submitted apiKey persists to connector.config.apiKey and
  // is read back as ctx.credentials.apiKey by src/clients/{pdl,hunter,saperly}.ts).
  // These have no platform key on the connect path (pdl/hunter fall back to a
  // platform key at RUN time only; saperly is tenant-key-only), so the workspace
  // pastes its own key here — the same shape as elicit above.
  pdl: {
    displayName: 'People Data Labs',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Your People Data Labs API key' },
    ],
  },
  hunterio: {
    displayName: 'Hunter',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Your Hunter API key' },
    ],
  },
  saperly: {
    displayName: 'Saperly',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Your Saperly API key' },
    ],
  },
  // Warp — native HRIS, fixed host (api.joinwarp.com), so no subdomain field. The
  // key is vaulted (credentials.apiKey), which is why WarpClient reads that field
  // rather than connectorConfig.apiKey (a raw key does not belong in connector.config).
  warp: {
    displayName: 'Warp',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Your Warp API key' },
    ],
  },
  // ── Native HRIS (direct-vault).
  //    Submitted fields are persisted to connector.config (mergeConnectorConfig below),
  //    which the native clients read as connectorConfig. No composioField → direct vault.
  namely: {
    displayName: 'Namely',
    fields: [
      { name: 'subdomain', label: 'Subdomain', type: 'text', required: true, placeholder: 'yourcompany' },
      { name: 'apiKey', label: 'Personal Access Token', type: 'password', required: true, placeholder: 'Namely PAT' },
    ],
  },
  workday: {
    displayName: 'Workday',
    steps: [
      { title: 'Workday instance & endpoints', description: 'Copied from “View API Clients” in your Workday tenant.' },
      { title: 'API credentials', description: 'The OAuth client and Integration System User secrets.' },
      { title: 'Integrate Human Workforce', description: 'See the full cost and performance of your human workforce next to your AI workforce.', helpUrl: '/support/connections/human-workforce-costs' },
    ],
    fields: [
      { name: 'tenantHost', label: 'Tenant Host', type: 'text', required: true, placeholder: 'https://wd2-impl-services1.workday.com', step: 0 },
      { name: 'tenant', label: 'Tenant Name', type: 'text', required: true, placeholder: 'acme_dpt1', step: 0 },
      { name: 'restEndpoint', label: 'REST API Endpoint', type: 'text', required: true, placeholder: 'https://…/ccx/api/v1/acme_dpt1', step: 0 },
      { name: 'tokenUrl', label: 'Token URL', type: 'text', required: true, placeholder: 'https://…/ccx/oauth2/acme_dpt1/token', step: 0 },
      { name: 'clientId', label: 'Client ID', type: 'text', required: true, placeholder: 'API client ID', step: 1 },
      { name: 'clientSecret', label: 'Client Secret', type: 'password', required: true, placeholder: 'API client secret', step: 1 },
      { name: 'refreshToken', label: 'ISU Refresh Token', type: 'password', required: true, placeholder: 'Integration System User refresh token', step: 1 },
      { name: 'isuUsername', label: 'ISU Username (for SOAP writes)', type: 'text', required: false, placeholder: 'ISU account username', step: 1 },
      { name: 'isuPassword', label: 'ISU Password (for SOAP writes)', type: 'password', required: false, placeholder: 'ISU account password', step: 1 },
      { name: 'payComponentClassReportUrl', label: 'Cost report link', type: 'text', required: false, placeholder: 'Paste the link to your Workday report', step: 2 },
    ],
  },
  oracle_hcm: {
    displayName: 'Oracle Cloud HCM',
    steps: [
      { title: 'Oracle credentials', description: 'Your Oracle pod and IDCS confidential application details.' },
      { title: 'Integrate Human Workforce', description: 'See the full cost and performance of your human workforce next to your AI workforce. In Oracle, employer costs come from a payroll administrator role, not a report.', helpUrl: '/support/connections/human-workforce-costs' },
    ],
    fields: [
      { name: 'podHost', label: 'Pod Host', type: 'text', required: true, placeholder: 'yourpod.fa.us2.oraclecloud.com', step: 0 },
      { name: 'idcsTokenUrl', label: 'IDCS Token URL', type: 'text', required: true, placeholder: 'https://idcs-….identity.oraclecloud.com', step: 0 },
      { name: 'clientId', label: 'Client ID', type: 'text', required: true, placeholder: 'IDCS confidential app client ID', step: 0 },
      { name: 'clientSecret', label: 'Client Secret', type: 'password', required: true, placeholder: 'IDCS confidential app client secret', step: 0 },
      { name: 'scope', label: 'Scope', type: 'text', required: false, placeholder: 'urn:opc:resource:consumer::all', step: 0 },
    ],
  },
  sap_successfactors: {
    displayName: 'SAP SuccessFactors',
    fields: [
      { name: 'apiServerHost', label: 'API Server Host', type: 'text', required: true, placeholder: 'api4.successfactors.com' },
      { name: 'companyId', label: 'Company ID', type: 'text', required: true, placeholder: 'Your SF company id' },
      { name: 'oauthClientId', label: 'OAuth Client API Key', type: 'text', required: true, placeholder: 'Registered OAuth2 client API key' },
      { name: 'assertionUserId', label: 'Assertion User ID', type: 'text', required: true, placeholder: 'Technical user for the SAML assertion' },
    ],
  },
  // ── Native HRIS batch 2 (direct-vault). No composioField → all fields persist to
  //    connector.config (mergeConnectorConfig), read by the native clients as
  //    connectorConfig. ──
  deel: {
    displayName: 'Deel',
    fields: [
      { name: 'apiToken', label: 'API Token', type: 'password', required: true, placeholder: 'Deel organization token' },
    ],
  },
  factorial: {
    displayName: 'Factorial',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Factorial API key' },
    ],
  },
  hibob: {
    displayName: 'HiBob',
    fields: [
      { name: 'serviceUserId', label: 'Service User ID', type: 'text', required: true, placeholder: 'HiBob service user id' },
      { name: 'token', label: 'Service User Token', type: 'password', required: true, placeholder: 'HiBob service user token' },
    ],
  },
  personio: {
    displayName: 'Personio',
    fields: [
      { name: 'clientId', label: 'Client ID', type: 'text', required: true, placeholder: 'Personio API client id' },
      { name: 'clientSecret', label: 'Client Secret', type: 'password', required: true, placeholder: 'Personio API client secret' },
    ],
  },
  ukg_pro: {
    displayName: 'UKG Pro',
    fields: [
      { name: 'serviceUrl', label: 'Service URL', type: 'text', required: true, placeholder: 'service5.ultipro.com' },
      { name: 'customerApiKey', label: 'Customer API Key', type: 'password', required: true, placeholder: 'UKG Pro customer API key' },
      { name: 'username', label: 'Web Service Username', type: 'text', required: true, placeholder: 'Web services user' },
      { name: 'userApiKey', label: 'User API Key', type: 'password', required: true, placeholder: 'UKG Pro user API key' },
    ],
  },
  ukg_ready: {
    displayName: 'UKG Ready',
    fields: [
      { name: 'apiHost', label: 'API Host', type: 'text', required: true, placeholder: 'secure.saashr.com' },
      { name: 'companyShortName', label: 'Company Short Name', type: 'text', required: true, placeholder: 'Company short name (cid)' },
      { name: 'username', label: 'Username', type: 'text', required: true, placeholder: 'API user' },
      { name: 'password', label: 'Password', type: 'password', required: true, placeholder: 'API user password' },
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'UKG Ready API key' },
    ],
  },
  dayforce: {
    displayName: 'Dayforce',
    steps: [
      { title: 'Web services credentials', description: 'Your Dayforce web services company id and account.' },
      { title: 'Integrate Human Workforce', description: 'See the full cost and performance of your human workforce next to your AI workforce.', helpUrl: '/support/connections/human-workforce-costs' },
    ],
    fields: [
      { name: 'companyId', label: 'Company ID', type: 'text', required: true, placeholder: 'Dayforce company id', step: 0 },
      { name: 'username', label: 'Username', type: 'text', required: true, placeholder: 'Web services username', step: 0 },
      { name: 'password', label: 'Password', type: 'password', required: true, placeholder: 'Web services password', step: 0 },
      { name: 'committedPayRunReportXRefCode', label: 'Cost report link', type: 'text', required: false, placeholder: 'Paste the report integration name from Dayforce', step: 1 },
    ],
  },
  adp_run: {
    displayName: 'ADP RUN',
    steps: [{ title: 'API Central OAuth' }, { title: 'API Central certificate' }],
    fields: [
      { name: 'clientId', label: 'Client ID', type: 'text', required: true, placeholder: 'API Central client id', step: 0 },
      { name: 'clientSecret', label: 'Client Secret', type: 'password', required: true, placeholder: 'API Central client secret', step: 0 },
      { name: 'certificatePem', label: 'Client Certificate (PEM)', type: 'textarea', required: true, placeholder: '-----BEGIN CERTIFICATE-----', step: 1 },
      { name: 'privateKeyPem', label: 'Private Key (PEM)', type: 'password', required: true, placeholder: '-----BEGIN PRIVATE KEY-----', step: 1 },
    ],
  },
  adp_workforce_now: {
    displayName: 'ADP Workforce Now',
    steps: [{ title: 'API Central OAuth' }, { title: 'API Central certificate' }],
    fields: [
      { name: 'clientId', label: 'Client ID', type: 'text', required: true, placeholder: 'API Central client id', step: 0 },
      { name: 'clientSecret', label: 'Client Secret', type: 'password', required: true, placeholder: 'API Central client secret', step: 0 },
      { name: 'certificatePem', label: 'Client Certificate (PEM)', type: 'textarea', required: true, placeholder: '-----BEGIN CERTIFICATE-----', step: 1 },
      { name: 'privateKeyPem', label: 'Private Key (PEM)', type: 'password', required: true, placeholder: '-----BEGIN PRIVATE KEY-----', step: 1 },
    ],
  },
  cal_com: {
    displayName: 'Cal.com',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'cal_live_xxxx...' },
    ],
  },
  mailchimp: {
    displayName: 'Mailchimp',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'xxxx-us1' },
    ],
  },
  sentry: {
    displayName: 'Sentry',
    fields: [
      { name: 'apiKey', label: 'Auth Token', type: 'password', required: true, placeholder: 'sntrys_xxxx...' },
      { name: 'sentryUrl', label: 'Sentry MCP URL', type: 'text', required: false, placeholder: 'https://mcp.sentry.dev/mcp (default, change for self-hosted)' },
    ],
  },
  databricks: {
    displayName: 'Databricks',
    fields: [
      { name: 'workspaceUrl', label: 'Workspace URL', type: 'text', required: true, placeholder: 'https://myworkspace.azuredatabricks.net' },
      { name: 'patToken', label: 'Personal Access Token', type: 'password', required: true, placeholder: 'dapi...' },
    ],
  },
  firecrawl: {
    displayName: 'Firecrawl',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'fc-...' },
    ],
  },
  anchor_browser: {
    displayName: 'Anchor Browser',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'sk-...' },
    ],
  },
  browser_use: {
    displayName: 'Browser Use',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'bu_live_...' },
    ],
  },
  steel: {
    displayName: 'Steel',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'ste-...' },
    ],
  },
  // The field is named apiKey on purpose: the connect branch vaults
  // credentials.apiKey as the primary key and parks every other field under
  // metadata.extraFields, so any other name leaves the runtime's
  // GetCredentials.apiKey.apiKey empty. The label is what says "service
  // account token".
  onepassword: {
    displayName: '1Password',
    description: 'Connect a 1Password service account to give your AI teams the logins in the vault you share with it. Paste your service account token to continue.',
    fields: [
      { name: 'apiKey', label: 'Service Account Token', type: 'password', required: true, placeholder: 'ops_...' },
    ],
  },
  browserbase: {
    displayName: 'Browserbase',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'bb_live_...' },
      { name: 'projectId', label: 'Project ID', type: 'text', required: true, placeholder: 'prj_...' },
    ],
  },
  tavily: {
    displayName: 'Tavily',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'tvly-...' },
    ],
  },
  exa: {
    displayName: 'Exa',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'exa_...' },
    ],
  },
  webclaw: {
    displayName: 'WebClaw',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'wc_...' },
    ],
  },
  // Net-new Composio-managed batch
  activecampaign: {
    displayName: 'ActiveCampaign',
    fields: [
      { name: 'apiUrl', label: 'API URL', type: 'text', required: true, placeholder: 'API URL', composioField: 'full' },
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'API Key', composioField: 'generic_api_key' },
    ],
  },
  // Direct-vault (native executor, src/clients/apify.ts).
  apify: {
    displayName: 'Apify',
    fields: [
      { name: 'apiKey', label: 'API Token', type: 'password', required: true, placeholder: 'Your Apify API token' },
    ],
  },
  contactout: {
    displayName: 'ContactOut',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Your ContactOut API key' },
    ],
  },
  crunchbase: {
    displayName: 'Crunchbase',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Your Crunchbase API key' },
    ],
  },
  // Direct-vault entries like contactout: the key lands in the credential
  // blob's apiKey and the native executor reads it as the workspace's own
  // (src/clients/strale.ts, gloria-mcp.ts). Both are optional connections:
  // the platform serves the same functions without one.
  strale: {
    displayName: 'Strale',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Your Strale API key' },
    ],
  },
  gloria: {
    displayName: 'Gloria',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Your Gloria API key (Elite plan)' },
    ],
  },
  baserow: {
    displayName: 'Baserow',
    fields: [
      { name: 'apiKey', label: 'API Token', type: 'password', required: true, placeholder: 'API Token', composioField: 'generic_api_key' },
    ],
  },
  brevo: {
    displayName: 'Brevo',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'API Key', composioField: 'generic_api_key' },
    ],
  },
  buildkite: {
    displayName: 'Buildkite',
    fields: [
      { name: 'apiKey', label: 'API Token', type: 'password', required: true, placeholder: 'API Token', composioField: 'bearer_token' },
    ],
  },
  codacy: {
    displayName: 'Codacy',
    fields: [
      { name: 'apiKey', label: 'API Token', type: 'password', required: true, placeholder: 'API Token', composioField: 'generic_api_key' },
    ],
  },
  dovetail: {
    displayName: 'Dovetail',
    fields: [
      { name: 'apiKey', label: 'API Token', type: 'password', required: true, placeholder: 'API Token', composioField: 'bearer_token' },
    ],
  },
  elevenlabs: {
    displayName: 'ElevenLabs',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'API Key', composioField: 'generic_api_key' },
    ],
  },
  fibery: {
    displayName: 'Fibery',
    fields: [
      { name: 'subdomain', label: 'Account Subdomain', type: 'text', required: true, placeholder: 'Account Subdomain', composioField: 'subdomain', composioNormalize: 'subdomain' },
      { name: 'apiKey', label: 'API Token', type: 'password', required: true, placeholder: 'API Token', composioField: 'generic_api_key' },
    ],
  },
  fillout: {
    displayName: 'Fillout',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'API Key', composioField: 'generic_api_key' },
    ],
  },
  folk: {
    displayName: 'Folk',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'API Key', composioField: 'generic_api_key' },
    ],
  },
  follow_up_boss: {
    displayName: 'Follow Up Boss',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'API Key', composioField: 'generic_api_key' },
    ],
  },
  heygen: {
    displayName: 'HeyGen',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'API Key', composioField: 'generic_api_key' },
    ],
  },
  imgbb: {
    displayName: 'ImgBB',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'API Key', composioField: 'generic_key' },
    ],
  },
  incident_io: {
    displayName: 'Incident.io',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'API Key', composioField: 'generic_api_key' },
    ],
  },
  jotform: {
    displayName: 'Jotform',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'API Key', composioField: 'generic_api_key' },
      { name: 'appId', label: 'App ID', type: 'text', required: true, placeholder: 'App ID', composioField: 'generic_id' },
    ],
  },
  lemlist: {
    displayName: 'Lemlist',
    fields: [
      { name: 'apiKey', label: 'API Token', type: 'password', required: true, placeholder: 'API Token', composioField: 'generic_token' },
    ],
  },
  lemon_squeezy: {
    displayName: 'Lemon Squeezy',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'API Key', composioField: 'generic_api_key' },
    ],
  },
  loops: {
    displayName: 'Loops',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'API Key', composioField: 'generic_api_key' },
    ],
  },
  mailerlite: {
    displayName: 'MailerLite',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'API Key', composioField: 'generic_api_key' },
    ],
  },
  mailersend: {
    displayName: 'MailerSend',
    fields: [
      { name: 'apiKey', label: 'API Token', type: 'password', required: true, placeholder: 'API Token', composioField: 'generic_api_key' },
    ],
  },
  mem: {
    displayName: 'Mem',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'API Key', composioField: 'generic_api_key' },
    ],
  },
  new_relic: {
    displayName: 'New Relic',
    fields: [
      // Composio's region field expects 'US' or 'EU' (uppercase); normalize
      // whatever case the user types so the connection isn't rejected.
      { name: 'region', label: 'Region (US or EU)', type: 'text', required: true, placeholder: 'US or EU', composioField: 'region',
        composioValueMap: { us: 'US', US: 'US', eu: 'EU', EU: 'EU' } },
      { name: 'apiKey', label: 'API Key (User key)', type: 'password', required: true, placeholder: 'Your New Relic User key', composioField: 'generic_api_key' },
    ],
  },
  northflank: {
    displayName: 'Northflank',
    fields: [
      { name: 'apiKey', label: 'API Token', type: 'password', required: true, placeholder: 'API Token', composioField: 'generic_api_key' },
    ],
  },
  paperform: {
    displayName: 'Paperform',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'API Key', composioField: 'generic_api_key' },
    ],
  },
  scrapingbee: {
    displayName: 'ScrapingBee',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'API Key', composioField: 'generic_api_key' },
    ],
  },
  supabase: {
    // Composio's Supabase toolkit is the Management API (api.supabase.com),
    // authenticated with a Supabase Personal Access Token (sbp_…) — NOT the
    // per-project service-role/secret key (those are for the data API, which
    // this toolkit does not use).
    displayName: 'Supabase',
    // `full` (mgmt API base URL) is a constant — inject it, never show it, so a
    // user can't paste a project URL and 404 every management call.
    fixedComposioValues: { full: 'https://api.supabase.com' },
    fields: [
      { name: 'apiKey', label: 'Personal Access Token', type: 'password', required: true, placeholder: 'sbp_… (Supabase → Account → Access Tokens)', composioField: 'bearer_token' },
    ],
  },
  tally: {
    displayName: 'Tally',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'API Key', composioField: 'generic_api_key' },
    ],
  },
  telegram: {
    displayName: 'Telegram',
    fields: [
      { name: 'apiKey', label: 'Bot Token', type: 'password', required: true, placeholder: 'Bot Token', composioField: 'generic_api_key' },
    ],
  },
  toggl: {
    displayName: 'Toggl',
    fields: [
      { name: 'apiKey', label: 'API Token', type: 'password', required: true, placeholder: 'API Token', composioField: 'generic_api_key' },
    ],
  },
  clicksend: {
    displayName: 'ClickSend',
    // ClickSend uses HTTP Basic auth (username + API key); Composio's toolkit
    // auth mode is BASIC, so this flag is required or the connect submits
    // AuthScheme.APIKey instead of AuthScheme.Basic and the connection fails.
    composioAuthScheme: 'BASIC',
    fields: [
      { name: 'username', label: 'Username', type: 'text', required: true, placeholder: 'Username', composioField: 'username' },
      { name: 'password', label: 'API Key', type: 'password', required: true, placeholder: 'API Key', composioField: 'password' },
    ],
  },
  // Marketing connectors. Field labels are the vendors' own names
  // for these values, read from the Composio field descriptions and the Tolt
  // help article.
  tolt: {
    displayName: 'Tolt',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'From Settings > Integrations > API' },
    ],
  },
  plausible: {
    displayName: 'Plausible Analytics',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'API Key', composioField: 'generic_api_key' },
      { name: 'instanceUrl', label: 'Instance URL', type: 'text', required: false, placeholder: 'https://plausible.io', composioField: 'full' },
    ],
  },
  dataforseo: {
    displayName: 'DataForSEO',
    composioAuthScheme: 'BASIC',
    fields: [
      { name: 'username', label: 'API Login', type: 'text', required: true, placeholder: 'API Login', composioField: 'username' },
      { name: 'password', label: 'API Password', type: 'password', required: true, placeholder: 'API Password', composioField: 'password' },
    ],
  },
};

export function usesApiKeyAuth(connectorType: string): boolean {
  return connectorType in API_KEY_CONNECTOR_CONFIGS;
}

type ApiKeyConnectorConfig = (typeof API_KEY_CONNECTOR_CONFIGS)[string];

/**
 * Extract a bare account subdomain from whatever the user pastes. Composio
 * templates this value into a host (e.g. `{subdomain}.pipedrive.com`), so a
 * full domain like `acme.pipedrive.com` would produce
 * `acme.pipedrive.com.pipedrive.com`. Strip scheme + path and keep the first
 * DNS label: `acme`, `acme.pipedrive.com`, `https://acme.pipedrive.com/` → `acme`.
 */
function normalizeSubdomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .split('.')[0];
}

/**
 * Connect a composio_managed connector whose auth.kind is 'api_key' (e.g.
 * datadog). The per-tenant keys are submitted to Composio via
 * connectedAccounts.initiate (immediately ACTIVE — no redirect), and the
 * connector row stores the composioConnectedAccountId instead of writing
 * Secret Manager. Agents reach the toolkit via the composio dispatch path;
 * reactive polling runs through Composio actions (see polling/scheduler.ts).
 *
 * Returns the connector id + resolved identity, or throws on a hard failure.
 */
async function connectComposioApiKeyConnector(args: {
  connectorType: string;
  tenantId: string;
  config: ApiKeyConnectorConfig;
  credentials: Record<string, unknown>;
  reconnectConnectorId?: string;
}): Promise<{ connectorId: string; externalAccountId: string; externalAccountLabel: string | null }> {
  const { connectorType, tenantId, config, credentials, reconnectConnectorId } = args;
  const mcp = CONNECTORS[connectorType]?.mcp;
  if (!mcp || mcp.kind !== 'composio_managed') {
    throw new Error(`connectComposioApiKeyConnector called for non-composio connector ${connectorType}`);
  }
  const env = (process.env.ENVIRONMENT ?? 'dev') as 'dev' | 'prod';
  const authConfigId = composioAuthConfigId(mcp.toolkitSlug, mcp.authConfigIds, env);
  if (!authConfigId || authConfigId.startsWith('<')) {
    throw new Error(`Composio auth config not provisioned for ${connectorType} in ${env}`);
  }

  // Build the AuthScheme.APIKey payload from fields that declare a composioField,
  // applying any composioValueMap (datadog full-host → code) or composioNormalize
  // (subdomain extraction) so the value Composio templates into a host is clean.
  const val: Record<string, string> = {};
  for (const field of config.fields) {
    if (field.composioField) {
      const submitted = credentials[field.name];
      // Fall back to the field default when the user leaves it blank.
      const raw = (typeof submitted === 'string' && submitted) ? submitted : field.default;
      if (typeof raw === 'string' && raw) {
        let v = field.composioValueMap?.[raw] ?? raw;
        if (field.composioNormalize === 'subdomain') v = normalizeSubdomain(v);
        val[field.composioField] = v;
      }
    }
  }
  // Inject connector-fixed constants (e.g. Supabase mgmt API base URL) that are
  // never user-editable. These override any field value of the same name.
  if (config.fixedComposioValues) Object.assign(val, config.fixedComposioValues);

  const composio = getComposio();
  // BASIC-auth toolkits (e.g. mixpanel: username + secret) use AuthScheme.Basic;
  // everything else uses AuthScheme.APIKey.
  const authConfigPayload = config.composioAuthScheme === 'BASIC'
    ? AuthScheme.Basic({ username: val.username, password: val.password })
    : AuthScheme.APIKey(val);
  // userId == tenant_id, matching the OAuth linkComposioAccount convention.
  // allowMultiple: Composio's initiate REJECTS a second connected account for
  // the same (user, authConfig) unless this is set, failing with "Multiple
  // connected accounts found ... Please use the allowMultiple option". That
  // broke every reconnect (e.g. rotating an Apollo API key) whenever a prior
  // account — even a dead/stale one — still existed. We tolerate it here and
  // reconcile below: single-instance connectors delete the prior account once
  // the new one is adopted, so exactly one account survives.
  const conn = await composio.connectedAccounts.initiate(tenantId, authConfigId, {
    config: authConfigPayload,
    allowMultiple: true,
  });
  // API-key connections are immediately active; poll briefly to confirm before
  // we mark the connector active (surfaces a bad key as a FAILED status).
  const activeAccount = await pollConnectedAccountActive(conn.id, 10_000);
  const identity = await extractComposioIdentity(connectorType, activeAccount, composio, tenantId);

  const composioConfig = {
    externalAccountId: identity.externalAccountId,
    externalAccountLabel: identity.externalAccountLabel,
    composioConnectedAccountId: conn.id,
    composioAuthConfigId: authConfigId,
  };

  // Precedence tier-0: reconnect target (un-claimed row) → adopt directly.
  // Then reuse a row with the same externalAccountId (reconnect of the same
  // Datadog account), else adopt any existing row for this (tenant, type) —
  // including a legacy vendor_hosted api_key row — replacing config wholesale
  // and preserving the connector_id.
  let connector: Awaited<ReturnType<typeof getConnectorById>> = null;
  if (reconnectConnectorId) {
    const t = await getConnectorById(tenantId, reconnectConnectorId);
    if (
      t &&
      t.type === connectorType &&
      !(t.config as { externalAccountId?: string }).externalAccountId
    ) {
      connector = t;
    }
  }
  if (!connector) {
    connector =
      (await findConnectorByTenantTypeAndExternalAccountId(
        tenantId,
        connectorType as ConnectorType,
        identity.externalAccountId,
      )) ?? (await findConnectorByTenantAndType(tenantId, connectorType as ConnectorType));
  }
  // The Composio account this connector referenced before this reconnect, if
  // any — captured before the config merge overwrites it, so we can retire it.
  const priorComposioAccountId =
    (connector?.config as { composioConnectedAccountId?: string } | undefined)?.composioConnectedAccountId;

  if (connector) {
    await mergeConnectorConfig(tenantId, connector.id, composioConfig);
    connector = await updateConnectorStatus(tenantId, connector.id, 'active');
  } else {
    // Reuse-on-conflict guards the unique (tenant, type, account) index against
    // a concurrent connect that created the same account row a moment earlier.
    connector = await createConnectorReusingOnAccountConflict(
      {
        tenantId,
        type: connectorType as ConnectorType,
        name: config.displayName,
        config: composioConfig,
      },
      identity.externalAccountId,
    );
    connector = await updateConnectorStatus(tenantId, connector.id, 'active');
  }

  // Reconnect hygiene: a single-instance connector keeps exactly one Composio
  // account. Now that the connector row points at the new account (conn.id),
  // retire the one it referenced before so allowMultiple:true doesn't leave a
  // stale account behind (best-effort — the row is already correct either way).
  // Multi-instance connectors keep their sibling accounts.
  const isMultiInstance = CONNECTORS[connectorType]?.multiInstance === true;
  if (!isMultiInstance && priorComposioAccountId && priorComposioAccountId !== conn.id) {
    try {
      await deleteComposioConnectedAccount(priorComposioAccountId);
    } catch (err) {
      logger.warn(
        { err, priorComposioAccountId, connectorType },
        'reconnect: failed to delete prior composio account',
      );
    }
  }

  return {
    connectorId: connector.id,
    externalAccountId: identity.externalAccountId,
    externalAccountLabel: identity.externalAccountLabel,
  };
}

function getAccountId(req: Request): string | null {
  const h = req.header('x-account-id');
  return h && typeof h === 'string' && h.length > 0 ? h : null;
}

export const apikeyRouter = Router();

// ──────────────────────────────────────────────────────────────────────
// GET /:connectorType/config — UI form description
// ──────────────────────────────────────────────────────────────────────

apikeyRouter.get('/:connectorType/config', (req: Request, res: Response) => {
  const { connectorType } = req.params;
  const config = API_KEY_CONNECTOR_CONFIGS[connectorType];

  if (!config) {
    return res.status(400).json({
      error: `Connector type '${connectorType}' does not support API key authentication`,
    });
  }

  return res.json({
    connectorType,
    displayName: config.displayName,
    ...(config.description ? { description: config.description } : {}),
    fields: config.fields,
    steps: config.steps,
  });
});

// ──────────────────────────────────────────────────────────────────────
// POST /:connectorType/connect — store API-key credentials
// ──────────────────────────────────────────────────────────────────────

apikeyRouter.post('/:connectorType/connect', async (req: Request, res: Response) => {
  try {
    const { connectorType } = req.params;
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Pull tenantId AND connectorId out of the body so neither leaks into the
    // `credentials` rest object (which is persisted wholesale under
    // metadata.extraFields). connectorId is routing metadata — the reconnect
    // target — not a vendor credential.
    const { tenantId, connectorId: bodyConnectorId, ...credentials } = body as {
      tenantId?: unknown;
      connectorId?: unknown;
    } & Record<string, unknown>;
    // "Reconnect" on a specific card passes that connector row id → reconnect target.
    const reconnectConnectorId =
      typeof bodyConnectorId === 'string' ? bodyConnectorId : undefined;

    const config = API_KEY_CONNECTOR_CONFIGS[connectorType];
    if (!config) {
      return res.status(400).json({
        error: `Connector type '${connectorType}' does not support API key authentication`,
      });
    }

    if (!tenantId || typeof tenantId !== 'string') {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    const accountId = getAccountId(req);
    if (!accountId) {
      return res.status(401).json({ error: 'Authentication required (x-account-id header)' });
    }

    // Validate required fields
    for (const field of config.fields) {
      if (field.required) {
        const value = credentials[field.name];
        if (value === undefined || value === null || value === '') {
          return res.status(400).json({ error: `${field.label} is required` });
        }
      }
    }

    // Composio-managed api_key connectors (e.g. datadog): submit the keys to
    // Composio rather than Secret Manager, then return. Agents reach the
    // toolkit via the composio dispatch path; polling runs through Composio
    // actions. The non-composio path below stores keys locally instead.
    if (CONNECTORS[connectorType]?.mcp?.kind === 'composio_managed') {
      let result;
      try {
        result = await connectComposioApiKeyConnector({ connectorType, tenantId, config, credentials, reconnectConnectorId });
      } catch (err) {
        logger.error(
          { connectorType, tenantId, error: (err as Error).message },
          'composio api-key connect failed',
        );
        return res.status(502).json({
          error: 'Failed to connect. Please check your credentials and try again.',
        });
      }

      try {
        await publishAuditEvent({
          tenantId,
          userId: accountId,
          eventType: 'connector.apikey_connected',
          resourceId: result.connectorId,
          newState: {
            connectorId: result.connectorId,
            connectorType,
            externalAccountId: result.externalAccountId,
            externalAccountLabel: result.externalAccountLabel,
          },
        });
      } catch (auditErr) {
        logger.warn({ err: auditErr, connectorId: result.connectorId }, 'audit publish (composio apikey) failed');
      }

      emitCredentialsStored({ tenantId, connectorId: result.connectorId, connectorType });

      logger.info(
        { connectorId: result.connectorId, connectorType, tenantId, accountId },
        'connector.apikey_connected (composio_managed)',
      );
      return res.json({ success: true, connectorId: result.connectorId, connectorType });
    }

    // Fetch the API-key provider's identity (workspace URL / subdomain /
    // remote whoami) BEFORE find-or-create so a second connection for a
    // DIFFERENT account creates a separate row instead of overwriting.
    //
    // STRICT_VALIDATION_CONNECTOR_TYPES (the six BYOK web-tool vendors)
    // also use the identity-fetch round-trip as a credential validation
    // step: the fetcher's strict helpers throw `InvalidCredentialError`
    // on a 401/403/402 from the vendor, and we surface that here as a
    // 400 so the user gets immediate feedback on /connections rather than
    // discovering the key is wrong at first tool call.
    //
    // Providers without a registered fetcher fall back to single-instance
    // behavior, same as SendGrid/Trello etc.
    let identity;
    try {
      identity = await fetchApiKeyIdentity(connectorType, credentials);
    } catch (err) {
      if (err instanceof InvalidCredentialError &&
          STRICT_VALIDATION_CONNECTOR_TYPES.has(connectorType)) {
        logger.warn(
          { connectorType, statusCode: err.statusCode, error: err.message },
          'api-key strict-validation: vendor rejected credentials',
        );
        return res.status(400).json({
          error: err.statusCode === 402
            ? 'The vendor reported this account is out of credit. Add credit at the vendor console and try again.'
            : 'The vendor rejected this API key. Check the key value and try again.',
        });
      }
      throw err;
    }
    if (identity) {
      logger.info(
        {
          connectorType,
          externalAccountId: identity.externalAccountId,
          externalAccountLabel: identity.externalAccountLabel,
        },
        'api-key identity fetched',
      );
    }

    // Find or create connector — Precedence (identity-authoritative):
    //   identity → dedup by externalAccountId; adopt an un-claimed reconnect
    //   target (heal); else new row. No identity → reconnect target reuse,
    //   else legacy (tenant, type) single-instance.
    let connector: Awaited<ReturnType<typeof getConnectorById>> = null;
    if (identity) {
      connector = await findConnectorByTenantTypeAndExternalAccountId(
        tenantId,
        connectorType as ConnectorType,
        identity.externalAccountId,
      );
      if (!connector && reconnectConnectorId) {
        const t = await getConnectorById(tenantId, reconnectConnectorId);
        if (
          t &&
          t.type === connectorType &&
          !(t.config as { externalAccountId?: string }).externalAccountId
        ) {
          connector = t;
          try {
            await mergeConnectorConfig(tenantId, t.id, {
              externalAccountId: identity.externalAccountId,
              externalAccountLabel: identity.externalAccountLabel,
            });
          } catch (err) {
            if ((err as { code?: string }).code === '23505') {
              const dup = await findConnectorByTenantTypeAndExternalAccountId(
                tenantId,
                connectorType as ConnectorType,
                identity.externalAccountId,
              );
              if (dup) connector = dup;
            } else {
              throw err;
            }
          }
        }
      }
      if (!connector) {
        connector = await createConnectorReusingOnAccountConflict(
          {
            tenantId,
            type: connectorType as ConnectorType,
            name: config.displayName,
            config: {
              externalAccountId: identity.externalAccountId,
              externalAccountLabel: identity.externalAccountLabel,
            },
          },
          identity.externalAccountId,
        );
      }
    } else {
      connector = reconnectConnectorId
        ? await getConnectorById(tenantId, reconnectConnectorId)
        : await findConnectorByTenantAndType(tenantId, connectorType as ConnectorType);
      if (!connector) {
        connector = await createConnector({
          tenantId,
          type: connectorType as ConnectorType,
          name: config.displayName,
        });
      }
    }
    connector = await updateConnectorStatus(tenantId, connector.id, 'pending');

    // Defense-in-depth: legacy rows whose config doesn't already carry the
    // identity get it filled in now. Synchronous so it's durable before
    // the response.
    if (identity) {
      const cfg = (connector.config ?? {}) as {
        externalAccountId?: string;
        externalAccountLabel?: string;
      };
      if (
        cfg.externalAccountId !== identity.externalAccountId ||
        cfg.externalAccountLabel !== identity.externalAccountLabel
      ) {
        await mergeConnectorConfig(tenantId, connector.id, {
          externalAccountId: identity.externalAccountId,
          externalAccountLabel: identity.externalAccountLabel,
        });
      }
    }

    // Datadog is region-scoped: persist the site on connector.config so
    // getMCPServerConfig resolves the correct regional MCP host for agent calls.
    if (connectorType === 'datadog' && typeof credentials.site === 'string') {
      await mergeConnectorConfig(tenantId, connector.id, { site: credentials.site });
    }

    const primaryKey =
      (typeof credentials.apiKey === 'string' ? credentials.apiKey : '') ||
      (typeof credentials.consumerKey === 'string' ? credentials.consumerKey : '') ||
      (typeof credentials.patToken === 'string' ? credentials.patToken : '');

    // Store credential blob in Secret Manager via credentialService.
    // The blob carries the primary key under `apiKey` (so the connector
    // execute dispatcher reads it from the same field as OAuth tokens)
    // AND the full set of fields under `metadata.extraFields` for
    // providers that need multiple values (e.g. Trello apiToken).
    const { apiKey: _apiKey, consumerKey: _consumerKey, patToken: _patToken, ...extra } = credentials;
    void _apiKey;
    void _consumerKey;
    void _patToken;

    try {
      await credentialService.storeCredentials(
        tenantId,
        connector.id,
        'api_key',
        {
          apiKey: primaryKey,
          metadata: {
            authType: 'api_key',
            connectorType,
            extraFields: extra,
          },
        },
        [],
      );
    } catch (secretErr) {
      logger.error(
        { err: (secretErr as Error).message, connectorId: connector.id },
        'Failed to store API key in Secret Manager',
      );
      return res.status(500).json({ error: 'Failed to store credentials securely' });
    }

    // Native HRIS (Workday/Oracle/SAP/Namely): the client reads its structured
    // config from connector.config, so persist the submitted non-key fields there.
    // (The credential blob keeps them under metadata.extraFields, which is surfaced
    // to clients as `extra`, not `connectorConfig`.) Only when flipped native.
    if (isNativeHrisConnector(connectorType) && Object.keys(extra).length > 0) {
      await mergeConnectorConfig(tenantId, connector.id, extra as Record<string, unknown>);
    }

    // Hint for masked UI display
    if (primaryKey.length >= 4) {
      const hint = `•••${primaryKey.slice(-4)}`;
      await updateApiKeyHint(tenantId, connector.id, hint);
    }

    await updateConnectorStatus(tenantId, connector.id, 'active');

    if (connectorType === 'anchor_browser') {
      try {
        const { attachAnchorWebhookToCredential } = await import('./anchor-webhook-registration.js');
        await attachAnchorWebhookToCredential(tenantId, connector.id, primaryKey);
      } catch (err) {
        logger.error(
          { err: (err as Error).message, connectorId: connector.id, tenantId },
          'anchor webhook auto-registration failed; connector active but webhooks will not fire',
        );
      }
    }

    logger.info(
      {
        connectorId: connector.id,
        connectorType,
        tenantId,
        accountId,
      },
      'connector.apikey_connected',
    );

    // Workspace-visible audit: a user connected this api-key connector.
    try {
      await publishAuditEvent({
        tenantId,
        userId: accountId,
        eventType: 'connector.apikey_connected',
        resourceId: connector.id,
        newState: {
          connectorId: connector.id,
          connectorType,
          externalAccountId: identity?.externalAccountId,
          externalAccountLabel: identity?.externalAccountLabel,
        },
      });
    } catch (err) {
      logger.warn(
        { err, connectorId: connector.id },
        'audit publish (connector.apikey_connected) failed',
      );
    }

    // Fire-and-forget cross-service signal so platform-backend can
    // resolve any `pending_integrations` entries on this connector type.
    emitCredentialsStored({
      tenantId,
      connectorId: connector.id,
      connectorType,
    });

    return res.json({
      success: true,
      connectorId: connector.id,
      connectorType,
    });
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'API key connect failed');
    return res.status(500).json({
      error: 'Failed to connect. Please check your credentials and try again.',
    });
  }
});

// One-shot admin endpoint: register Anchor webhook for an existing
// anchor_browser connector. Used to backfill connectors created before the
// auto-registration hook landed. Requires X-Service-Auth.
apikeyRouter.post('/:connectorId/register-anchor-webhook', async (req, res) => {
  try {
    const tenantId = (req.headers['x-tenant-id'] as string) ?? (req.body?.tenantId as string);
    if (!tenantId) return res.status(400).json({ error: 'tenantId required (x-tenant-id header or body)' });
    const { connectorId } = req.params;
    const { credentialService } = await import('../credentials/service.js');
    const cred = await credentialService.getCredentials(tenantId, connectorId);
    if (!cred?.apiKey) return res.status(404).json({ error: 'connector has no stored apiKey' });
    const { attachAnchorWebhookToCredential } = await import('./anchor-webhook-registration.js');
    await attachAnchorWebhookToCredential(tenantId, connectorId, cred.apiKey);
    return res.json({ success: true });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'register-anchor-webhook failed');
    return res.status(500).json({ error: (err as Error).message });
  }
});
