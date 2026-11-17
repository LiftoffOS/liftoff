import * as http from 'node:http';
import * as net from 'node:net';
import httpProxy from 'http-proxy';
import { proxyRegistry } from './registry';
import { eventEmitter } from '../shared/event-emitter';
import { logger } from '../shared/logger';

interface ProxyHealth {
  healthy: boolean;
  requestsServed: number;
  errors: number;
}

const health: ProxyHealth = { healthy: false, requestsServed: 0, errors: 0 };

export function startForwardProxy(port = 8118): http.Server {
  const proxy = httpProxy.createProxyServer({ secure: false });

  const server = http.createServer((req, res) => {
    health.requestsServed++;
    const target = proxyRegistry.resolveTarget(req.url ?? '');
    if (target === 'BLOCK') {
      res.writeHead(403);
      res.end('Blocked by proxy mapping');
      return;
    }
    eventEmitter.emit({ type: 'browser_navigation', data: { url: req.url, target } });
    proxy.web(req, res, { target: target ?? `http://${req.headers.host}` }, err => {
      health.errors++;
      logger.warn({ msg: 'proxy web error', err: String(err) });
    });
  });

  server.on('connect', (req, clientSocket, head) => {
    const [host, port] = (req.url ?? '').split(':');
    const serverSocket = net.connect(parseInt(port, 10) || 443, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });
    serverSocket.on('error', err => {
      health.errors++;
      clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n${err.message}`);
    });
  });

  server.listen(port, '127.0.0.1', () => {
    health.healthy = true;
    logger.info({ msg: 'forward proxy listening', port });
  });
  return server;
}

export function getProxyHealth(): ProxyHealth {
  return { ...health };
}

export async function diagnoseUrl(url: string): Promise<{ reachable: boolean; latencyMs: number; statusCode?: number; error?: string }> {
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return { reachable: true, latencyMs: Date.now() - start, statusCode: res.status };
  } catch (e) {
    return { reachable: false, latencyMs: Date.now() - start, error: (e as Error).message };
  }
}
