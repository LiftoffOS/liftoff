// disconnect command — revoke key(s) + remove all config + delete state
// MCP-aware: detects proxy key, MCP token, or both and revokes each.

import { createInterface } from 'readline';
import chalk from 'chalk';
import { getProxyStatus, getMcpStatus, readSettings, removeProxyConfig, removeMcpConfig } from '../claude-config.js';
import { loadState, deleteState } from '../state.js';
import { revokeProxyKey, revokeMcpToken } from '../api-client.js';

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function disconnect(): Promise<void> {
  const proxyStatus = getProxyStatus();
  const mcpStatus = getMcpStatus();

  const hasProxy = proxyStatus.connected;
  const hasMcpOnly = !hasProxy && mcpStatus.connected && mcpStatus.keyType === 'collab';

  // Also check paused state
  const state = loadState();
  const hasPaused = !hasProxy && !!state?.apiKey;

  if (!hasProxy && !hasMcpOnly && !hasPaused) {
    console.log('Not connected to Liftoff. Nothing to disconnect.');
    return;
  }

  // ── Revoke proxy key ────────────────────────────────────────────────
  if (hasProxy || hasPaused) {
    let apiKey: string | null = null;
    if (hasProxy) {
      const settings = readSettings();
      const env = settings.env as Record<string, string>;
      apiKey = env.ANTHROPIC_API_KEY;
    } else {
      apiKey = state?.apiKey ?? null;
    }

    if (apiKey) {
      try {
        console.log('Revoking proxy key...');
        await revokeProxyKey(apiKey);
        console.log('Proxy key revoked.');
      } catch (error) {
        const message = (error as Error).message;
        console.error(`Could not reach Liftoff to revoke the proxy key: ${message}`);
        const answer = await prompt('Remove local config anyway? [y/N] ');
        if (answer.toLowerCase() !== 'y') {
          console.log('Cancelled. Local config preserved.');
          return;
        }
      }
    }
    removeProxyConfig();
  }

  // ── Revoke MCP-only token ───────────────────────────────────────────
  if (hasMcpOnly && state?.mcpTokenId) {
    try {
      console.log('Revoking MCP token...');
      await revokeMcpToken(state.mcpToken!, state.mcpTokenId);
      console.log('MCP token revoked.');
    } catch {
      console.log(`${chalk.dim('Note:')} Could not revoke MCP token on server — removing locally.`);
    }
    removeMcpConfig();
  }

  deleteState();

  const proxyMsg = (hasProxy || hasPaused) ? 'Proxy key revoked. Claude Code will connect directly to Anthropic.' : '';
  const mcpMsg = hasMcpOnly ? 'MCP token revoked. Collaboration tools removed.' : '';
  const msg = [proxyMsg, mcpMsg].filter(Boolean).join(' ');

  console.log(`${chalk.green('Disconnected.')} ${msg}`);
}
