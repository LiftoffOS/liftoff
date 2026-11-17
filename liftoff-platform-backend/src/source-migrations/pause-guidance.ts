// Source-specific pause guidance, served to the cutover screen.
//
// Displayed as copyable REFERENCE TEXT and nothing more. Liftoff does not run
// these commands, does not ask the user to confirm they ran them, and does not
// gate activation on any claim about the source. Pausing the incumbent is the
// user's own operational decision on their own machines.
//
// A checkbox saying "I have stopped OpenClaw" would be an unverifiable
// assertion that reads like a guarantee. The honest surface is the plain
// warning plus the command, which is what this returns.
//
// The same text lives in the CLI adapters (they return it from
// `pauseGuidance()` for terminal display). Duplicated deliberately: the CLI
// cannot import server code, and the web cannot import the CLI.

import type { MigrationSource } from './types';

export interface PauseGuidance {
  command?: string;
  steps: string[];
  supervisedNote?: string;
}

const GUIDANCE: Record<MigrationSource, PauseGuidance> = {
  openclaw: {
    command: 'openclaw gateway stop --disable --force --json',
    steps: [
      'Run this command in your terminal to stop the OpenClaw gateway.',
      'If a service manager such as launchd or systemd owns the gateway, disable that service ' +
        'as well so it does not restart automatically.',
      'Leave your OpenClaw files in place. Liftoff does not delete or modify them.',
    ],
    supervisedNote:
      'Liftoff does not run this command and cannot see whether OpenClaw is still running. ' +
      'If equivalent schedules stay active there, the same work can run twice.',
  },
  hermes: {
    command: 'hermes gateway stop',
    steps: [
      'Run this command in your terminal to stop the Hermes gateway.',
      'If launchd or systemd owns the gateway, disable the corresponding service so it does not ' +
        'restart automatically.',
      'Leave your Hermes files in place. Liftoff does not delete or modify them.',
    ],
    supervisedNote:
      'Liftoff does not run this command and cannot see whether Hermes is still running. ' +
      'If equivalent schedules stay active there, the same work can run twice.',
  },
  // Neither of these is an always-on runtime: they run while the person is
  // using them and stop when that person stops. There is no gateway holding
  // connections and no local scheduled work, so the duplicate-execution risk
  // the two above warn about does not exist — and inventing a command to run
  // would be worse than saying so.
  'claude-code': {
    steps: [
      'Nothing needs to be stopped. Claude Code runs only while you are using it, so there is no ' +
        'background process to pause.',
      'Leave your files in place. Liftoff copies your setup and does not delete or modify anything.',
      'Scheduled work you created in your Claude account keeps running there. Recreate anything ' +
        'you want Liftoff to own as a trigger on the team member.',
    ],
  },
  codex: {
    steps: [
      'Nothing needs to be stopped. Codex runs only while you are using it, so there is no ' +
        'background process to pause.',
      'Leave your files in place. Liftoff copies your setup and does not delete or modify anything.',
    ],
  },
};

export function pauseGuidanceFor(source: MigrationSource): PauseGuidance {
  return GUIDANCE[source];
}
