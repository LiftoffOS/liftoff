// `liftoff switch --from <source>` — import an existing OpenClaw, Hermes,
// Claude Code or Codex installation into Liftoff.
//
// One command, no subcommands. Re-running it resumes wherever the migration
// actually is, so there is nothing for the user to remember and no second
// surface that could disagree with the server about their position.
//
// This command NEVER stops, disables, or verifies the source runtime. At
// cutover the browser shows the source-specific pause guidance as copyable
// text; running it stays the user's decision.

import chalk from 'chalk';
import open from 'open';
import { browserAuth } from '../auth.js';
import { runSwitch, switchUrl, type SwitchOutcome } from '../switch/orchestrator.js';
import { openclawAdapter } from '../switch/sources/openclaw.js';
import { hermesAdapter } from '../switch/sources/hermes.js';
import { claudeCodeAdapter } from '../switch/sources/claude-code.js';
import { codexAdapter } from '../switch/sources/codex.js';
import type { MigrationSource, SourceAdapter } from '../switch/contract.js';

const APP_URL = process.env.LIFTOFF_APP_URL || 'https://example.com';

export interface SwitchOptions {
  from?: string;
  path?: string;
  profile?: string;
  /** Read the per-project material of the projects this installation has
   *  registered. Off by default: reading inside somebody's repositories is
   *  their decision, not an assumption this importer gets to make. */
  includeProjects?: boolean;
  json?: boolean;
}

interface AdapterOptions {
  path?: string;
  profile?: string;
  includeProjects?: boolean;
}

const ADAPTERS: Record<MigrationSource, (opts: AdapterOptions) => SourceAdapter> = {
  openclaw: openclawAdapter,
  hermes: hermesAdapter,
  'claude-code': claudeCodeAdapter,
  codex: codexAdapter,
};

/** What the user may type for each source. `claude-code` is the canonical
 *  name; `claude` and `claudecode` are accepted because they are what people
 *  actually type, and rejecting a recognisable name to insist on a hyphen is a
 *  worse first experience than accepting it. */
const SOURCE_ALIASES: Record<string, MigrationSource> = {
  openclaw: 'openclaw',
  hermes: 'hermes',
  'claude-code': 'claude-code',
  claudecode: 'claude-code',
  claude: 'claude-code',
  codex: 'codex',
};

const SUPPORTED_SOURCES = 'openclaw, hermes, claude-code, codex';

export async function switchCommand(options: SwitchOptions): Promise<void> {
  const source = parseSource(options.from);
  const adapter = ADAPTERS[source]({
    path: options.path,
    profile: options.profile,
    includeProjects: options.includeProjects,
  });

  if (!options.json) {
    console.log(chalk.bold(`\nLiftoff Switch — importing from ${sourceLabel(source)}\n`));
  }

  const auth = await browserAuth();

  const outcome = await runSwitch({
    adapter,
    firebaseToken: auth.firebaseToken,
    tenantId: auth.tenantId,
    detectOptions: { path: options.path, profile: options.profile },
  });

  if (options.json) {
    console.log(JSON.stringify(toJson(outcome), null, 2));
    if (outcome.kind === 'no_installation') process.exitCode = 1;
    return;
  }

  await report(outcome);
}

function parseSource(from: string | undefined): MigrationSource {
  if (!from) {
    throw new Error(`--from is required. Supported sources: ${SUPPORTED_SOURCES}`);
  }
  const normalized = from.trim().toLowerCase();
  const resolved = SOURCE_ALIASES[normalized];
  if (resolved) return resolved;
  throw new Error(
    `Unsupported source "${from}". Supported sources: ${SUPPORTED_SOURCES}. ` +
      'DeerFlow, Omnigent and Agno are not supported in this release.',
  );
}

const SOURCE_LABELS: Record<MigrationSource, string> = {
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

function sourceLabel(source: MigrationSource): string {
  return SOURCE_LABELS[source];
}

async function report(outcome: SwitchOutcome): Promise<void> {
  switch (outcome.kind) {
    case 'no_installation':
      console.log(chalk.yellow('No installation found.\n'));
      console.log(outcome.reason);
      process.exitCode = 1;
      return;

    case 'multiple_installations': {
      console.log(chalk.yellow(`Found ${outcome.installations.length} installations.\n`));
      for (const inst of outcome.installations) {
        const profile = inst.profile ? ` (profile: ${inst.profile})` : '';
        console.log(`  ${inst.stateRoot}${profile}`);
      }
      console.log(
        '\nRe-run with --path <path> or --profile <name> to choose which one to import.',
      );
      process.exitCode = 1;
      return;
    }

    case 'onboarding_required':
      console.log(outcome.message);
      await openPath(outcome.openPath);
      return;

    case 'uploaded': {
      const s = outcome.summary;
      console.log(chalk.green('Import scanned and uploaded.\n'));
      console.log(`  Team members        ${s.agents}`);
      console.log(`  Skills              ${s.skills}`);
      console.log(`  Memories            ${s.memories}`);
      console.log(`  Recurring work      ${s.routines}`);
      console.log(`  Connections         ${s.catalogConnectors}`);
      console.log(`  Custom MCP servers  ${s.customMcpServers}`);
      if (s.requiresHosting > 0) console.log(`  Requires hosting    ${s.requiresHosting}`);
      if (s.unsupported > 0) console.log(`  Needs attention     ${s.unsupported}`);
      console.log(
        chalk.dim('\nNo credentials left this machine. You will reconnect them in Liftoff.\n'),
      );
      await openPath(outcome.openPath);
      return;
    }

    case 'resume_web':
      console.log(outcome.message);
      await openPath(outcome.openPath);
      return;

    case 'already_active':
      console.log(chalk.green(outcome.message));
      console.log(
        '\nRe-running this command will not import again. Manage your team in the dashboard.',
      );
      return;
  }
}

async function openPath(path: string): Promise<void> {
  const url = path.startsWith('http') ? path : `${APP_URL}${path}`;
  console.log(`Opening ${url}`);
  await open(url).catch(() => {
    console.log(`If the browser does not open, visit: ${url}`);
  });
}

/** Machine-readable output for support and automation (--json). Carries no
 *  source content and no secrets. */
function toJson(outcome: SwitchOutcome): Record<string, unknown> {
  switch (outcome.kind) {
    case 'no_installation':
      return { outcome: outcome.kind, source: outcome.source, reason: outcome.reason };
    case 'multiple_installations':
      return {
        outcome: outcome.kind,
        source: outcome.source,
        installations: outcome.installations.map((i) => ({
          stateRoot: i.stateRoot,
          profile: i.profile,
          sourceVersion: i.sourceVersion,
          installationFingerprint: i.installationFingerprint,
        })),
      };
    case 'uploaded':
      return {
        outcome: outcome.kind,
        migrationId: outcome.migration.id,
        state: outcome.migration.state,
        summary: outcome.summary,
        next: outcome.openPath,
      };
    case 'resume_web':
      return {
        outcome: outcome.kind,
        migrationId: outcome.migration.id,
        state: outcome.migration.state,
        next: outcome.openPath,
      };
    case 'onboarding_required':
      return {
        outcome: outcome.kind,
        migrationId: outcome.migration?.id ?? null,
        next: outcome.openPath,
      };
    case 'already_active':
      return {
        outcome: outcome.kind,
        migrationId: outcome.migration.id,
        state: outcome.migration.state,
      };
  }
}

export { switchUrl };
