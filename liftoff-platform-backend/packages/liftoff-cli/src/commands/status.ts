// status command — show current proxy and MCP connection state

import chalk from 'chalk';
import { getProxyStatus, getMcpStatus } from '../claude-config.js';
import { loadState } from '../state.js';

export async function status(): Promise<void> {
  const proxyStatus = getProxyStatus();
  const mcpStatus = getMcpStatus();
  const state = loadState();

  // ── Proxy row ────────────────────────────────────────────────────────
  if (proxyStatus.connected) {
    console.log(`${chalk.green('●')} Proxy  ${chalk.green('connected')}  ${chalk.dim(`...${proxyStatus.keyHint}`)}  ${chalk.dim(proxyStatus.baseUrl ?? '')}`);
  } else if (state?.apiKey) {
    console.log(`${chalk.yellow('●')} Proxy  ${chalk.yellow('paused')}    Run ${chalk.cyan('liftoff resume')} to re-enable.`);
  } else {
    console.log(`${chalk.dim('●')} Proxy  ${chalk.dim('not connected')}  Run ${chalk.cyan('liftoff setup')} to connect.`);
  }

  // ── MCP row ──────────────────────────────────────────────────────────
  if (mcpStatus.connected) {
    const src = mcpStatus.keyType === 'proxy' ? 'via proxy key' : 'collab token';
    console.log(`${chalk.green('●')} MCP    ${chalk.green('connected')}  ${chalk.dim(`...${mcpStatus.keyHint}`)}  ${chalk.dim(`(${src})`)}`);
  } else {
    console.log(`${chalk.dim('●')} MCP    ${chalk.dim('not connected')}  Run ${chalk.cyan('liftoff setup')} or ${chalk.cyan('liftoff collab')}.`);
  }
}
