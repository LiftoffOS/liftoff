// resume command — restore config from state file to settings.json

import chalk from 'chalk';
import { setProxyConfig } from '../claude-config.js';
import { loadState } from '../state.js';

export async function resume(): Promise<void> {
  const state = loadState();
  if (!state) {
    console.log('No paused connection found. Run `liftoff connect` first.');
    return;
  }

  setProxyConfig(state.baseUrl, state.apiKey);

  console.log(`${chalk.green('Resumed.')} Claude Code is routing through Liftoff.`);
}
