// Per-provider identity fetchers.
//
// After an OAuth token exchange completes, we call the provider's "whoami"
// endpoint to obtain a stable identifier for the connected account. This
// drives two things:
//
//   1. `externalAccountId` — stable unique id per (provider, account). The
//      OAuth callback uses it to key the find-or-create lookup so a SECOND
//      OAuth for a DIFFERENT account on the same connector type creates a
//      separate connector row (multi-instance), and a re-OAuth of the SAME
//      account resurrects the existing row.
//
//   2. `externalAccountLabel` — human-readable display string for the
//      Connected card subtitle (email / workspace name / login / etc.).
//      The frontend reads this directly; it must never fall back to a
//      generic "category" string on a Connected card.
//
// When a provider's identity endpoint isn't yet implemented here, the
// fetcher returns null and the OAuth callback falls back to the legacy
// (tenant, type) lookup — i.e. that connector type stays single-instance
// until an entry is added here. The goal is zero null returns: every
// provider in OAUTH_PROVIDER_CONFIGS should have a fetcher.
//
// Implementations are deliberately minimal — one fetch per provider, parse
// the smallest possible response, fail soft (return null on any error).
// Server-side identity calls only run during the OAuth callback (low
// frequency), so simple sequential code is fine.

import { logger } from '../infra/logging.js';
import type { OAuthProvider } from '../types.js';

export interface ExternalIdentity {
  /** Stable unique id per account on this provider (used for lookup keying). */
  externalAccountId: string;
  /**
   * Human-readable label for UI display (email / workspace / login). `null`
   * means the vendor exposes no meaningful per-account identifier — the
   * Connections UI should fall through to the masked `apiKeyHint` instead
   * of echoing the vendor name as a redundant subtitle. Used by
   * Tavily/Exa/Firecrawl/Anchor/WebClaw, which all lack a whoami-style
   * endpoint that returns anything more useful than the vendor name.
   */
  externalAccountLabel: string | null;
}

type IdentityFetcher = (
  accessToken: string,
  extras?: { instanceUrl?: string; subdomain?: string; connectorType?: string },
) => Promise<ExternalIdentity | null>;

// Helper: GET JSON with a bearer token. Returns null on any non-2xx.
async function fetchJson(
  url: string,
  accessToken: string,
  extraHeaders: Record<string, string> = {},
): Promise<Record<string, unknown> | null> {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, ...extraHeaders },
  });
  if (!resp.ok) return null;
  return (await resp.json()) as Record<string, unknown>;
}

// ─── Google ────────────────────────────────────────────────────────────
// Covers every google_* connector type. Each product has its own OAuth scope
// (drive, gmail.modify, spreadsheets, …) and the canonical userinfo endpoint
// requires `openid email` — which we now request on every Google connector,
// but existing tokens may pre-date that change. To handle both cases we try
// userinfo first, then fall back to a product-specific endpoint reachable
// with the product's own scope.
const fetchGoogleIdentity: IdentityFetcher = async (accessToken, extras) => {
  const type = extras?.connectorType ?? '';

  // 1) Generic OIDC userinfo — works when openid+email scopes were granted.
  const userinfoResp = await fetch(
    'https://www.googleapis.com/oauth2/v2/userinfo',
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (userinfoResp.ok) {
    const userinfo = (await userinfoResp.json()) as { id?: string; email?: string };
    if (typeof userinfo.email === 'string') {
      return {
        externalAccountId: userinfo.id ?? userinfo.email,
        externalAccountLabel: userinfo.email,
      };
    }
  } else {
    logger.info(
      { connectorType: type, status: userinfoResp.status },
      'google identity: userinfo unavailable, falling back',
    );
  }

  // 2) Product-specific fallback for legacy tokens lacking openid/email.

  if (type === 'google_mail') {
    const resp = await fetch(
      'https://www.googleapis.com/gmail/v1/users/me/profile',
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!resp.ok) {
      const body = await resp.text();
      logger.warn(
        { connectorType: type, status: resp.status, body: body.slice(0, 200) },
        'google identity: gmail profile fallback failed',
      );
    } else {
      const profile = (await resp.json()) as { emailAddress?: string };
      if (profile.emailAddress) {
        return {
          externalAccountId: profile.emailAddress,
          externalAccountLabel: profile.emailAddress,
        };
      }
      logger.warn(
        { connectorType: type, keys: Object.keys(profile) },
        'google identity: gmail profile returned no emailAddress',
      );
    }
  }

  if (type === 'google_calendar') {
    const resp = await fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary',
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!resp.ok) {
      const body = await resp.text();
      logger.warn(
        { connectorType: type, status: resp.status, body: body.slice(0, 200) },
        'google identity: calendar primary fallback failed',
      );
    } else {
      const cal = (await resp.json()) as { id?: string; summary?: string };
      if (cal.id && cal.id.includes('@')) {
        return { externalAccountId: cal.id, externalAccountLabel: cal.id };
      }
      // For non-personal calendars, summary may be more descriptive than the id.
      if (cal.summary) {
        return {
          externalAccountId: cal.id ?? cal.summary,
          externalAccountLabel: cal.summary,
        };
      }
    }
  }

  if (
    type === 'google_drive' ||
    type === 'google_slides' ||
    type === 'google_docs' ||
    type === 'google_sheets'
  ) {
    const resp = await fetch(
      'https://www.googleapis.com/drive/v3/about?fields=user',
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!resp.ok) {
      const body = await resp.text();
      logger.warn(
        { connectorType: type, status: resp.status, body: body.slice(0, 200) },
        'google identity: drive about fallback failed',
      );
    } else {
      const about = (await resp.json()) as {
        user?: { emailAddress?: string; displayName?: string };
      };
      if (about.user?.emailAddress) {
        return {
          externalAccountId: about.user.emailAddress,
          externalAccountLabel: about.user.emailAddress,
        };
      }
    }
  }

  // google_tasks / google_contacts have no first-class /me endpoint; rely on
  // userinfo (means the user must grant openid email on reconnect).
  return null;
};

// ─── Slack ─────────────────────────────────────────────────────────────
// auth.test returns workspace+user identity. We key on team_id (workspace)
// because Slack connections are workspace-scoped from the user's perspective.
const fetchSlackIdentity: IdentityFetcher = async (accessToken) => {
  const resp = await fetch('https://slack.com/api/auth.test', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as {
    ok?: boolean;
    team_id?: string;
    team?: string;
    user_id?: string;
    user?: string;
  };
  if (!data.ok || !data.team_id) return null;
  return {
    externalAccountId: data.team_id,
    externalAccountLabel: data.team ?? data.team_id,
  };
};

// ─── GitHub ────────────────────────────────────────────────────────────
const fetchGithubIdentity: IdentityFetcher = async (accessToken) => {
  const data = await fetchJson('https://api.github.com/user', accessToken, {
    Accept: 'application/vnd.github+json',
  });
  if (!data || typeof data.login !== 'string') return null;
  return {
    externalAccountId: String(data.id ?? data.login),
    externalAccountLabel: data.login as string,
  };
};

// ─── GitLab ────────────────────────────────────────────────────────────
// GET /api/v4/user → the authenticated user. `username` is the login the
// team's MRs/notes are authored under, so it becomes externalAccountLabel →
// bot_login (the self-event exclusion), mirroring github's `login`.
const fetchGitlabIdentity: IdentityFetcher = async (accessToken) => {
  const data = await fetchJson('https://gitlab.com/api/v4/user', accessToken);
  if (!data || typeof data.username !== 'string') return null;
  return {
    externalAccountId: String(data.id ?? data.username),
    externalAccountLabel: data.username as string,
  };
};

// ─── Microsoft (Graph) ─────────────────────────────────────────────────
const fetchMicrosoftIdentity: IdentityFetcher = async (accessToken) => {
  const data = await fetchJson(
    'https://graph.microsoft.com/v1.0/me',
    accessToken,
  );
  if (!data) return null;
  const id =
    (data.id as string | undefined) ??
    (data.userPrincipalName as string | undefined);
  const label =
    (data.mail as string | undefined) ??
    (data.userPrincipalName as string | undefined) ??
    (data.displayName as string | undefined);
  if (!id || !label) return null;
  return { externalAccountId: id, externalAccountLabel: label };
};

// ─── Notion ────────────────────────────────────────────────────────────
// /v1/users/me returns either a `person` (user token) or a `bot` (integration
// token, with workspace_name). Prefer workspace_name when present since
// connections are workspace-level.
const fetchNotionIdentity: IdentityFetcher = async (accessToken) => {
  const data = await fetchJson(
    'https://api.notion.com/v1/users/me',
    accessToken,
    { 'Notion-Version': '2022-06-28' },
  );
  if (!data) return null;
  const id = data.id as string | undefined;
  const bot = data.bot as
    | { workspace_name?: string; owner?: { user?: { person?: { email?: string } } } }
    | undefined;
  const person = data.person as { email?: string } | undefined;
  const label =
    bot?.workspace_name ??
    bot?.owner?.user?.person?.email ??
    person?.email ??
    (data.name as string | undefined);
  if (!id || !label) return null;
  return { externalAccountId: id, externalAccountLabel: label };
};

// ─── Atlassian (Jira + Confluence) ─────────────────────────────────────
// /me returns the account_id (stable per Atlassian-cloud account). The
// accessible-resources endpoint gives workspace URLs, but for identity
// /me is sufficient.
const fetchAtlassianIdentity: IdentityFetcher = async (accessToken) => {
  const data = await fetchJson('https://api.atlassian.com/me', accessToken);
  if (!data) return null;
  const id = data.account_id as string | undefined;
  const label =
    (data.email as string | undefined) ??
    (data.name as string | undefined) ??
    id;
  if (!id || !label) return null;
  return { externalAccountId: id, externalAccountLabel: label };
};

// ─── Zoom ──────────────────────────────────────────────────────────────
const fetchZoomIdentity: IdentityFetcher = async (accessToken) => {
  const data = await fetchJson(
    'https://api.zoom.us/v2/users/me',
    accessToken,
  );
  if (!data) return null;
  const id = (data.id as string | undefined) ?? (data.email as string | undefined);
  const label = (data.email as string | undefined) ?? id;
  if (!id || !label) return null;
  return { externalAccountId: id, externalAccountLabel: label };
};

// ─── HubSpot ───────────────────────────────────────────────────────────
// access_tokens/<token> returns hub_id (portal id) — the workspace-level
// identifier the connection lives in.
const fetchHubspotIdentity: IdentityFetcher = async (accessToken) => {
  const resp = await fetch(
    `https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(accessToken)}`,
  );
  if (!resp.ok) return null;
  const data = (await resp.json()) as {
    hub_id?: number;
    hub_domain?: string;
    user?: string;
  };
  if (!data.hub_id) return null;
  return {
    externalAccountId: String(data.hub_id),
    externalAccountLabel: data.hub_domain ?? data.user ?? String(data.hub_id),
  };
};

// ─── Salesforce ────────────────────────────────────────────────────────
// Needs the instance_url from the token response — we pass it through extras.
const fetchSalesforceIdentity: IdentityFetcher = async (accessToken, extras) => {
  const base = extras?.instanceUrl;
  if (!base) return null;
  const data = await fetchJson(
    `${base.replace(/\/$/, '')}/services/oauth2/userinfo`,
    accessToken,
  );
  if (!data) return null;
  const id =
    (data.user_id as string | undefined) ??
    (data.sub as string | undefined);
  const label =
    (data.email as string | undefined) ??
    (data.preferred_username as string | undefined) ??
    id;
  if (!id || !label) return null;
  return { externalAccountId: id, externalAccountLabel: label };
};

// ─── Dropbox ───────────────────────────────────────────────────────────
const fetchDropboxIdentity: IdentityFetcher = async (accessToken) => {
  const resp = await fetch(
    'https://api.dropboxapi.com/2/users/get_current_account',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
  if (!resp.ok) return null;
  const data = (await resp.json()) as {
    account_id?: string;
    email?: string;
    name?: { display_name?: string };
  };
  if (!data.account_id) return null;
  return {
    externalAccountId: data.account_id,
    externalAccountLabel:
      data.email ?? data.name?.display_name ?? data.account_id,
  };
};

// ─── Box ───────────────────────────────────────────────────────────────
const fetchBoxIdentity: IdentityFetcher = async (accessToken) => {
  const data = await fetchJson('https://api.box.com/2.0/users/me', accessToken);
  if (!data) return null;
  const id = data.id as string | undefined;
  const label =
    (data.login as string | undefined) ??
    (data.name as string | undefined) ??
    id;
  if (!id || !label) return null;
  return { externalAccountId: id, externalAccountLabel: label };
};

// ─── Asana ─────────────────────────────────────────────────────────────
const fetchAsanaIdentity: IdentityFetcher = async (accessToken) => {
  const data = await fetchJson(
    'https://app.asana.com/api/1.0/users/me',
    accessToken,
  );
  if (!data || !data.data) return null;
  const user = data.data as { gid?: string; email?: string; name?: string };
  if (!user.gid) return null;
  return {
    externalAccountId: user.gid,
    externalAccountLabel: user.email ?? user.name ?? user.gid,
  };
};

// ─── Linear ────────────────────────────────────────────────────────────
// GraphQL: viewer { id email name }
const fetchLinearIdentity: IdentityFetcher = async (accessToken) => {
  const resp = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: '{ viewer { id email name } }' }),
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as {
    data?: { viewer?: { id?: string; email?: string; name?: string } };
  };
  const v = data.data?.viewer;
  if (!v?.id) return null;
  return {
    externalAccountId: v.id,
    externalAccountLabel: v.email ?? v.name ?? v.id,
  };
};

// ─── Calendly ──────────────────────────────────────────────────────────
const fetchCalendlyIdentity: IdentityFetcher = async (accessToken) => {
  const data = await fetchJson(
    'https://api.calendly.com/users/me',
    accessToken,
  );
  if (!data?.resource) return null;
  const u = data.resource as { uri?: string; email?: string; name?: string };
  if (!u.uri) return null;
  return {
    externalAccountId: u.uri,
    externalAccountLabel: u.email ?? u.name ?? u.uri,
  };
};

// ─── DocuSign ──────────────────────────────────────────────────────────
// OIDC userinfo endpoint. /oauth/userinfo returns { sub, name, email, accounts: [...] }.
// Demo and production are separate hosts; match the OAuth host bound in the
// catalog (account-d for dev, account for prod) so the dev/demo app resolves.
const DOCUSIGN_OAUTH_HOST =
  (process.env.ENVIRONMENT ?? 'dev') === 'prod'
    ? 'https://account.docusign.com'
    : 'https://account-d.docusign.com';
const fetchDocusignIdentity: IdentityFetcher = async (accessToken) => {
  const data = await fetchJson(
    `${DOCUSIGN_OAUTH_HOST}/oauth/userinfo`,
    accessToken,
  );
  if (!data) return null;
  const id =
    (data.sub as string | undefined) ??
    (data.email as string | undefined);
  const label =
    (data.email as string | undefined) ??
    (data.name as string | undefined) ??
    id;
  if (!id || !label) return null;
  return { externalAccountId: id, externalAccountLabel: label };
};

// ─── Stripe ────────────────────────────────────────────────────────────
// Identity comes from the MCP, NOT from api.stripe.com/v1/account.
//
// The connector authenticates by DCR against access.stripe.com/mcp and is
// granted scope `mcp`. That token addresses the MCP server, not the REST API —
// calling /v1/account with it returns nothing usable, so identity read that way
// comes back as a null externalAccountId and a blank label. Same shape as attio's REST path: an MCP-audience token cannot reach
// the vendor's REST API however well-formed the request is.
//
// `list_available_accounts_or_orgs` is on the tool list this token actually
// exposes (verified live against a connected account) and answers
// with exactly the two fields identity needs:
//   {"accounts":[{"stripe_context":"acct_…","livemode":true,"name":"…"}]}
//
// Note the tool set is TOKEN-DEPENDENT: a platform secret key sees
// get_stripe_account_info and no list_available_accounts_or_orgs, while a DCR
// connector token sees the reverse. Probe with the credential the code will
// actually hold, not a convenient one.
const fetchStripeIdentity: IdentityFetcher = async (accessToken) => {
  const res = await fetch("https://mcp.stripe.com/", {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_available_accounts_or_orgs', arguments: {} },
    }),
  }).catch(() => null);
  if (!res || !res.ok) return null;

  // The MCP server may answer as SSE, so pull the JSON envelope out rather than
  // assuming the body parses whole.
  const raw = await res.text().catch(() => '');
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let payload: { result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> } };
  try {
    payload = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (payload.result?.isError) return null;
  const text = payload.result?.content?.find((c) => c.type === 'text')?.text;
  if (!text) return null;

  let accounts: Array<{ stripe_context?: string; name?: string }>;
  try {
    accounts = (JSON.parse(text) as { accounts?: Array<{ stripe_context?: string; name?: string }> }).accounts ?? [];
  } catch {
    return null;
  }
  const first = accounts[0];
  const id = first?.stripe_context;
  if (!id) return null;
  return { externalAccountId: id, externalAccountLabel: first?.name ?? id };
};

// ─── Zendesk ───────────────────────────────────────────────────────────
// Subdomain-scoped — extras.subdomain must be set. /api/v2/users/me returns
// { user: { id, email, name } }.
const fetchZendeskIdentity: IdentityFetcher = async (accessToken, extras) => {
  if (!extras?.subdomain) return null;
  const data = await fetchJson(
    `https://${extras.subdomain}.zendesk.com/api/v2/users/me.json`,
    accessToken,
  );
  if (!data?.user) return null;
  const u = data.user as { id?: number; email?: string; name?: string };
  if (!u.id) return null;
  return {
    externalAccountId: `${extras.subdomain}:${u.id}`,
    externalAccountLabel: u.email ?? u.name ?? `${extras.subdomain} (#${u.id})`,
  };
};

// ─── Intuit (QuickBooks) ───────────────────────────────────────────────
// Userinfo via OIDC discovery.
const fetchIntuitIdentity: IdentityFetcher = async (accessToken) => {
  const data = await fetchJson(
    'https://accounts.platform.intuit.com/v1/openid_connect/userinfo',
    accessToken,
  );
  if (!data) return null;
  const id =
    (data.sub as string | undefined) ??
    (data.email as string | undefined);
  const label =
    (data.email as string | undefined) ??
    (data.givenName as string | undefined) ??
    id;
  if (!id || !label) return null;
  return { externalAccountId: id, externalAccountLabel: label };
};

// ─── Xero ──────────────────────────────────────────────────────────────
// /connections returns tenants; pick the first.
const fetchXeroIdentity: IdentityFetcher = async (accessToken) => {
  const resp = await fetch('https://api.xero.com/connections', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) return null;
  const arr = (await resp.json()) as Array<{
    tenantId?: string;
    tenantName?: string;
  }>;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const t = arr[0];
  if (!t.tenantId) return null;
  return {
    externalAccountId: t.tenantId,
    externalAccountLabel: t.tenantName ?? t.tenantId,
  };
};

// ─── Meta ──────────────────────────────────────────────────────────────
const fetchMetaIdentity: IdentityFetcher = async (accessToken) => {
  const data = await fetchJson(
    `https://graph.facebook.com/v21.0/me?fields=id,name,email&access_token=${encodeURIComponent(accessToken)}`,
    accessToken,
  );
  if (!data) return null;
  const id = data.id as string | undefined;
  const label =
    (data.email as string | undefined) ??
    (data.name as string | undefined) ??
    id;
  if (!id || !label) return null;
  return { externalAccountId: id, externalAccountLabel: label };
};

// ─── Attio ─────────────────────────────────────────────────────────────
// MCP-first OAuth via DCR. /v2/self returns workspace identity.
const fetchAttioIdentity: IdentityFetcher = async (accessToken) => {
  const data = await fetchJson('https://api.attio.com/v2/self', accessToken);
  if (!data?.data) return null;
  const d = data.data as { workspace_id?: string; workspace_name?: string; workspace_slug?: string };
  if (!d.workspace_id) return null;
  return {
    externalAccountId: d.workspace_id,
    externalAccountLabel: d.workspace_name ?? d.workspace_slug ?? d.workspace_id,
  };
};

// ─── Outreach ──────────────────────────────────────────────────────────
// Outreach exposes /api/v2/users with a "currentUser" filter. The canonical
// way is /api/v2/users?filter[email]=current — but most reliably, when we
// list users sorted by created-at and pick the authenticated one via the
// `me` relationship. Conservative approach: hit /api/v2/users?count=false
// with a small page and use the first matching the access token's owner.
// Outreach also supports the OAuth `/oauth/me` endpoint on some tenants.
const fetchOutreachIdentity: IdentityFetcher = async (accessToken) => {
  // Try the OIDC-style endpoint first (some Outreach tenants expose it).
  const oidc = await fetchJson('https://api.outreach.io/oauth/userinfo', accessToken);
  if (oidc) {
    const id = (oidc.sub as string | undefined) ?? (oidc.email as string | undefined);
    const label = (oidc.email as string | undefined) ?? (oidc.name as string | undefined) ?? id;
    if (id && label) return { externalAccountId: id, externalAccountLabel: label };
  }
  // Fallback: list current users.
  const users = await fetchJson(
    'https://api.outreach.io/api/v2/users?filter[email]=current',
    accessToken,
  );
  const arr = (users?.data as Array<{ id?: string | number; attributes?: { email?: string; name?: string } }>) ?? [];
  if (arr.length > 0 && arr[0].id) {
    return {
      externalAccountId: String(arr[0].id),
      externalAccountLabel:
        arr[0].attributes?.email ?? arr[0].attributes?.name ?? String(arr[0].id),
    };
  }
  return null;
};

// ─── Gong ──────────────────────────────────────────────────────────────
// Gong doesn't expose a /me endpoint publicly; the closest stable identifier
// is /v2/users/extensive which can be filtered by the access token's user.
// As a best-effort, we call /v2/users with a page=1, size=1 query and pick
// the first row that matches the bearer (since Gong tokens are user-scoped
// only what they can see). For larger workspaces this may return any user;
// it's safe to fall through to null when uncertain.
const fetchGongIdentity: IdentityFetcher = async (accessToken) => {
  const data = await fetchJson('https://api.gong.io/v2/users', accessToken);
  if (!data?.users) return null;
  const arr = (data.users as Array<{ id?: string; emailAddress?: string; firstName?: string; lastName?: string }>);
  if (!Array.isArray(arr) || arr.length === 0 || !arr[0].id) return null;
  const fullName = `${arr[0].firstName ?? ''} ${arr[0].lastName ?? ''}`.trim();
  return {
    externalAccountId: String(arr[0].id),
    externalAccountLabel:
      arr[0].emailAddress ??
      (fullName.length > 0 ? fullName : String(arr[0].id)),
  };
};

// ─── Marketo ───────────────────────────────────────────────────────────
// Marketo's REST API is instance-scoped (subdomain like 123-ABC-456.mktorest.com).
// The `instanceUrl` from the token response is the disambiguator here. We
// derive identity from instanceUrl alone since there is no whoami endpoint.
const fetchMarketoIdentity: IdentityFetcher = async (_accessToken, extras) => {
  if (!extras?.instanceUrl) return null;
  // Strip protocol + path to get the munchkin host (e.g. '123-ABC-456.mktorest.com').
  const host = extras.instanceUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!host) return null;
  return { externalAccountId: host, externalAccountLabel: host };
};

// ─── Clay ──────────────────────────────────────────────────────────────
// Clay.com is MCP-first (api.clay.com/v3/mcp). Its AS metadata exposes no userinfo_endpoint,
// so this whoami attempt typically returns null and the FE falls back to the connector type —
// tenants get single-instance behavior until Clay publishes a whoami endpoint.
const fetchClayIdentity: IdentityFetcher = async (accessToken) => {
  const data = await fetchJson('https://api.clay.com/oauth/userinfo', accessToken);
  if (!data) return null;
  const id = (data.sub as string | undefined) ?? (data.email as string | undefined);
  const label = (data.email as string | undefined) ?? (data.name as string | undefined) ?? id;
  if (!id || !label) return null;
  return { externalAccountId: id, externalAccountLabel: label };
};

// Mesh (formerly Clay.earth) is MCP-first (mcp.clay.earth) — try OIDC userinfo at the MCP host;
// otherwise return null and let the FE fallback render the connector type.
const fetchMeshIdentity: IdentityFetcher = async (accessToken) => {
  const data = await fetchJson('https://mcp.clay.earth/userinfo', accessToken);
  if (!data) return null;
  const id = (data.sub as string | undefined) ?? (data.email as string | undefined);
  const label = (data.email as string | undefined) ?? (data.name as string | undefined) ?? id;
  if (!id || !label) return null;
  return { externalAccountId: id, externalAccountLabel: label };
};

// ─── Granola ───────────────────────────────────────────────────────────
// Granola's OIDC server lives at mcp-auth.granola.ai (separate host from
// mcp.granola.ai). Confirmed via the discovery doc at
// https://mcp.granola.ai/.well-known/oauth-authorization-server.
const fetchGranolaIdentity: IdentityFetcher = async (accessToken) => {
  const data = await fetchJson(
    'https://mcp-auth.granola.ai/oauth2/userinfo',
    accessToken,
  );
  if (!data) return null;
  const id = (data.sub as string | undefined) ?? (data.email as string | undefined);
  const label = (data.email as string | undefined) ?? (data.name as string | undefined) ?? id;
  if (!id || !label) return null;
  return { externalAccountId: id, externalAccountLabel: label };
};

// ─── Gusto ─────────────────────────────────────────────────────────────
// Native-HRIS OAuth (only reached when gusto is flipped native). GET /v1/companies
// returns the companies the token can act on; the connected company uuid is both the
// multi-instance dedup key AND what the gusto client reads as credential.instanceUrl
// (the OAuth callback copies externalAccountId → instanceUrl for gusto). Host is
// env-scoped (prod vs demo), mirroring the gusto client's GUSTO_SANDBOX base.
const fetchGustoIdentity: IdentityFetcher = async (accessToken) => {
  const host =
    process.env.GUSTO_SANDBOX === 'true' ? 'https://api.gusto-demo.com' : 'https://api.gusto.com';
  const raw = (await fetchJson(`${host}/v1/companies`, accessToken)) as unknown;
  const companies = Array.isArray(raw)
    ? (raw as Array<{ uuid?: string; name?: string }>)
    : ((raw as { companies?: Array<{ uuid?: string; name?: string }> } | null)?.companies ?? []);
  const first = companies[0];
  if (!first?.uuid) return null;
  return { externalAccountId: first.uuid, externalAccountLabel: first.name ?? first.uuid };
};

// ─── Rippling ──────────────────────────────────────────────────────────
// Native-HRIS OAuth (only reached when rippling is flipped native). Rippling's token
// is scoped to a single company tenant; GET /companies on the current REST API
// (rest.ripplingapis.com) returns that company — use its id for multi-instance dedup.
const fetchRipplingIdentity: IdentityFetcher = async (accessToken) => {
  const raw = (await fetchJson('https://rest.ripplingapis.com/companies', accessToken)) as unknown;
  const list = Array.isArray(raw)
    ? (raw as Array<{ id?: string; name?: string; legalName?: string }>)
    : ((raw as { results?: Array<{ id?: string; name?: string; legalName?: string }> } | null)?.results ?? []);
  const first = list[0] ?? (raw as { id?: string; name?: string; legalName?: string } | null);
  const id = first?.id;
  if (!id) return null;
  return { externalAccountId: id, externalAccountLabel: first?.name ?? first?.legalName ?? id };
};

// ─── Square ────────────────────────────────────────────────────────────
const fetchSquareIdentity: IdentityFetcher = async (accessToken) => {
  const data = await fetchJson(
    'https://connect.squareup.com/v2/merchants/me',
    accessToken,
  );
  if (!data?.merchant) return null;
  const m = data.merchant as { id?: string; business_name?: string; main_location_id?: string };
  if (!m.id) return null;
  return {
    externalAccountId: m.id,
    externalAccountLabel: m.business_name ?? m.id,
  };
};

// ─── PayPal ────────────────────────────────────────────────────────────
const fetchPaypalIdentity: IdentityFetcher = async (accessToken) => {
  // OIDC userinfo endpoint (live + sandbox have the same path).
  const data = await fetchJson(
    'https://api-m.paypal.com/v1/identity/oauth2/userinfo?schema=paypalv1.1',
    accessToken,
  );
  if (!data) return null;
  const id =
    (data.user_id as string | undefined) ??
    (data.payer_id as string | undefined) ??
    (data.email as string | undefined);
  const label =
    (data.email as string | undefined) ??
    (data.name as string | undefined) ??
    id;
  if (!id || !label) return null;
  return { externalAccountId: id, externalAccountLabel: label };
};

const fetchersByProvider: Partial<Record<OAuthProvider, IdentityFetcher>> = {
  google: fetchGoogleIdentity,
  slack: fetchSlackIdentity,
  github: fetchGithubIdentity,
  gitlab: fetchGitlabIdentity,
  microsoft: fetchMicrosoftIdentity,
  notion: fetchNotionIdentity,
  atlassian: fetchAtlassianIdentity,
  zoom: fetchZoomIdentity,
  hubspot: fetchHubspotIdentity,
  salesforce: fetchSalesforceIdentity,
  dropbox: fetchDropboxIdentity,
  box: fetchBoxIdentity,
  asana: fetchAsanaIdentity,
  linear: fetchLinearIdentity,
  calendly: fetchCalendlyIdentity,
  docusign: fetchDocusignIdentity,
  stripe: fetchStripeIdentity,
  zendesk: fetchZendeskIdentity,
  intuit: fetchIntuitIdentity,
  xero: fetchXeroIdentity,
  meta: fetchMetaIdentity,
  // Previously single-instance; identity now available:
  attio: fetchAttioIdentity,
  outreach: fetchOutreachIdentity,
  // salesloft: none. Its DCR token is MCP-audience and cannot call
  // api.salesloft.com/v2/me.json; the connector is single-instance until an
  // MCP-based identity fetch exists (the stripe pattern).
  gong: fetchGongIdentity,
  marketo: fetchMarketoIdentity,
  clay: fetchClayIdentity,
  mesh: fetchMeshIdentity,
  granola: fetchGranolaIdentity,
  square: fetchSquareIdentity,
  paypal: fetchPaypalIdentity,
  // Native HRIS (only invoked when flipped native → static_oauth). See getOAuthProvider.
  gusto: fetchGustoIdentity,
  rippling: fetchRipplingIdentity,
};

/**
 * Fetch an external identity for the connected account.
 *
 * Returns null when:
 *  - No fetcher is registered for this provider
 *  - The whoami call fails (non-2xx, network error, parse error)
 *  - The provider's response doesn't carry a stable id
 *
 * Callers (the OAuth callback) handle null by falling back to legacy
 * (tenant, type) lookup — accepting single-instance behavior for that
 * provider until a fetcher is added here.
 */
export async function fetchExternalIdentity(
  provider: OAuthProvider,
  accessToken: string,
  extras: { instanceUrl?: string; subdomain?: string; connectorType?: string } = {},
): Promise<ExternalIdentity | null> {
  const fetcher = fetchersByProvider[provider];
  if (!fetcher) {
    logger.info({ provider }, 'identity-fetch: no fetcher registered (single-instance)');
    return null;
  }
  try {
    return await fetcher(accessToken, extras);
  } catch (err) {
    logger.warn(
      { provider, error: (err as Error).message },
      'identity-fetch: fetcher threw',
    );
    return null;
  }
}

/**
 * Returns true if this provider has an identity fetcher registered (i.e.,
 * supports multi-instance). Useful for callers that want to gate behavior.
 */
export function providerSupportsMultiInstance(provider: OAuthProvider): boolean {
  return provider in fetchersByProvider;
}

/**
 * Pull externalAccountId + externalAccountLabel from a Composio connected
 * account response.
 *
 * Composio response shape (per @composio/core@0.10.x ConnectionDataSchema):
 *   {
 *     id: 'ca_xxx',                  // Composio's per-link id (changes each link)
 *     params?: { account_email, ... } // legacy deprecated flat map
 *     state?: { authScheme, val: {   // canonical structure — auth-scheme-specific
 *       access_token, refresh_token,
 *       account_id, account_email,   // ← toolkit-specific vendor fields live here
 *       workspace_name, login, ...
 *     } }
 *   }
 *
 * Important: `connectedAccount.id` is unique PER LINK CALL, not per (toolkit,
 * end-user). With `allowMultiple: true`, every reconnect creates a NEW id
 * even for the same underlying workspace. If we key Liftoff's find-or-create
 * on `connectedAccount.id`, every reconnect creates a new connector row.
 *
 * To keep one row per workspace, we prefer a STABLE vendor identifier from
 * the response: account_id / workspace_id / team_id / etc. live inside
 * `state.val`. Fall back to `connectedAccount.id` ONLY when no vendor id is
 * exposed — then reconnects do create duplicates, but the migration-marker
 * UPDATE-in-place in /callback handles the legacy → Composio transition
 * cleanly.
 */
const STABLE_ID_FIELDS = [
  'account_id',
  'workspace_id',
  'team_id',
  'organization_id',
  'org_id',
  'user_id',
  'tenant_id', // some vendors call their workspace id "tenant_id"
  'subdomain', // zendesk-style
];
const LABEL_FIELDS = [
  'account_email',
  'email',
  'workspace_name',
  'account_name',
  'login',
  'username',
  'name',
  'subdomain',
];

function firstStringValue(map: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = map[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

// ── id_token JWT decode (OIDC providers) ────────────────────────────────
//
// For OIDC providers (Google, Microsoft, Apple, anything that signs in
// via OpenID Connect), Composio's `state.val` carries an `id_token` JWT
// alongside the access_token. The JWT's payload contains `sub`, `email`,
// `name`, `preferred_username` — the canonical identity we want for the
// connected-card subtitle. The flat-field heuristic above misses these
// because the identity is INSIDE a signed token, not exposed as a
// top-level field.
//
// We decode the payload only (no signature verification). The token
// comes from Composio's stored credential blob, which Liftoff trusts
// transitively — Composio has already validated it with the IdP. We
// never ship this code outside the OAuth callback path, so an attacker
// would need to compromise Composio to inject a forged token.

const ID_TOKEN_FIELDS = ['id_token', 'idToken', 'id_token_jwt'] as const;

function decodeJwtPayloadUnsafe(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4;
    const padded = pad === 0 ? b64 : b64 + '='.repeat(4 - pad);
    const payload = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function tryExtractFromIdToken(state: Record<string, unknown>): {
  stableId?: string;
  label?: string;
} {
  for (const field of ID_TOKEN_FIELDS) {
    const v = state[field];
    if (typeof v !== 'string' || v.length === 0) continue;
    const claims = decodeJwtPayloadUnsafe(v);
    if (!claims) continue;
    const sub = typeof claims.sub === 'string' ? claims.sub : undefined;
    const email = typeof claims.email === 'string' ? claims.email : undefined;
    const name = typeof claims.name === 'string' ? claims.name : undefined;
    const preferred = typeof claims.preferred_username === 'string'
      ? claims.preferred_username
      : undefined;
    const label = email ?? preferred ?? name;
    if (sub || label) return { stableId: sub, label };
  }
  return {};
}

// ── Per-toolkit Composio whoami (async fallback for non-OIDC vendors) ──
//
// When neither the flat-field heuristic NOR the id_token decode resolves a
// label, fall back to calling the toolkit's own whoami tool via
// composio.tools.execute(). Every vendor we depend on has a profile/
// identity tool; we just have to name it and map its response shape.
//
// This is best-effort: failures (rate limit, network, missing scope) log
// and fall through to the account.id final-fallback. Adding a new toolkit
// is a one-line entry; the cost of being wrong is degrading to ca_XXX,
// which is what we have today before this map exists.

interface ComposioWhoamiSpec {
  vendorTool: string;
  arguments?: Record<string, unknown>;
  /** Extract a human-readable label (email/name) from the response data. */
  labelFromResponse: (data: unknown) => string | undefined;
  /** Extract a stable identifier from the response data. Optional. */
  stableIdFromResponse?: (data: unknown) => string | undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function dig(obj: unknown, ...path: Array<string | number>): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (cur == null) return undefined;
    if (typeof p === 'number') {
      if (Array.isArray(cur) && p < cur.length) cur = cur[p];
      else return undefined;
    } else if (typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

const COMPOSIO_WHOAMI_TOOLS: Record<string, ComposioWhoamiSpec> = {
  // Google products all share the same Google account; GMAIL_GET_PROFILE
  // returns { emailAddress, messagesTotal, ... } and only requires basic
  // Gmail scope which every Google toolkit also requests.
  google_mail: {
    vendorTool: 'GMAIL_GET_PROFILE',
    labelFromResponse: (data) => asString(dig(data, 'emailAddress')) ?? asString(dig(data, 'response_data', 'emailAddress')),
    stableIdFromResponse: (data) => asString(dig(data, 'emailAddress')) ?? asString(dig(data, 'response_data', 'emailAddress')),
  },
  // All Google sub-toolkits (calendar/docs/sheets/slides/drive) share the
  // same Google account; GOOGLEDRIVE_GET_ABOUT works under every Google
  // OAuth scope set (Composio's static auth configs all include drive
  // read access). Routing them all here avoids per-scope mismatches that
  // a toolkit-specific whoami (GMAIL_GET_PROFILE, GOOGLECALENDAR_LIST_*,
  // …) would hit when the user's scope set excludes that surface.
  // google_calendar's Composio OAuth scope set excludes drive + openid,
  // so neither GOOGLEDRIVE_GET_ABOUT nor id_token decode helps.
  // GOOGLECALENDAR_GET_CALENDAR with calendarId='primary' returns the
  // primary calendar, whose `id` IS the user's email by the Calendar
  // API's contract. Composio wraps the vendor payload under
  // `data.calendar_data` (confirmed via a whoami probe), not the more common
  // `data.response_data` envelope — so the dig path is toolkit-specific.
  google_calendar: {
    vendorTool: 'GOOGLECALENDAR_GET_CALENDAR',
    arguments: { calendarId: 'primary' },
    labelFromResponse: (data) =>
      asString(dig(data, 'calendar_data', 'id')) ??
      asString(dig(data, 'response_data', 'calendar_data', 'id')) ??
      asString(dig(data, 'id')),
    stableIdFromResponse: (data) =>
      asString(dig(data, 'calendar_data', 'id')) ??
      asString(dig(data, 'response_data', 'calendar_data', 'id')) ??
      asString(dig(data, 'id')),
  },
  google_drive: {
    vendorTool: 'GOOGLEDRIVE_GET_ABOUT',
    labelFromResponse: (data) => asString(dig(data, 'user', 'emailAddress')) ?? asString(dig(data, 'response_data', 'user', 'emailAddress')),
    stableIdFromResponse: (data) => asString(dig(data, 'user', 'permissionId')) ?? asString(dig(data, 'response_data', 'user', 'permissionId')),
  },
  google_docs: {
    vendorTool: 'GOOGLEDRIVE_GET_ABOUT',
    labelFromResponse: (data) => asString(dig(data, 'user', 'emailAddress')) ?? asString(dig(data, 'response_data', 'user', 'emailAddress')),
    stableIdFromResponse: (data) => asString(dig(data, 'user', 'permissionId')) ?? asString(dig(data, 'response_data', 'user', 'permissionId')),
  },
  google_sheets: {
    vendorTool: 'GOOGLEDRIVE_GET_ABOUT',
    labelFromResponse: (data) => asString(dig(data, 'user', 'emailAddress')) ?? asString(dig(data, 'response_data', 'user', 'emailAddress')),
    stableIdFromResponse: (data) => asString(dig(data, 'user', 'permissionId')) ?? asString(dig(data, 'response_data', 'user', 'permissionId')),
  },
  google_slides: {
    vendorTool: 'GOOGLEDRIVE_GET_ABOUT',
    labelFromResponse: (data) => asString(dig(data, 'user', 'emailAddress')) ?? asString(dig(data, 'response_data', 'user', 'emailAddress')),
    stableIdFromResponse: (data) => asString(dig(data, 'user', 'permissionId')) ?? asString(dig(data, 'response_data', 'user', 'permissionId')),
  },
  // Slack
  slack: {
    vendorTool: 'SLACK_AUTH_TEST',
    labelFromResponse: (data) =>
      asString(dig(data, 'team')) ?? asString(dig(data, 'response_data', 'team')) ?? asString(dig(data, 'user')) ?? asString(dig(data, 'response_data', 'user')),
    stableIdFromResponse: (data) =>
      asString(dig(data, 'team_id')) ?? asString(dig(data, 'response_data', 'team_id')),
  },
  // Microsoft Outlook / Office 365 — id_token usually covers this, but
  // wire a tools.execute fallback in case the OAuth flow drops the
  // id_token scope.
  outlook: {
    vendorTool: 'OUTLOOK_OUTLOOK_GET_PROFILE',
    labelFromResponse: (data) =>
      asString(dig(data, 'mail')) ?? asString(dig(data, 'response_data', 'mail')) ?? asString(dig(data, 'userPrincipalName')) ?? asString(dig(data, 'response_data', 'userPrincipalName')),
    stableIdFromResponse: (data) =>
      asString(dig(data, 'id')) ?? asString(dig(data, 'response_data', 'id')),
  },
  // Dropbox
  dropbox: {
    vendorTool: 'DROPBOX_GET_CURRENT_ACCOUNT',
    labelFromResponse: (data) =>
      asString(dig(data, 'email')) ?? asString(dig(data, 'response_data', 'email')),
    stableIdFromResponse: (data) =>
      asString(dig(data, 'account_id')) ?? asString(dig(data, 'response_data', 'account_id')),
  },
  // Atlassian (jira/confluence) — accessible-resources endpoint returns
  // the cloud id + URL.
  jira: {
    vendorTool: 'JIRA_GET_USER_ACCESSIBLE_RESOURCES',
    labelFromResponse: (data) => {
      const arr = (dig(data, 'response_data') ?? data) as unknown[] | unknown;
      const first = Array.isArray(arr) ? arr[0] : undefined;
      return first && typeof first === 'object'
        ? asString((first as { name?: unknown }).name) ?? asString((first as { url?: unknown }).url)
        : undefined;
    },
    stableIdFromResponse: (data) => {
      const arr = (dig(data, 'response_data') ?? data) as unknown[] | unknown;
      const first = Array.isArray(arr) ? arr[0] : undefined;
      return first && typeof first === 'object' ? asString((first as { id?: unknown }).id) : undefined;
    },
  },
  confluence: {
    vendorTool: 'CONFLUENCE_GET_USER_ACCESSIBLE_RESOURCES',
    labelFromResponse: (data) => {
      const arr = (dig(data, 'response_data') ?? data) as unknown[] | unknown;
      const first = Array.isArray(arr) ? arr[0] : undefined;
      return first && typeof first === 'object'
        ? asString((first as { name?: unknown }).name) ?? asString((first as { url?: unknown }).url)
        : undefined;
    },
    stableIdFromResponse: (data) => {
      const arr = (dig(data, 'response_data') ?? data) as unknown[] | unknown;
      const first = Array.isArray(arr) ? arr[0] : undefined;
      return first && typeof first === 'object' ? asString((first as { id?: unknown }).id) : undefined;
    },
  },
  youtube: {
    vendorTool: 'YOUTUBE_LIST_USER_SUBSCRIBED_CHANNELS',
    labelFromResponse: (data) => {
      const items = (dig(data, 'items') ?? dig(data, 'response_data', 'items')) as unknown[] | undefined;
      if (!Array.isArray(items) || items.length === 0) return undefined;
      return asString(dig(items[0], 'snippet', 'title')) ?? asString(dig(items[0], 'id'));
    },
  },
  calendly: {
    vendorTool: 'CALENDLY_GET_USER',
    labelFromResponse: (data) =>
      asString(dig(data, 'resource', 'email')) ?? asString(dig(data, 'response_data', 'resource', 'email')),
    stableIdFromResponse: (data) =>
      asString(dig(data, 'resource', 'uri')) ?? asString(dig(data, 'response_data', 'resource', 'uri')),
  },
  paypal: {
    vendorTool: 'PAYPAL_GET_USER_INFO',
    labelFromResponse: (data) =>
      asString(dig(data, 'emails', 0, 'value')) ?? asString(dig(data, 'response_data', 'emails', 0, 'value')) ?? asString(dig(data, 'name')) ?? asString(dig(data, 'response_data', 'name')),
    stableIdFromResponse: (data) =>
      asString(dig(data, 'user_id')) ?? asString(dig(data, 'response_data', 'user_id')),
  },
};

/**
 * Minimal SDK shape we depend on (so this module can be tested without
 * importing the full @composio/core type surface).
 */
interface ComposioToolsExecutor {
  tools: {
    execute: (
      slug: string,
      body: {
        userId: string;
        connectedAccountId: string;
        arguments: Record<string, unknown>;
        // SDK requires a concrete toolkit version OR an explicit skip.
        // Identity whoami calls run outside an agent invocation, so we have
        // no resolved version to forward; passing dangerouslySkipVersionCheck
        // is the right escape hatch (read-only `*_GET_PROFILE` / auth-test
        // tools — no migration risk).
        dangerouslySkipVersionCheck?: boolean;
      },
    ) => Promise<{ data?: unknown; error?: unknown; successful?: boolean }>;
  };
}

async function tryWhoamiViaComposio(
  connectorType: string,
  accountId: string,
  composio: ComposioToolsExecutor,
  tenantId: string,
): Promise<{ stableId?: string; label?: string }> {
  const spec = COMPOSIO_WHOAMI_TOOLS[connectorType];
  if (!spec) return {};
  try {
    const resp = await composio.tools.execute(spec.vendorTool, {
      userId: tenantId,
      connectedAccountId: accountId,
      arguments: spec.arguments ?? {},
      dangerouslySkipVersionCheck: true,
    });
    if (resp.successful === false) return {};
    const data = resp.data;
    const label = spec.labelFromResponse(data);
    const stableId = spec.stableIdFromResponse?.(data);
    return { stableId, label };
  } catch (err) {
    logger.warn(
      {
        connectorType,
        connectedAccountId: accountId,
        vendorTool: spec.vendorTool,
        error: (err as Error).message,
      },
      'composio_whoami_fallback_failed',
    );
    return {};
  }
}

/**
 * Resolve identity for a Composio-managed connector. Three layers, each a
 * superset of the prior:
 *   1. Flat-field heuristic (STABLE_ID_FIELDS / LABEL_FIELDS on state.val).
 *   2. id_token JWT decode (covers all OIDC providers: Google, Microsoft, …).
 *   3. Per-toolkit whoami via composio.tools.execute (covers vendors whose
 *      identity isn't exposed by 1 or 2 — Slack, Dropbox, Atlassian, …).
 *
 * The composio client + tenantId are optional. When absent, layer 3 is
 * skipped — callers that don't have a composio client handy (tests,
 * synchronous code paths) still benefit from layers 1 + 2.
 *
 * Returns the BEST identifier the chain could resolve; falls back to
 * `account.id` (the opaque `ca_XXX` Composio id) only when nothing
 * resolved at all.
 */
export async function extractComposioIdentity(
  connectorType: string,
  account: {
    id: string;
    params?: Record<string, unknown>;
    state?: Record<string, unknown>;
  },
  composio?: ComposioToolsExecutor,
  tenantId?: string,
): Promise<ExternalIdentity> {
  const stateVal =
    account.state && typeof account.state === 'object' && account.state !== null
      ? ((account.state as { val?: Record<string, unknown> }).val ?? {})
      : {};
  const merged: Record<string, unknown> = {
    ...(account.params ?? {}),
    ...stateVal,
  };

  // Layer 1: flat-field heuristic.
  let stableId: string | null | undefined = firstStringValue(merged, STABLE_ID_FIELDS);
  let label: string | null | undefined = firstStringValue(merged, LABEL_FIELDS);

  // Layer 2: id_token JWT decode (OIDC providers).
  if (!stableId || !label) {
    const jwtId = tryExtractFromIdToken(stateVal);
    stableId = stableId ?? jwtId.stableId;
    label = label ?? jwtId.label;
  }

  // Layer 3: per-toolkit whoami via composio.tools.execute.
  if ((!stableId || !label) && composio && tenantId) {
    const whoami = await tryWhoamiViaComposio(connectorType, account.id, composio, tenantId);
    stableId = stableId ?? whoami.stableId;
    label = label ?? whoami.label;
  }

  const externalAccountId = stableId ?? account.id;
  return {
    externalAccountId,
    externalAccountLabel: label ?? externalAccountId,
  };
}
