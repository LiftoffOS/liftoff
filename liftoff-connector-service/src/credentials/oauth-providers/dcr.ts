// Dynamic Client Registration (DCR) OAuth refresh handler.
//
// Covers every vendor that publishes an OAuth authorization-server
// metadata document and requires per-deployment registration of an
// OAuth client:
//   Notion, Linear, Calendly, Asana, Datadog, PayPal, Granola
//
// The DCR flow shares a single refresh mechanism: read the issuer's
// tokenEndpoint + clientId from `oauth_dynamic_registrations`, POST a
// form-encoded refresh_token grant as a PUBLIC client (no client_secret
// for providers that support PKCE-style public registration) or with
// `client_secret` from the same DB row otherwise.
//
// SSRF: the tokenEndpoint read from the DB is allowlisted against the
// known issuer host suffixes before the fetch — DB corruption can't
// exfiltrate refresh tokens to attacker-controlled hosts.
//
// Notion rotates refresh_tokens on every refresh — buildSecretData's
// fallback already handles this by preferring body.refresh_token.

import {
  OAuthRefreshError,
  registerOAuthRefreshHandler,
  type OAuthRefreshHandler,
} from '../service.js';
import { withAdminScope } from '../../db/pool.js';
import {
  buildSecretData,
  classifyVendorError,
  postTokenRequest,
} from './common.js';

const DEFAULT_TTL_SEC = 60 * 60; // 1 hour

// Mapping from connector type → issuer URL stored in
// oauth_dynamic_registrations.issuer. The issuer is the OAuth AS's
// well-known root, e.g. Notion's issuer is https://api.notion.com.
const DCR_ISSUER_BY_TYPE: Record<string, string> = {
  notion: 'https://api.notion.com',
  linear: 'https://api.linear.app',
  calendly: 'https://auth.calendly.com',
  asana: 'https://app.asana.com',
  paypal: 'https://api-m.paypal.com',
  clay: 'https://api.clay.com',
  mesh: 'https://mcp.clay.earth',
  granola: 'https://mcp-auth.granola.ai',
  attio: 'https://app.attio.com',
  // Each issuer below was read from the vendor's LIVE
  // protected-resource metadata (authorization_servers[0]), not inferred:
  // pandadoc publishes none, so per resolveAuthServerUrl its discovery base is
  // the authorization server.
  stripe: 'https://access.stripe.com/mcp',
  outreach: 'https://api.outreach.io',
  zoominfo: 'https://mcp.zoominfo.com',
  common_room: 'https://login.commonroom.io',
  similarweb: 'https://mcp-auth.similarweb.com',
  ahrefs: 'https://api.ahrefs.com',
  supermetrics: 'https://api.supermetrics.com',
  pandadoc: 'https://mcp.pandadoc.com',
  // Marketing connectors. Same rule: authorization_servers[0]
  // from the vendor's live protected-resource metadata; where a vendor
  // publishes none, its discovery base per resolveAuthServerUrl.
  klaviyo: 'https://mcp.klaviyo.com',
  kit: 'https://api.kit.com',
  omnisend: 'https://mcp.omnisend.com',
  amplitude: 'https://mcp.amplitude.com',
  pendo: 'https://app.pendo.io',
  webflow: 'https://mcp.webflow.com',
  typefully: 'https://api.typefully.com',
  crustdata: 'https://install.crustdata.com',
  tapfiliate: 'https://mcp.tapfiliate.com',
  partnerstack: 'https://mcp.partnerstack.com',
  crossbeam: 'https://mcp.crossbeam.com',
  paddle: 'https://id.paddle.com',
  salesloft: 'https://accounts.salesloft.com/mcp',
  snov: 'https://app.snov.io',
  sparktoro: 'https://sparktoro.com',
  livestorm: 'https://mcp.livestorm.co',
  coupler: 'https://auth.coupler.io',
  keywords_everywhere: 'https://mcp.keywordseverywhere.com',
  demandbase: 'https://gateway.demandbase.com',
};

// Host allowlist — token endpoints must match one of these suffixes.
// Keeps SSRF protection in place even if the DB row is tampered with.
const ALLOWED_TOKEN_HOSTS = [
  'notion.com', 'notion.so', 'api.notion.com', 'mcp.notion.com',
  'linear.app', 'api.linear.app', 'mcp.linear.app',
  'calendly.com', 'auth.calendly.com', 'mcp.calendly.com',
  'asana.com', 'app.asana.com', 'mcp.asana.com',
  'datadoghq.com', 'api.datadoghq.com', 'mcp.datadoghq.com', 'app.datadoghq.com',
  'paypal.com', 'api-m.paypal.com', 'api.paypal.com', 'mcp.paypal.com',
  'clay.com', 'api.clay.com', 'app.clay.com',
  'clay.earth', 'mcp.clay.earth',
  'granola.ai', 'mcp.granola.ai', 'mcp-auth.granola.ai',
  'attio.com', 'mcp.attio.com', 'app.attio.com',
  'stripe.com', 'mcp.stripe.com', 'access.stripe.com',
  'outreach.io', 'api.outreach.io',
  'zoominfo.com', 'mcp.zoominfo.com', 'okta-login.zoominfo.com',
  'commonroom.io', 'mcp.commonroom.io', 'login.commonroom.io',
  'similarweb.com', 'mcp.similarweb.com', 'mcp-auth.similarweb.com',
  'ahrefs.com', 'api.ahrefs.com', 'app.ahrefs.com',
  'supermetrics.com', 'mcp.supermetrics.com', 'api.supermetrics.com',
  'pandadoc.com', 'mcp.pandadoc.com',
  // Marketing connectors
  'klaviyo.com', 'mcp.klaviyo.com', 'kit.com', 'app.kit.com', 'api.kit.com',
  'omnisend.com', 'app.omnisend.com', 'mcp.omnisend.com', 'amplitude.com', 'mcp.amplitude.com',
  'pendo.io', 'app.pendo.io', 'webflow.com', 'mcp.webflow.com', 'typefully.com', 'api.typefully.com',
  'crustdata.com', 'install.crustdata.com', 'tapfiliate.com', 'mcp.tapfiliate.com', 'app.tapfiliate.com',
  'partnerstack.com', 'mcp.partnerstack.com', 'crossbeam.com', 'mcp.crossbeam.com',
  'paddle.com', 'id.paddle.com', 'salesloft.com', 'accounts.salesloft.com', 'snov.io', 'app.snov.io',
  'sparktoro.com', 'livestorm.co', 'mcp.livestorm.co', 'coupler.io', 'auth.coupler.io',
  'keywordseverywhere.com', 'mcp.keywordseverywhere.com', 'demandbase.com', 'authentication.demandbase.com',
];

function assertAllowedTokenEndpoint(
  tokenEndpoint: string,
  ctx: { connectorId: string; tenantId: string; vendor: string },
): URL {
  let parsed: URL;
  try {
    parsed = new URL(tokenEndpoint);
  } catch {
    throw new OAuthRefreshError(
      'unknown',
      `${ctx.vendor} DCR refresh: tokenEndpoint is not a valid URL: ${tokenEndpoint}`,
      ctx,
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new OAuthRefreshError(
      'unknown',
      `${ctx.vendor} DCR refresh blocked: tokenEndpoint must be https (got ${parsed.protocol})`,
      ctx,
    );
  }
  const hostname = parsed.hostname.toLowerCase();
  const isAllowed = ALLOWED_TOKEN_HOSTS.some(
    (h) => hostname === h || hostname.endsWith(`.${h}`),
  );
  if (!isAllowed) {
    throw new OAuthRefreshError(
      'unknown',
      `${ctx.vendor} DCR refresh blocked: tokenEndpoint host ${hostname} not in allowlist`,
      ctx,
    );
  }
  return parsed;
}

interface DcrRegistration {
  clientId: string;
  clientSecret: string | null;
  tokenEndpoint: string;
}

// Visible-for-testing. Tests inject a stub to avoid hitting the admin DB.
// `site` carries the Datadog region (from the connection's site sentinel) so
// the lookup targets the region-qualified registration + token endpoint.
let dcrLookup: (
  connectorType: string,
  ctx: { connectorId: string; tenantId: string; vendor: string },
) => Promise<DcrRegistration> = defaultDcrLookup;

export function __setDcrLookup(fn: typeof dcrLookup | null): void {
  dcrLookup = fn ?? defaultDcrLookup;
}

async function defaultDcrLookup(
  connectorType: string,
  ctx: { connectorId: string; tenantId: string; vendor: string },
): Promise<DcrRegistration> {
  if (!DCR_ISSUER_BY_TYPE[connectorType]) {
    throw new OAuthRefreshError(
      'unknown',
      `No DCR issuer configured for connector type ${connectorType}`,
      ctx,
    );
  }

  // Discovery keys registrations by `provider` (migration 004 dropped the old
  // `issuer`/`client_secret` columns). These are public PKCE clients — no secret.
  // Prefer the token_endpoint discovery actually persisted, falling back to the
  // per-vendor convention only for legacy rows that predate the column.
  const row = await withAdminScope(
    { caller: 'liftoff-connector-service:dcr-refresh', reason: 'dcr_registration_lookup' },
    async (client) => {
      const res = await client.query<{ client_id: string; token_endpoint: string | null }>(
        `SELECT client_id, token_endpoint
         FROM oauth_dynamic_registrations
         WHERE provider = $1
         LIMIT 1`,
        [connectorType],
      );
      return res.rows[0];
    },
  );

  if (!row) {
    throw new OAuthRefreshError(
      'reconnect_required',
      `No DCR registration found for ${connectorType} — re-run dynamic client registration`,
      ctx,
    );
  }

  return {
    clientId: row.client_id,
    clientSecret: null,
    tokenEndpoint: row.token_endpoint ?? resolveTokenEndpoint(connectorType),
  };
}

function resolveTokenEndpoint(connectorType: string): string {
  switch (connectorType) {
    case 'notion':
      return 'https://api.notion.com/v1/oauth/token';
    case 'linear':
      return 'https://api.linear.app/oauth/token';
    case 'calendly':
      return 'https://auth.calendly.com/oauth/token';
    case 'asana':
      return 'https://app.asana.com/-/oauth_token';
    case 'paypal':
      return 'https://api-m.paypal.com/v1/oauth2/token';
    case 'clay':
      return 'https://api.clay.com/oauth/token';
    case 'mesh':
      return 'https://mcp.clay.earth/token';
    case 'granola':
      return 'https://mcp-auth.granola.ai/oauth2/token';
    case 'attio':
      return 'https://app.attio.com/oidc/token';
    case 'stripe':
      return 'https://access.stripe.com/mcp/oauth2/token';
    // The other types added in this change deliberately have no case here.
    // `defaultDcrLookup` PREFERS the token_endpoint discovery persisted on the
    // registration row, and this switch is only the fallback for legacy rows
    // that predate that column — which none of them can have, since none had a
    // refresh handler until now. A guessed endpoint here would be a landmine
    // that only fires on the path nobody exercises.
    default:
      return `${DCR_ISSUER_BY_TYPE[connectorType] ?? ''}/oauth/token`;
  }
}

const refreshDcr: OAuthRefreshHandler = async (args) => {
  const ctx = { connectorId: args.connectorId, tenantId: args.tenantId, vendor: args.connectorType };
  const reg = await dcrLookup(args.connectorType, ctx);
  assertAllowedTokenEndpoint(reg.tokenEndpoint, ctx);

  // Form body: some vendors are strict about content-type. Build with
  // clientSecret only if the DB row has one.
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: args.refreshToken,
    client_id: reg.clientId,
  });
  if (reg.clientSecret) {
    params.set('client_secret', reg.clientSecret);
  }

  const response = await postTokenRequest({
    url: reg.tokenEndpoint,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
    ctx,
  });

  // Notion's refresh_token rotates — buildSecretData prefers body.refresh_token.
  return buildSecretData({
    body: response,
    refreshTokenFallback: args.refreshToken,
    defaultTtlSec: DEFAULT_TTL_SEC,
    scopes: args.scopes.length > 0 ? args.scopes : undefined,
  });
};

// EVERY dcr_oauth connector in the catalog must appear here. A DCR token
// expires; without a handler the first refresh throws
// "No OAuth refresh handler registered for <type>", which is classified
// reconnect_required, and the connector dies about an hour after it was
// connected. This is not one vendor's bug: any dcr_oauth connector missing
// from this list fails the same way, as does a microsoft_* connector with no
// refresh handler.
const DCR_CONNECTOR_TYPES = [
  'notion', 'linear', 'calendly', 'asana', 'paypal', 'clay', 'mesh', 'granola', 'attio',
  'stripe', 'outreach', 'zoominfo', 'common_room', 'similarweb', 'ahrefs', 'supermetrics', 'pandadoc',
  // Marketing connectors, plus salesloft (DCR rather than static_oauth).
  'klaviyo', 'kit', 'omnisend', 'amplitude', 'pendo', 'webflow', 'typefully', 'crustdata',
  'tapfiliate', 'partnerstack', 'crossbeam', 'paddle', 'salesloft', 'snov', 'sparktoro',
  'livestorm', 'coupler', 'keywords_everywhere', 'demandbase',
];

for (const type of DCR_CONNECTOR_TYPES) {
  registerOAuthRefreshHandler(type, refreshDcr);
}

export {
  refreshDcr,
  DCR_CONNECTOR_TYPES,
  DCR_ISSUER_BY_TYPE,
  assertAllowedTokenEndpoint,
  resolveTokenEndpoint,
  classifyVendorError as _classifyForDcr,
};
