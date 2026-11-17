// Identity-derived connector.config builder.
//
// Every identity-bearing OAuth callback records { externalAccountId,
// externalAccountLabel } into connectors.config. For github we ALSO record
// `bot_login`: the login of the account whose token the team acts through.
// Events the team itself authors carry `sender.login = <that login>`, so
// platform-backend's team-provisioning writes a `sender.login != bot_login`
// self-event exclusion off `config.bot_login` — and FAILS CLOSED (422) if it
// is absent, rather than let a reactive team react to its own PRs. Recording
// it here at connection time is the "same config blob as webhook_secret_path"
// bind-flow addition. github's identity label IS its login (see
// fetchGithubIdentity), so no extra API call is needed.

import type { ExternalIdentity } from './identity-fetchers.js';

/** Build the identity portion of connectors.config for a freshly authorized
 *  connection. github additionally gets `bot_login` (for the self-event
 *  exclusion) and `scopes` (team-provisioning validates a role's required
 *  github scopes against `config.scopes`; both are "recorded at connection
 *  time" per the bind-flow contract). */
export function buildIdentityConfig(
  provider: string,
  identity: ExternalIdentity,
  opts: { scopes?: string[] | null } = {},
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    externalAccountId: identity.externalAccountId,
    externalAccountLabel: identity.externalAccountLabel,
  };
  // github + gitlab are version-control connectors a reactive SWE team binds to: record
  // `bot_login` (the connection's login) for the self-event exclusion — a role must not react to
  // MRs/PRs it authored — and `scopes` (team-provisioning validates a role's required version-control
  // scopes against `config.scopes`). github's label is its login; gitlab's is its username.
  if (provider === 'github' || provider === 'gitlab') {
    if (identity.externalAccountLabel) config.bot_login = identity.externalAccountLabel;
    if (opts.scopes && opts.scopes.length > 0) config.scopes = opts.scopes;
  }
  return config;
}
