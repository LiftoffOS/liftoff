// connect command — auth + key exchange + config write

import os from 'os';
import { createInterface } from 'readline';
import chalk from 'chalk';
import { browserAuth } from '../auth.js';
import { createProxyKey } from '../api-client.js';
import { getExistingAnthropicKey, setProxyConfig, getProxyStatus } from '../claude-config.js';
import { saveState } from '../state.js';

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function connect(): Promise<void> {
  // 1. Check if already connected
  const status = getProxyStatus();
  if (status.connected) {
    const answer = await prompt('Already connected to Liftoff proxy. Reconnect? [y/N] ');
    if (answer.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }
  }

  // 2. Browser auth flow
  console.log('Authenticating with Liftoff...');
  const { firebaseToken, tenantId } = await browserAuth({ client: 'claude' });
  console.log('Authenticated successfully.');

  // 3. Get Anthropic API key
  let anthropicApiKey = getExistingAnthropicKey();
  if (anthropicApiKey) {
    const masked = `${anthropicApiKey.substring(0, 10)}...${anthropicApiKey.slice(-4)}`;
    const answer = await prompt(`Detected existing Anthropic API key (${masked}). Use it? [Y/n] `);
    if (answer.toLowerCase() === 'n') {
      anthropicApiKey = null;
    }
  }
  if (!anthropicApiKey) {
    anthropicApiKey = await prompt('Paste your Anthropic API key (from console.anthropic.com): ');
    if (!anthropicApiKey) {
      console.error('No API key provided. Cancelled.');
      process.exit(1);
    }
  }

  // 4. Create proxy key
  console.log('Creating proxy key...');
  const result = await createProxyKey(firebaseToken, tenantId, anthropicApiKey);

  // 5. Write config
  setProxyConfig(result.setupInstructions.baseUrl, result.key);

  // 6. Save state for pause/resume
  saveState({
    baseUrl: result.setupInstructions.baseUrl,
    apiKey: result.key,
    tenantId,
    connectedAt: new Date().toISOString(),
  });

  // 7. Print success with available commands
  const workspace = result.name.replace('Claude Code (', '').replace(')', '') || os.hostname();
  console.log(`
${chalk.green('Connected.')} Claude Code is now routed through Liftoff.

  ${chalk.dim('Workspace:')}  ${workspace}
  ${chalk.dim('Key:')}        ...${result.keyHint}

  ${chalk.dim('Available commands:')}
    ${chalk.cyan('liftoff pause')}       Temporarily stop routing through Liftoff
    ${chalk.cyan('liftoff resume')}      Resume routing through Liftoff
    ${chalk.cyan('liftoff disconnect')}  Revoke key and fully disconnect
    ${chalk.cyan('liftoff status')}      Show current connection status

  ${chalk.dim('Note: ANTHROPIC_API_KEY overrides any Claude Pro/Max subscription.')}
  ${chalk.dim('Your Anthropic API key billing applies while connected.')}
`);
}
