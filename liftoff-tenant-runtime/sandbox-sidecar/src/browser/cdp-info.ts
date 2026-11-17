import { browserContextRegistry } from './context';
import { config } from '../config';

/**
 * Returns the public CDP WebSocket URL that runtime/Playwright callers attach
 * to via `chromium.connectOverCDP(...)`. We discover the canonical
 * webSocketDebuggerUrl by hitting Chromium's HTTP /json/version endpoint on
 * the locally bound CDP port, then rewrite the host through the nginx /cdp/
 * proxy so the runtime caller goes through JWT auth.
 */
export async function getCdpWebSocketUrl(): Promise<string> {
  const local = browserContextRegistry.cdpEndpoint();
  if (!local) return '';
  try {
    const res = await fetch('http://127.0.0.1:9222/json/version');
    if (!res.ok) return '';
    const body = (await res.json()) as { webSocketDebuggerUrl?: string };
    if (!body.webSocketDebuggerUrl) return '';
    const path = new URL(body.webSocketDebuggerUrl).pathname;
    return `${config.sandboxPublicUrl.replace(/^https?:/, 'wss:')}/cdp${path}`;
  } catch {
    return '';
  }
}
