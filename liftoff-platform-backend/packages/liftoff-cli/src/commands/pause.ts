// pause command — save config to state file, remove from settings.json

import chalk from 'chalk';
import { getProxyStatus, readSettings, removeProxyConfig } from '../claude-config.js';
import { saveState, loadState } from '../state.js';

export async function pause(): Promise<void> {
  const status = getProxyStatus();
  if (!status.connected) {
    console.log('Nothing to pause. Not connected to Liftoff proxy.');
    return;
  }

  // Save current config to state
  const settings = readSettings();
  const env = settings.env as Record<string, string>;
  saveState({
    baseUrl: env.ANTHROPIC_BASE_URL,
    apiKey: env.ANTHROPIC_API_KEY,
    tenantId: loadState()?.tenantId || 'unknown',
    connectedAt: loadState()?.connectedAt || new Date().toISOString(),
  });

  // Remove proxy config from settings.json
  removeProxyConfig();

  console.log(`${chalk.yellow('Paused.')} Claude Code will connect directly to Anthropic.`);
  console.log(`Run ${chalk.cyan('liftoff resume')} to re-enable proxy routing.`);
}
