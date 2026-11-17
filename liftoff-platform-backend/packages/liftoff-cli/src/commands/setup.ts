// setup command — authenticate with Liftoff, fetch proxy key, write settings
// Used after dashboard creates the key. No API key input needed here.

import chalk from 'chalk';
import { browserAuth } from '../auth.js';
import { exchangeSetupToken } from '../api-client.js';
import { setProxyConfig, getProxyStatus } from '../claude-config.js';
import { saveState } from '../state.js';

export async function setup(): Promise<void> {
  const status = getProxyStatus();
  if (status.connected) {
    console.log(`Already connected to Liftoff proxy (key: ...${status.keyHint}).`);
    console.log(`Run ${chalk.cyan('liftoff disconnect')} first to reconnect.`);
    return;
  }

  console.log('Authenticating with Liftoff...\n');

  const { firebaseToken, tenantId, setupToken, codeVerifier } = await browserAuth({ client: 'claude' });

  if (!setupToken) {
    console.error('No setup token received. Make sure you created a key on the Liftoff dashboard first.');
    process.exit(1);
  }

  // Exchange the setup token for the actual proxy key (PKCE: include code_verifier)
  const result = await exchangeSetupToken(firebaseToken, setupToken, codeVerifier);

  // Write config
  setProxyConfig(result.baseUrl, result.proxyKey);

  saveState({
    baseUrl: result.baseUrl,
    apiKey: result.proxyKey,
    tenantId,
    connectedAt: new Date().toISOString(),
  });

  const keyHint = result.proxyKey.slice(-4);
  console.log(`
${chalk.green('Connected.')} Claude Code is now routed through Liftoff.

  ${chalk.dim('Key:')}  ...${keyHint}

  ${chalk.dim('Collaboration tools available in Claude Code (restart required):')}
    ${chalk.cyan('liftoff_read_messages')}     Check for pending tasks from teammates
    ${chalk.cyan('liftoff_find_teammates')}    Discover agents and colleagues in your workspace
    ${chalk.cyan('liftoff_send_message')}      Message a specific teammate or platform agent
    ${chalk.cyan('liftoff_share_context')}     Write a note to shared team memory
    ${chalk.cyan('liftoff_read_context')}      Search shared team memory
    ${chalk.cyan('liftoff_delegate_task')}     Assign a task to a platform agent

  ${chalk.dim('CLI commands:')}
    ${chalk.cyan('liftoff pause')}       Temporarily stop routing through Liftoff
    ${chalk.cyan('liftoff resume')}      Resume routing through Liftoff
    ${chalk.cyan('liftoff disconnect')}  Revoke key and fully disconnect
    ${chalk.cyan('liftoff status')}      Show current connection status

  ${chalk.dim('Restart Claude Code for changes to take effect.')}
`);
}
