// Completing a GitHub App install: the single place an installation becomes a
// Liftoff connector row.
//
// TWO CALLERS, ONE FUNCTION — for the same reason composio-bind.ts exists, and
// with a sharper edge. There the browser redirect merely FAILED sometimes; here
// there is a case where it cannot happen at all.
//
//   - GET /callback   — the owner installed it themselves and came straight back
//   - the webhook     — `installation.created`
//
// When the person connecting is NOT an org owner, GitHub records a request and
// returns `setup_action=request` with no installation id. An owner approves it
// later, possibly weeks later, in a different browser, on a different account.
// The ONLY signal that the install happened is the webhook. So the webhook is
// not a safety net for this connector, it is a primary path, and a completion
// re-implemented there would drift from the callback exactly as the header of
// composio-bind.ts warns.
//
// THE ATTRIBUTION PROBLEM, AND WHY THIS FAILS CLOSED. GitHub does not propagate
// the `state` we sent through to the installation webhook. GitHub support has
// confirmed there is no way to identify the user who made the original request.
// So on the webhook path the tenant is resolved by matching the account login
// against a row that is waiting for exactly that org. When zero or more than one
// row matches, this records nothing and leaves the request pending — binding an
// installation to the wrong tenant would hand one workspace write access to
// another's repositories, which is far worse than a card that stays pending.

import { logger } from '../infra/logging.js';
import {
  findUsableConnectorByTenantAndType,
  findConnectorByTenantTypeAndExternalAccountId,
  createConnectorReusingOnAccountConflict,
  getConnectorById,
  mergeConnectorConfig,
  updateConnectorStatus,
  createConnector,
} from './connector-ops.js';
import { getInstallation, listInstallationRepositories } from './github-app.js';
import { findTenantsAwaitingInstall, findTenantsHoldingInstallation } from './github-app-pending.js';
import { CONNECTOR_DISPLAY_NAMES } from '../types.js';

export type GithubCompletionSource = 'callback' | 'webhook';

export interface GithubInstallCompletion {
  connectorId: string;
  accountLogin: string;
  repositorySelection: 'all' | 'selected';
}

/**
 * Turn a GitHub App installation into an active connector row.
 *
 * `tenantId` is known on the callback path and absent on the webhook path,
 * where it is resolved by matching the installed account against a pending row.
 * Returns null when nothing could be safely bound — never a guess.
 */
export async function completeGithubAppInstallation(input: {
  installationId: number;
  tenantId?: string;
  source: GithubCompletionSource;
}): Promise<GithubInstallCompletion | null> {
  const installation = await getInstallation(input.installationId);
  if (!installation) {
    // Either the App is unconfigured or GitHub does not know this installation.
    // Both mean there is nothing to record.
    logger.warn(
      { installation_id: input.installationId, source: input.source },
      'github_app_install_not_resolvable',
    );
    return null;
  }

  // On the webhook path, an installation already bound to a row was attributed
  // by the callback moments earlier — so "no pending row" is routine, not a
  // failure. Ask before deciding how loudly to say nothing was found.
  const alreadyBound =
    input.tenantId === undefined
      ? (await findTenantsHoldingInstallation(input.installationId)).length > 0
      : false;
  const tenantId =
    input.tenantId ?? (await resolveTenantFromPending(installation.accountLogin, alreadyBound));
  if (!tenantId) return null;

  // The repository list is only meaningful under `selected`. Under `all` it is
  // every repository the account has today AND every one it gains tomorrow, so
  // storing a snapshot would be recording a number that starts going stale the
  // moment it is written.
  const repositories =
    installation.repositorySelection === 'selected'
      ? await listInstallationRepositories(input.installationId).catch((err) => {
          logger.warn(
            { err: (err as Error).message, installation_id: input.installationId },
            'github_app_repo_list_failed',
          );
          return null;
        })
      : null;

  const config = {
    installationId: input.installationId,
    // Read off the INSTALLATION, never off what our picker suggested:
    // `suggested_target_id` is only a suggestion and the user can switch
    // accounts on GitHub's own screen.
    externalAccountLabel: installation.accountLogin,
    // The per-account key. A UNIQUE index on (tenant_id, type, externalAccountId)
    // already exists for exactly this, and writing it is what makes the SECOND
    // organization resolve to its own row rather than overwriting the first.
    externalAccountId: String(installation.accountId),
    githubAccountId: installation.accountId,
    githubAccountType: installation.accountType,
    repositorySelection: installation.repositorySelection,
    ...(repositories
      ? { repositoryNames: repositories.names, repositoryCount: repositories.total }
      : {}),
    // Clear the pending marker, whichever path got here.
    installState: 'installed',
    awaitingOrgLogin: null,
  };

  const existing = await resolveRowForInstallation({
    tenantId,
    accountId: String(installation.accountId),
    accountLogin: installation.accountLogin,
  });
  let connectorId: string;

  if (existing) {
    // UPGRADE IN PLACE. The row may already hold a working OAuth user token —
    // that credential is left exactly as it is. Dispatch prefers the
    // installation token when `installationId` is present and falls back to the
    // user token when it is not, so an agent bound to this connector keeps
    // working across the transition and simply changes identity.
    //
    // Reusing the row id also preserves the agent tool aliases derived from it
    // (`<type>-<id-prefix>__<fn>`), which a fresh row would silently invalidate.
    connectorId = existing.id;
    await mergeConnectorConfig(tenantId, connectorId, config);
    await updateConnectorStatus(tenantId, connectorId, 'active');
  } else {
    // A SECOND account gets a SECOND row. One row per tenant would mean
    // installing to an organization silently overwrote the personal account's
    // installation id, leaving the first account quietly back on the user token
    // with nothing reporting it.
    //
    // The name carries the account login so an operator reading the rows can
    // tell the installations apart; the UI disambiguates by the subtitle.
    const created = await createConnectorReusingOnAccountConflict(
      {
        tenantId,
        type: 'github',
        name: `${CONNECTOR_DISPLAY_NAMES.github ?? 'GitHub'} (${installation.accountLogin})`,
        config,
      },
      String(installation.accountId),
    );
    connectorId = created.id;
    // createConnector always inserts 'pending'; the install is complete, so the
    // row is only truthful once it says active.
    await updateConnectorStatus(tenantId, connectorId, 'active');
  }

  logger.info(
    {
      tenant_id: tenantId,
      connector_id: connectorId,
      installation_id: input.installationId,
      account: installation.accountLogin,
      repository_selection: installation.repositorySelection,
      source: input.source,
    },
    'github_app_install_completed',
  );

  return {
    connectorId,
    accountLogin: installation.accountLogin,
    repositorySelection: installation.repositorySelection,
  };
}

/**
 * Which existing row, if any, does this installation belong to?
 *
 * The order is the whole point, and each step exists because the one after it
 * would get a real case wrong.
 *
 *   1. The row already keyed to this GitHub account. A re-install, a repository
 *      change, or a second delivery of the same webhook must land on the row it
 *      landed on last time.
 *
 *   2. The row parked waiting for THIS organization's approval. It was created
 *      by recordPendingInstallRequest and has no account id yet, so step 1
 *      cannot see it — and without this step an approved request would create a
 *      second row and leave the pending card sitting there forever.
 *
 *   3. A pre-App row that has never held an installation: the first upgrade.
 *      Reusing it is what makes existing agent bindings survive the transition,
 *      and it must NOT match a row that already belongs to a different account —
 *      that is precisely the overwrite this function exists to prevent.
 *
 * No match means a genuinely new account, and the caller creates a row for it.
 */
async function resolveRowForInstallation(input: {
  tenantId: string;
  accountId: string;
  accountLogin: string;
}): Promise<{ id: string } | null> {
  const byAccount = await findConnectorByTenantTypeAndExternalAccountId(
    input.tenantId,
    'github',
    input.accountId,
  );
  if (byAccount) return byAccount;

  const pending = (await findTenantsAwaitingInstall(input.accountLogin)).find(
    (row) => row.tenantId === input.tenantId,
  );
  if (pending) return { id: pending.connectorId };

  const legacy = await findUsableConnectorByTenantAndType(input.tenantId, 'github');
  const legacyConfig = (legacy?.config ?? {}) as {
    installationId?: unknown;
    externalAccountId?: unknown;
  };
  if (legacy && !legacyConfig.installationId && !legacyConfig.externalAccountId) {
    return legacy;
  }

  return null;
}

/**
 * Which tenant was waiting for this org?
 *
 * Fails closed on both zero and many. A wrong answer here binds an
 * installation — and therefore write access to real repositories — to the wrong
 * workspace. Leaving the card pending is recoverable; that is not.
 */
async function resolveTenantFromPending(
  accountLogin: string,
  alreadyInstalled = false,
): Promise<string | null> {
  const waiting = await findTenantsAwaitingInstall(accountLogin);

  if (waiting.length === 1) return waiting[0].tenantId;

  // A DIRECT install has already been attributed by the callback, which runs
  // ~0.1s before the webhook arrives. Finding no pending row for it is the
  // expected outcome, not a failure — and logging it at the same line a
  // genuinely unattributable install uses would bury the case the diagnostic
  // exists for under routine noise.
  if (waiting.length === 0 && alreadyInstalled) {
    logger.info(
      { account: accountLogin },
      'github_app_install_webhook_already_attributed_by_callback',
    );
    return null;
  }

  logger.warn(
    { account: accountLogin, candidates: waiting.length },
    waiting.length === 0
      ? 'github_app_install_unattributable_no_pending_row'
      : 'github_app_install_ambiguous_left_pending',
  );
  return null;
}

/**
 * Record that a non-owner asked for the App and an owner has to approve.
 *
 * This is a real outcome, not a failure, and it has to be stored rather than
 * inferred: GitHub sends `setup_action=request` with NO organization name, so
 * the org here comes from OUR picker. It is the only reason the pending card can
 * name the org it is waiting on, and the only thing the later webhook can match
 * against.
 */
export async function recordPendingInstallRequest(input: {
  tenantId: string;
  orgLogin: string;
}): Promise<string> {
  const config = {
    installState: 'awaiting_org_approval',
    awaitingOrgLogin: input.orgLogin,
    externalAccountLabel: input.orgLogin,
  };

  const existing = await findUsableConnectorByTenantAndType(input.tenantId, 'github');
  if (existing) {
    await mergeConnectorConfig(input.tenantId, existing.id, config);
    // Deliberately NOT flipped to 'error'. The connections page renders `error`
    // as "Needs Reconnect", which would tell the user to redo something that is
    // working and merely waiting on somebody else.
    await updateConnectorStatus(input.tenantId, existing.id, 'pending');
    return existing.id;
  }

  // createConnector inserts 'pending', which is exactly the state a request
  // awaiting an owner should be in — no status update needed here.
  const created = await createConnector({
    tenantId: input.tenantId,
    type: 'github',
    name: CONNECTOR_DISPLAY_NAMES.github ?? 'GitHub',
    config,
  });
  return created.id;
}

/** Re-export so callers do not need two imports to read a row back. */
export { getConnectorById };
