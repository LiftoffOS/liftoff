import { promises as fs, statSync } from 'fs';
import { config } from './config';

export interface HealthCheck {
  healthy: boolean;
  latencyMs?: number;
  error?: string;
}

export interface HealthChecks {
  xvfb: HealthCheck;
  chromium: HealthCheck;
  vscode: HealthCheck;
  nginx: HealthCheck;
  workspace: HealthCheck;
  workspace_freeBytes: number;
}

async function probeXvfb(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    statSync('/tmp/.X11-unix/X99');
    return { healthy: true, latencyMs: Date.now() - start };
  } catch (e) {
    return { healthy: false, error: (e as Error).message };
  }
}

async function probeChromium(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    // Lazy import so health endpoint doesn't pull playwright when chromium not in use.
    // The browser singleton is exposed via getBrowser() in browser/context.ts.
    const { isBrowserHealthy } = await import('./browser/context');
    const healthy = await isBrowserHealthy();
    return { healthy, latencyMs: Date.now() - start };
  } catch (e) {
    return { healthy: false, error: (e as Error).message };
  }
}

async function probeUrl(url: string, timeoutMs: number): Promise<HealthCheck> {
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { healthy: res.ok, latencyMs: Date.now() - start };
  } catch (e) {
    return { healthy: false, error: (e as Error).message };
  }
}

async function probeWorkspace(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    await fs.access(config.workspaceDir);
    const free = await getFreeBytes(config.workspaceDir);
    // We don't know total bytes without statvfs; assume an issue if free < 100MB.
    const healthy = free > 100 * 1024 * 1024;
    return { healthy, latencyMs: Date.now() - start };
  } catch (e) {
    return { healthy: false, error: (e as Error).message };
  }
}

export async function getFreeBytes(path: string): Promise<number> {
  try {
    const s = await fs.statfs(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export async function runHealthChecks(): Promise<HealthChecks> {
  const [xvfb, chromium, vscode, nginx, workspace, workspace_freeBytes] = await Promise.all([
    probeXvfb(),
    probeChromium(),
    probeUrl('http://127.0.0.1:8200/', 1000),
    probeUrl('http://127.0.0.1:8080/nginx-up', 1000),
    probeWorkspace(),
    getFreeBytes(config.workspaceDir),
  ]);
  return { xvfb, chromium, vscode, nginx, workspace, workspace_freeBytes };
}
