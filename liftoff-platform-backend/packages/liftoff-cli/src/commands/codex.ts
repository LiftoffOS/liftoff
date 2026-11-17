// Codex commands:
//   codex setup      — connect Codex through Liftoff (profile + catalog + helper)
//   codex status     — connected | paused | revoked | misconfigured | unavailable
//   codex pause      — SERVER-SIDE credential suspension (never a silent bypass)
//   codex resume     — reactivate the credential
//   codex disconnect — revoke + remove ONLY Liftoff-managed material

import chalk from 'chalk';
import { browserAuth } from '../auth.js';
import { exchangeSetupToken } from '../api-client.js';
import {
  loadCliState,
  saveClientState,
  deleteClientState,
  type ClientState,
} from '../state.js';
import { storeCredential, readCredential, deleteCredential } from '../keychain.js';
import { installStableHelper } from '../credential-helper.js';
import {
  detectCodexVersion,
  writeModelCatalog,
  validateCatalog,
  writeLiftoffProfile,
  removeLiftoffProfile,
  catalogPath,
  liftoffProfilePath,
} from '../codex-config.js';

// The model a freshly written Codex profile prefers, when the approved catalog
// carries it. Tracks the platform's OpenAI LARGE tier — which moved to the GPT-6
// line, where the large tier is `gpt-6-astra` and `gpt-6-sol` is the medium tier.
// Left on the old id this would pin every new Codex profile to the previous
// generation for as long as that row stays approved, which is indefinitely.
const DEFAULT_MODEL = 'gpt-6-astra';

function environmentFromBaseUrl(baseUrl: string): 'dev' | 'prod' | string {
  if (baseUrl.startsWith('https://api.example.com')) return 'prod';
  const match = baseUrl.match(/^https:\/\/api-([a-z0-9-]+)\.liftoffos\.com/);
  return match ? match[1] : 'unknown';
}

interface ApprovedModel {
  id: string;
  metadata: Record<string, unknown>;
}

async function fetchApprovedModels(baseUrl: string, proxyKey: string): Promise<ApprovedModel[]> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/codex/v1/models`, {
    headers: { Authorization: `Bearer ${proxyKey}` },
  });
  if (!res.ok) throw new Error(`Model catalog fetch failed: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<Record<string, unknown> & { id: string }> };
  return (body.data ?? []).map((m) => {
    // Everything except the envelope fields is reviewed catalog metadata.
    const metadata: Record<string, unknown> = { ...m };
    delete metadata.id;
    delete metadata.object;
    delete metadata.owned_by;
    return { id: m.id, metadata };
  });
}

async function credentialTransition(
  state: ClientState,
  action: 'pause' | 'resume',
): Promise<void> {
  const key = readCredential('codex');
  if (!key) throw new Error('No stored Codex credential. Run "npx @liftoffos/cli codex setup".');
  const res = await fetch(`${state.baseUrl.replace(/\/$/, '')}/v1/credential/${action}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `${action} failed: HTTP ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// codex setup
// ---------------------------------------------------------------------------

export async function codexSetup(): Promise<void> {
  const existing = loadCliState().clients.codex;
  if (existing && readCredential('codex')) {
    console.log('Codex is already connected to Liftoff. Re-running setup refreshes the profile.');
  }

  console.log('Authenticating with Liftoff...\n');
  const { firebaseToken, tenantId, setupToken, codeVerifier } = await browserAuth({ client: 'codex' });
  if (!setupToken) {
    console.error('No setup token received. Create an OpenAI Codex connection on the Liftoff dashboard first.');
    process.exit(1);
  }

  // Exchange the one-time setup token for the proxy key + the
  // ENVIRONMENT-SPECIFIC proxy base URL.
  const result = await exchangeSetupToken(firebaseToken, setupToken, codeVerifier);
  const baseUrl = result.baseUrl.replace(/\/$/, '');
  const environment = environmentFromBaseUrl(baseUrl);

  // Store the credential in the OS keychain (0600 file only as fallback).
  const backend = storeCredential('codex', result.proxyKey);

  // Install the versioned, stable helper under ~/.liftoff/bin — Codex's
  // runtime auth command must not depend on npx or the network.
  const helper = installStableHelper();

  // Generate the local, version-compatible model catalog, filtered
  // by the proxy to Liftoff-approved and priced models.
  const codexVersion = detectCodexVersion();
  const models = await fetchApprovedModels(baseUrl, result.proxyKey);
  if (models.length === 0) {
    throw new Error('No approved Codex models are currently available for this workspace.');
  }
  const catalogFile = writeModelCatalog(
    models.map((m) => ({ id: m.id, metadata: m.metadata })),
    codexVersion,
  );
  validateCatalog(catalogFile);

  // Write the dedicated profile (never the default Codex config), validated
  // before success is reported, with dev-to-prod mismatch rejection.
  const modelIds = models.map((m) => m.id);
  const profile = writeLiftoffProfile({
    input: {
      proxyBaseUrl: baseUrl,
      defaultModel: modelIds.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : modelIds[0],
      catalogFile,
      helperPath: helper.path,
    },
    environment,
  });

  saveClientState('codex', {
    baseUrl,
    credentialRef: 'keychain',
    tenantId,
    connectedAt: new Date().toISOString(),
    paused: false,
    profilePath: profile.path,
    catalogPath: catalogFile,
    installedClientVersion: codexVersion ?? undefined,
  });

  console.log(`
${chalk.green('Connected.')} Codex can now route through Liftoff.

  ${chalk.dim('Profile:')}    ${profile.path}
  ${chalk.dim('Catalog:')}    ${catalogFile}
  ${chalk.dim('Credential:')} ${backend === 'file' ? '~/.liftoff/credentials/codex (0600)' : backend}
  ${chalk.dim('Codex:')}      ${codexVersion ?? 'not detected'}

  ${chalk.yellow('Important:')} this profile uses your OpenAI Platform API key,
  not your ChatGPT subscription. Your default Codex configuration is untouched.

  Launch with:
    ${chalk.cyan('codex --profile liftoff')}

  ${chalk.dim('CLI commands:')}
    ${chalk.cyan('npx @liftoffos/cli codex status')}
    ${chalk.cyan('npx @liftoffos/cli codex pause')}
    ${chalk.cyan('npx @liftoffos/cli codex resume')}
    ${chalk.cyan('npx @liftoffos/cli codex disconnect')}
`);
}

// ---------------------------------------------------------------------------
// codex status — connected, paused, revoked, misconfigured, unavailable
// ---------------------------------------------------------------------------

export async function codexStatus(): Promise<void> {
  const state = loadCliState().clients.codex;
  if (!state) {
    console.log('Codex: not connected. Run "npx @liftoffos/cli codex setup".');
    return;
  }
  const key = readCredential('codex');
  if (!key) {
    console.log(`Codex: ${chalk.red('misconfigured')} — profile present but no stored credential.`);
    return;
  }

  // Probe the models route: 200 = active, 401 = revoked/paused server-side.
  try {
    const res = await fetch(`${state.baseUrl}/codex/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) {
      console.log(`Codex: ${chalk.green('connected')}${state.paused ? chalk.yellow(' (local state says paused — resuming recommended)') : ''}`);
    } else if (res.status === 401) {
      console.log(state.paused
        ? `Codex: ${chalk.yellow('paused')} — run "npx @liftoffos/cli codex resume".`
        : `Codex: ${chalk.red('revoked')} — reconnect from the Liftoff dashboard.`);
    } else {
      console.log(`Codex: ${chalk.red('misconfigured')} (HTTP ${res.status} from proxy).`);
    }
  } catch {
    console.log(`Codex: ${chalk.yellow('unavailable')} — could not reach ${state.baseUrl}.`);
  }
  console.log(`  ${chalk.dim('Profile:')} ${state.profilePath ?? liftoffProfilePath()}`);
  console.log(`  ${chalk.dim('Codex version at setup:')} ${state.installedClientVersion ?? 'unknown'}`);
}

// ---------------------------------------------------------------------------
// codex pause / resume — SERVER-SIDE credential state. The
// profile stays installed; while paused, `codex --profile liftoff` fails
// clearly before reaching OpenAI and NEVER silently bypasses Liftoff.
// Applies across every machine using this credential.
// ---------------------------------------------------------------------------

export async function codexPause(): Promise<void> {
  const state = loadCliState().clients.codex;
  if (!state) {
    console.log('Nothing to pause. Codex is not connected.');
    return;
  }
  await credentialTransition(state, 'pause');
  saveClientState('codex', { ...state, paused: true });
  console.log(`${chalk.yellow('Paused.')} The Liftoff credential is suspended server-side.`);
  console.log('While paused, "codex --profile liftoff" fails before reaching OpenAI.');
  console.log(`Run ${chalk.cyan('npx @liftoffos/cli codex resume')} to reactivate.`);
}

export async function codexResume(): Promise<void> {
  const state = loadCliState().clients.codex;
  if (!state) {
    console.log('Nothing to resume. Codex is not connected.');
    return;
  }
  await credentialTransition(state, 'resume');
  saveClientState('codex', { ...state, paused: false });
  console.log(`${chalk.green('Resumed.')} "codex --profile liftoff" routes through Liftoff again.`);
}

// ---------------------------------------------------------------------------
// codex disconnect — destructive ONLY to Liftoff-managed material:
// the profile, catalog, keychain/helper entries, and the proxy credential.
// ---------------------------------------------------------------------------

export async function codexDisconnect(): Promise<void> {
  const state = loadCliState().clients.codex;
  const key = readCredential('codex');

  if (key && state) {
    try {
      const res = await fetch(`${state.baseUrl}/v1/revoke`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      if (!res.ok && res.status !== 404) {
        console.error(chalk.yellow(`Warning: revoke returned HTTP ${res.status}; removing local material anyway.`));
      }
    } catch (err) {
      console.error(chalk.yellow(`Warning: could not reach the proxy to revoke (${(err as Error).message}); removing local material anyway.`));
    }
  }

  removeLiftoffProfile();
  deleteCredential('codex');
  deleteClientState('codex');

  console.log(`${chalk.green('Disconnected.')} Removed ${liftoffProfilePath()}, ${catalogPath()}, and the stored credential.`);
  console.log('Your default Codex/ChatGPT configuration was not touched.');
}
