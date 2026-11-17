// collab command — connect Claude Code collaboration tools without the proxy
// Issued liftoff_mcp_* token: valid on /mcp only (not the Anthropic proxy).
// Intended for developers who want peer collaboration tools without routing
// all Anthropic traffic through Liftoff.

import chalk from 'chalk';
import { browserAuth } from '../auth.js';
import { exchangeSetupToken } from '../api-client.js';
import { setMcpConfig, getMcpStatus } from '../claude-config.js';
import { saveState, loadState } from '../state.js';

export async function collab(): Promise<void> {
  const mcpStatus = getMcpStatus();
  if (mcpStatus.connected) {
    console.log(`Already connected to Liftoff collaboration tools (key: ...${mcpStatus.keyHint}).`);
    console.log(`Run ${chalk.cyan('liftoff disconnect')} first to reconnect.`);
    return;
  }

  console.log('Authenticating with Liftoff...\n');
  console.log(`${chalk.dim('This will add Liftoff collaboration tools to Claude Code without routing')}`)
  console.log(`${chalk.dim('Anthropic API calls through Liftoff.\n')}`);

  // Opens /cli-auth?mode=collab — frontend auto-creates mcp token + setupToken
  const { firebaseToken, tenantId, setupToken, codeVerifier } = await browserAuth({ mode: 'collab' });

  if (!setupToken) {
    console.error('No setup token received. Please try again.');
    process.exit(1);
  }

  // Exchange setup token for the actual MCP token (same PKCE flow as setup)
  const result = await exchangeSetupToken(firebaseToken, setupToken, codeVerifier);

  if (!result.proxyKey.startsWith('liftoff_mcp_')) {
    console.error('Unexpected token type received. Please try again.');
    process.exit(1);
  }

  setMcpConfig(result.proxyKey);

  // Merge into existing state (preserve proxy key if present)
  const existingState = loadState();
  saveState({
    baseUrl: existingState?.baseUrl ?? result.baseUrl,
    apiKey: existingState?.apiKey ?? '',
    tenantId,
    connectedAt: existingState?.connectedAt ?? new Date().toISOString(),
    mcpToken: result.proxyKey,
    mcpTokenId: result.tokenId,
  });

  const keyHint = result.proxyKey.slice(-4);
  console.log(`
${chalk.green('Connected.')} Liftoff collaboration tools are now available in Claude Code.

  ${chalk.dim('MCP token:')} ...${keyHint}

  ${chalk.dim('Tools available after restarting Claude Code:')}
    ${chalk.cyan('liftoff_read_messages')}     Check for pending tasks from teammates
    ${chalk.cyan('liftoff_find_teammates')}    Discover agents and colleagues
    ${chalk.cyan('liftoff_send_message')}      Message a specific teammate
    ${chalk.cyan('liftoff_share_context')}     Write to shared team memory
    ${chalk.cyan('liftoff_read_context')}      Search shared team memory
    ${chalk.cyan('liftoff_delegate_task')}     Assign a task to a platform agent

  ${chalk.dim('Restart Claude Code for changes to take effect.')}
`);
}
