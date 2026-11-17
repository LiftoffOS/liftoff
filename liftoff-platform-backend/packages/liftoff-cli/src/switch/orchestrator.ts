// Liftoff Switch — resume orchestration.
//
// There is exactly one public command. Re-running it resumes the migration at
// whatever step it actually reached, which is why there is no `switch status`
// and no `switch activate`: a second surface would be a second source of truth
// about where the user is.
//
// Liftoff never stops, disables, or verifies the source runtime. The user owns
// that decision and may pause before or after subscribing. What Liftoff
// controls is that imported recurring work stays disabled until the user
// confirms cutover, which is what makes the duplicate-execution risk explicit
// instead of silent.

import { assertNoSecrets } from './secret-filter';
import {
  type DetectOptions,
  type DetectedInstallation,
  type MigrationBundleV1,
  type MigrationSource,
  type SourceAdapter,
} from './contract';
import {
  createOrResumeMigration,
  getMigration,
  uploadBundle,
  type MigrationView,
} from './api';
import {
  findMigration,
  saveMigration,
  updateMigrationState,
  type MigrationState,
} from './local-state';

const APP_URL = process.env.LIFTOFF_APP_URL || 'https://example.com';

/** What the caller should do once the orchestrator has run. The command layer
 *  owns all terminal output and browser opening; the orchestrator stays
 *  UI-independent so a desktop wrapper can consume the same library. */
export type SwitchOutcome =
  | { kind: 'no_installation'; source: MigrationSource; searched: string[]; reason: string }
  | { kind: 'multiple_installations'; source: MigrationSource; installations: DetectedInstallation[] }
  | { kind: 'uploaded'; migration: MigrationView; openPath: string; summary: BundleSummary }
  | { kind: 'resume_web'; migration: MigrationView; openPath: string; message: string }
  | { kind: 'onboarding_required'; migration: MigrationView | null; openPath: string; message: string }
  | { kind: 'already_active'; migration: MigrationView; message: string };

export interface BundleSummary {
  agents: number;
  skills: number;
  memories: number;
  routines: number;
  catalogConnectors: number;
  customMcpServers: number;
  requiresHosting: number;
  unsupported: number;
}

export interface OrchestratorDeps {
  adapter: SourceAdapter;
  firebaseToken: string;
  tenantId: string;
  detectOptions?: DetectOptions;
}

export function summarize(bundle: MigrationBundleV1): BundleSummary {
  return {
    agents: bundle.agents.length,
    skills: bundle.skills.length,
    memories: bundle.memories.length,
    routines: bundle.routines.length,
    catalogConnectors: bundle.catalogConnectorRequirements.length,
    customMcpServers: bundle.customMcpServerRequirements.length,
    requiresHosting: bundle.hostingRequirements.length,
    unsupported: bundle.unsupportedItems.length,
  };
}

/** The dashboard route for a source. Authenticated: a logged-out visit goes
 *  through the standard login or signup redirect and returns here with the
 *  selected source intact. */
export function switchPath(source: MigrationSource): string {
  return `/dashboard/switch/${source}`;
}

export function switchUrl(source: MigrationSource, suffix = ''): string {
  return `${APP_URL}${switchPath(source)}${suffix}`;
}

/** Map a server migration state to the page the user should be returned to.
 *
 *  Three screens, named exactly as the web app names them. This is the URL the
 *  CLI hands the browser, so a stale name means the page the person lands on
 *  rewrites its own address in front of them. */
export function resumePathForState(source: MigrationSource, state: MigrationState): string {
  const base = switchPath(source);
  switch (state) {
    case 'importing':
    case 'setup_required':
    case 'payment_required':
    case 'failed':
      return `${base}/review`;
    case 'conversion_queued':
    case 'converting':
      return `${base}/building`;
    case 'conversion_ready':
    case 'ready_to_cutover':
    case 'active':
      return `${base}/done`;
    default:
      return `${base}/review`;
  }
}

export async function runSwitch(deps: OrchestratorDeps): Promise<SwitchOutcome> {
  const { adapter, firebaseToken, tenantId } = deps;

  // ── locate the installation ──────────────────────────────────────────
  const installations = await adapter.detect();

  if (installations.length === 0) {
    // Name the paths that were checked. "Explains exactly why it cannot" is an
    // acceptance criterion, and a bare "not found" leaves someone with a
    // non-standard install with nothing to act on.
    const searched = adapter.searchPaths
      ? adapter.searchPaths(deps.detectOptions ?? {})
      : [];
    return {
      kind: 'no_installation',
      source: adapter.source,
      searched,
      reason:
        `No ${adapter.source} installation was found on this machine.` +
        (searched.length > 0 ? ` Checked: ${searched.join(', ')}.` : '') +
        ' If it lives somewhere non-standard, re-run with --path <path>, ' +
        'or with --profile <name> if you use a named profile.',
    };
  }

  if (installations.length > 1 && !deps.detectOptions?.path && !deps.detectOptions?.profile) {
    return { kind: 'multiple_installations', source: adapter.source, installations };
  }

  const installation = installations[0];

  // ── resume, if this installation already has a migration ─────────────
  const known = findMigration(adapter.source, installation.installationFingerprint);

  if (known) {
    let migration: MigrationView;
    try {
      migration = await getMigration(firebaseToken, known.migrationId, tenantId);
    } catch {
      // The server is authoritative; when it cannot be reached, fall back to
      // the last known state rather than starting a second migration.
      return {
        kind: 'resume_web',
        migration: {
          id: known.migrationId,
          source: known.source,
          state: known.lastKnownState,
          itemCount: 0,
          convertedCount: 0,
          unsupportedCount: 0,
          items: [],
          requirements: [],
          webPath: resumePathForState(known.source, known.lastKnownState),
          onboardingComplete: true,
        },
        openPath: resumePathForState(known.source, known.lastKnownState),
        message: 'Could not reach Liftoff to refresh this migration. Opening the last known step.',
      };
    }

    updateMigrationState(adapter.source, installation.installationFingerprint, migration.state);

    if (migration.state === 'active') {
      return {
        kind: 'already_active',
        migration,
        message: `This ${adapter.source} installation is already running on Liftoff.`,
      };
    }

    if (!migration.onboardingComplete) {
      return {
        kind: 'onboarding_required',
        migration,
        openPath: '/dashboard/onboarding',
        message:
          'Finish setting up your Liftoff workspace first. Your import is saved and will be ' +
          'waiting when you are done.',
      };
    }

    // A migration that has not been built yet is re-scanned and re-uploaded.
    //
    // The fingerprint is derived from the installation PATH, so it is blind to
    // the installation's contents changing. Returning the stored bundle here
    // meant the first scan was permanent: someone who ran `switch`, saw the
    // review screen, went and fixed their OpenClaw config, and re-ran got
    // "opening your migration" and their old snapshot. There is no --force, so
    // the fix could never be imported at all.
    //
    // The boundary is the first model call. Before it the bundle is free to be
    // replaced; once conversion has started, re-uploading would invalidate work
    // already paid for, so those states resume untouched.
    if (!REBUILDABLE_STATES.includes(migration.state)) {
      return {
        kind: 'resume_web',
        migration,
        openPath: migration.webPath || resumePathForState(adapter.source, migration.state),
        message: resumeMessage(migration.state),
      };
    }

    const rescanned = await scanAndUpload(deps, installation, migration.id);
    updateMigrationState(adapter.source, installation.installationFingerprint, rescanned.state);
    return {
      kind: 'uploaded',
      migration: rescanned.migration,
      openPath:
        rescanned.migration.webPath || resumePathForState(adapter.source, rescanned.state),
      summary: rescanned.summary,
    };
  }

  // ── first run: create the migration, then scan ───────────────────────
  // The migration record is created before the scan so an interrupted first
  // run still resumes rather than starting over, and so the server (the
  // authority) reports whether onboarding is complete.
  const migration = await createOrResumeMigration(firebaseToken, {
    tenantId,
    source: adapter.source,
    installationFingerprint: installation.installationFingerprint,
    sourceVersion: installation.sourceVersion,
    adapterVersion: adapter.adapterVersion,
  });

  saveMigration({
    migrationId: migration.id,
    source: adapter.source,
    installationFingerprint: installation.installationFingerprint,
    tenantId,
    lastKnownState: migration.state,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // The wizard runs only after standard onboarding completes in this release.
  // The pending migration above survives onboarding untouched.
  if (!migration.onboardingComplete) {
    return {
      kind: 'onboarding_required',
      migration,
      openPath: '/dashboard/onboarding',
      message:
        'Finish setting up your Liftoff workspace first. Your import is saved and will be ' +
        'waiting when you are done.',
    };
  }

  const uploaded = await scanAndUpload(deps, installation, migration.id);
  updateMigrationState(adapter.source, installation.installationFingerprint, uploaded.state);

  return {
    kind: 'uploaded',
    migration: uploaded.migration,
    openPath: uploaded.migration.webPath || resumePathForState(adapter.source, uploaded.state),
    summary: uploaded.summary,
  };
}

/** States in which the stored bundle may still be replaced by a fresh scan.
 *
 *  Everything before the first model call. Once conversion has started, the
 *  bundle is what was paid to distill and must not move under it. */
const REBUILDABLE_STATES: MigrationState[] = [
  'importing',
  'setup_required',
  'payment_required',
  'failed',
];

/** Scan the installation, normalize it, prove it carries no secret, upload it.
 *
 *  Shared by the first run and by a re-run of an unbuilt migration, so the two
 *  cannot drift: a re-scan that skipped the secret gate would be the one path
 *  that leaked. */
async function scanAndUpload(
  deps: OrchestratorDeps,
  installation: DetectedInstallation,
  migrationId: string,
): Promise<{ migration: MigrationView; state: MigrationState; summary: BundleSummary }> {
  const { adapter, firebaseToken, tenantId } = deps;

  const inventory = await adapter.inventory(installation);
  const bundle = await adapter.normalize(inventory);

  // Final gate. Structural exclusion and per-file redaction should already
  // have removed every secret; this proves it before anything leaves the
  // machine. A hit is an adapter defect and refuses the upload rather than
  // quietly cleaning it.
  assertNoSecrets(JSON.stringify(bundle));

  const uploaded = await uploadBundle(firebaseToken, migrationId, tenantId, bundle);
  return { migration: uploaded, state: uploaded.state, summary: summarize(bundle) };
}

function resumeMessage(state: MigrationState): string {
  switch (state) {
    case 'importing':
      return 'Your import is ready to review.';
    case 'setup_required':
      return 'Your import needs your attention before it can be built.';
    case 'payment_required':
      return 'Your import is ready to build.';
    case 'conversion_queued':
    case 'converting':
      return 'Your team is being built. Opening the progress page.';
    case 'conversion_ready':
    case 'ready_to_cutover':
      return 'Your agents are built and awaiting launch. Opening Liftoff.';
    case 'failed':
      return 'This migration stopped with an error. Opening the review page.';
    default:
      return 'Opening your migration.';
  }
}
