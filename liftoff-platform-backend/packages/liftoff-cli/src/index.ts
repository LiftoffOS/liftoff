#!/usr/bin/env node

// Liftoff CLI — connect Claude Code and Codex to the Liftoff platform
// Usage: npx @liftoffos/cli <command>
//
// Command model: explicit `claude ...` and `codex ...` namespaces,
// with the historical flat commands preserved as backward-compatible aliases
// for Claude so existing documentation keeps working. Claude and Codex state
// are fully independent (versioned clients store — src/state.ts).

import { Command } from 'commander';
import { setup } from './commands/setup.js';
import { collab } from './commands/collab.js';
import { pause } from './commands/pause.js';
import { resume } from './commands/resume.js';
import { disconnect } from './commands/disconnect.js';
import { status } from './commands/status.js';
import {
  codexSetup,
  codexStatus,
  codexPause,
  codexResume,
  codexDisconnect,
} from './commands/codex.js';
import { switchCommand, type SwitchOptions } from './commands/switch.js';
import { runCredentialHelper } from './credential-helper.js';
import pkg from '../package.json';

const { version } = pkg;

const program = new Command();

program
  .name('liftoff')
  .description('Connect Claude Code and Codex to the Liftoff platform')
  .version(version);

function run(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  };
}

// ── claude namespace ───────────────────────────────────────────────────

const claude = program
  .command('claude')
  .description('Manage the Claude Code connection');

claude.command('setup').description('Connect Claude Code to your Liftoff workspace').action(run(setup));
claude.command('collab').description('Connect Claude Code collaboration tools without the proxy').action(run(collab));
claude.command('pause').description('Temporarily stop routing Claude Code through Liftoff').action(run(pause));
claude.command('resume').description('Resume routing Claude Code through Liftoff').action(run(resume));
claude.command('disconnect').description('Revoke key and fully disconnect Claude Code').action(run(disconnect));
claude.command('status').description('Show the Claude Code connection status').action(run(status));

// ── codex namespace ────────────────────────────────────────────────────

const codex = program
  .command('codex')
  .description('Manage the Codex (OpenAI) connection');

codex.command('setup').description('Connect a locally installed Codex CLI through Liftoff').action(run(codexSetup));
codex.command('status').description('Show the Codex connection status').action(run(codexStatus));
codex.command('pause').description('Suspend the Liftoff Codex credential server-side').action(run(codexPause));
codex.command('resume').description('Reactivate the Liftoff Codex credential').action(run(codexResume));
codex.command('disconnect').description('Revoke and remove all Liftoff-managed Codex material').action(run(codexDisconnect));

// ── switch ─────────────────────────────────────────────────────────────
// One public command. There is deliberately no `switch status` and no
// `switch activate`: re-running this resumes the migration at whatever step it
// actually reached, so there is only ever one surface and one source of truth.

program
  .command('switch')
  .description('Import an existing OpenClaw, Hermes, Claude Code or Codex installation into Liftoff')
  .requiredOption('--from <source>', 'Source platform: openclaw, hermes, claude-code or codex')
  .option('--path <path>', 'Non-standard source installation path')
  .option('--profile <name>', 'Named source profile')
  // Off by default. Reading inside somebody's repositories is a different
  // decision from reading their own configuration directory, and it is theirs
  // to make rather than ours to assume.
  .option(
    '--include-projects',
    'Also read the per-project instructions and skills of the projects this installation has registered',
  )
  .option('--json', 'Machine-readable output for support and automation')
  .action((options: SwitchOptions) => run(() => switchCommand(options))());

// ── credential helper ──────────────────────────────────────────────────
// In-process variant of the stable helper installed under ~/.liftoff/bin
//. stdout carries ONLY the credential; diagnostics go to stderr.

program
  .command('credential-helper <client>')
  .description('Print the stored Liftoff proxy credential for a client (stdout only)')
  .action((client: string) => {
    process.exit(runCredentialHelper(client));
  });

// ── Backward-compatible flat aliases (Claude) ─────────────────────────

program.command('setup', { hidden: true }).description('Alias for "claude setup"').action(run(setup));
program.command('collab', { hidden: true }).description('Alias for "claude collab"').action(run(collab));
program.command('pause', { hidden: true }).description('Alias for "claude pause"').action(run(pause));
program.command('resume', { hidden: true }).description('Alias for "claude resume"').action(run(resume));
program.command('disconnect', { hidden: true }).description('Alias for "claude disconnect"').action(run(disconnect));
program.command('status', { hidden: true }).description('Alias for "claude status"').action(run(status));

program.parse();
