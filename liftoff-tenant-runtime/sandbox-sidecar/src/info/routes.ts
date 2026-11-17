import { Router } from 'express';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { config } from '../config';
import { asyncHandler } from '../shared/error-middleware';
import { ticketStore } from '../auth/ticket-store';
import { getFreeBytes } from '../health';

const BOOT_TIME = Date.now();

async function getPythonVersion(): Promise<string> {
  return new Promise(resolve => {
    execFile('python3', ['--version'], (_err, stdout, stderr) => {
      resolve((stdout || stderr || '').trim());
    });
  });
}

async function getOpenvscodeVersion(): Promise<string> {
  try {
    const productJson = JSON.parse(await fs.readFile('/opt/openvscode-server/product.json', 'utf-8')) as { version?: string };
    return productJson.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function workspaceUsedBytes(): Promise<number> {
  return new Promise(resolve => {
    execFile('du', ['-sb', config.workspaceDir], { maxBuffer: 1024 * 1024 }, (_err, stdout) => {
      const parts = stdout.trim().split(/\s+/);
      resolve(parseInt(parts[0] ?? '0', 10));
    });
  });
}

export const infoRoutes = Router();

infoRoutes.get(
  '/info',
  asyncHandler(async (_req, res) => {
    const { ticket: vscodeTicket } = ticketStore.issue('vscode', 300_000);
    const { ticket: vncTicket } = ticketStore.issue('vnc', 300_000);
    const { ticket: cdpTicket } = ticketStore.issue('cdp', 300_000);
    res.json({
      sandbox_id: config.sandboxId,
      version: process.env.SANDBOX_IMAGE_VERSION ?? '2.0.0',
      capabilities: ['shell', 'file', 'browser', 'vscode'],
      cdp_url: `${config.sandboxPublicUrl}/cdp/?ticket=${cdpTicket}`,
      vscode_url: `${config.sandboxPublicUrl}/vscode/?ticket=${vscodeTicket}&folder=/workspace`,
      vnc_url: `${config.sandboxPublicUrl}/vnc/?ticket=${vncTicket}&autoconnect=true`,
      uptime_ms: Date.now() - BOOT_TIME,
    });
  }),
);

infoRoutes.get(
  '/context',
  asyncHandler(async (_req, res) => {
    const [used, free, pyVersion, ovscVersion] = await Promise.all([
      workspaceUsedBytes(),
      getFreeBytes(config.workspaceDir),
      getPythonVersion(),
      getOpenvscodeVersion(),
    ]);
    res.json({
      sandbox_id: config.sandboxId,
      capabilities: ['shell', 'file', 'browser', 'vscode'],
      workspace_size_bytes: used,
      workspace_free_bytes: free,
      uptime_ms: Date.now() - BOOT_TIME,
      env_summary: {
        NODE_VERSION: process.version,
        PYTHON_VERSION: pyVersion,
        PLAYWRIGHT_VERSION: '1.48.0',
        OPENVSCODE_VERSION: ovscVersion,
      },
    });
  }),
);

// Runtime updates the sandbox's routing context (threadId / invocationId) so
// sandbox-emitted events flow to the right SSE subscriber. Long-lived sandboxes
// may serve multiple invocations; the runtime keeps this aligned.
infoRoutes.post(
  '/routing-context',
  asyncHandler(async (req, res) => {
    const { setRoutingContext } = await import('../shared/event-emitter');
    const body = req.body as { threadId?: string; invocationId?: string };
    setRoutingContext(body);
    res.json({ success: true });
  }),
);

infoRoutes.post(
  '/restart',
  asyncHandler(async (_req, res) => {
    // Drain everything we own in-process. Cannot self-restart (would kill us);
    // SIGHUP'ing other supervisord-managed programs requires supervisorctl
    // running as the supervisord user, which is best-effort.
    const restarted: string[] = [];
    try {
      const { ptyManager } = await import('../shell/pty-manager');
      await ptyManager.killAll();
      restarted.push('pty-manager');
    } catch {
      // ignore
    }
    try {
      const { bashSessionManager } = await import('../bash/session-manager');
      bashSessionManager.killAll();
      restarted.push('bash-session-manager');
    } catch {
      // ignore
    }
    try {
      const { watcherRegistry } = await import('../file/watcher');
      await watcherRegistry.stopAll();
      restarted.push('watcher-registry');
    } catch {
      // ignore
    }
    try {
      const { browserContextRegistry } = await import('../browser/context');
      await browserContextRegistry.closeAll();
      restarted.push('browser-context');
    } catch {
      // ignore
    }
    try {
      await fs.rm('/workspace/.browser-state', { recursive: true, force: true });
      await fs.rm('/workspace/.browser-logs', { recursive: true, force: true });
      await fs.rm('/workspace/.browser-recordings', { recursive: true, force: true });
      restarted.push('workspace-cleanup');
    } catch {
      // ignore
    }
    res.json({ success: true, restarted_programs: restarted });
  }),
);
