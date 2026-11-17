import { randomUUID } from 'crypto';
import { browserContextRegistry } from './context';
import { RouteNotFoundError } from '../shared/errors';
import type { BrowserRouteAction, BrowserRouteFulfillSpec, BrowserCapturedRequest } from '@liftoffos/sandbox-contracts';

interface RouteRecord {
  routeId: string;
  tabId: string;
  urlPattern: string;
  action: BrowserRouteAction;
  fulfill?: BrowserRouteFulfillSpec;
}

const activeRoutes = new Map<string, RouteRecord>();

export async function addRoute(tabId: string, urlPattern: string, action: BrowserRouteAction, fulfill?: BrowserRouteFulfillSpec): Promise<{ routeId: string }> {
  const routeId = randomUUID();
  await browserContextRegistry.withPageLock(tabId, async (page, entry) => {
    const handler = async (route: import('playwright').Route) => {
      switch (action) {
        case 'block':
          return route.abort();
        case 'fulfill':
          return route.fulfill({
            status: fulfill?.status ?? 200,
            body: fulfill?.body ?? '',
            headers: fulfill?.headers ?? {},
          });
        case 'continue':
          return route.continue();
      }
    };
    entry.activeRoutes.set(routeId, { urlPattern, handler });
    await page.route(urlPattern, handler);
  });
  activeRoutes.set(routeId, { routeId, tabId, urlPattern, action, fulfill });
  return { routeId };
}

export async function removeRoute(routeId: string): Promise<void> {
  const rec = activeRoutes.get(routeId);
  if (!rec) throw new RouteNotFoundError();
  await browserContextRegistry.withPageLock(rec.tabId, async (page, entry) => {
    const handlerEntry = entry.activeRoutes.get(routeId);
    if (handlerEntry) {
      await page.unroute(handlerEntry.urlPattern, handlerEntry.handler);
      entry.activeRoutes.delete(routeId);
    }
  });
  activeRoutes.delete(routeId);
}

export function listRoutes(): { routes: Array<{ routeId: string; tabId: string; urlPattern: string; action: BrowserRouteAction }> } {
  return {
    routes: Array.from(activeRoutes.values()).map(r => ({
      routeId: r.routeId,
      tabId: r.tabId,
      urlPattern: r.urlPattern,
      action: r.action,
    })),
  };
}

export async function setHeaders(tabId: string, headers: Record<string, string>): Promise<void> {
  await browserContextRegistry.withPageLock(tabId, async page => {
    await page.setExtraHTTPHeaders(headers);
  });
}

export async function setHeadersScoped(tabId: string, urlPattern: string, headers: Record<string, string>): Promise<{ routeId: string }> {
  const routeId = randomUUID();
  await browserContextRegistry.withPageLock(tabId, async (page, entry) => {
    const handler = async (route: import('playwright').Route) => {
      const existing = route.request().headers();
      await route.continue({ headers: { ...existing, ...headers } });
    };
    entry.activeRoutes.set(routeId, { urlPattern, handler });
    await page.route(urlPattern, handler);
  });
  activeRoutes.set(routeId, { routeId, tabId, urlPattern, action: 'continue' });
  return { routeId };
}

export async function clearHeaders(tabId: string): Promise<void> {
  await browserContextRegistry.withPageLock(tabId, async page => {
    await page.setExtraHTTPHeaders({});
  });
}

export function listRequests(tabId: string, since?: number): { requests: BrowserCapturedRequest[] } {
  const captured = browserContextRegistry.getCapturedRequests(tabId, since);
  return {
    requests: captured.map(c => ({
      requestId: c.requestId,
      url: c.url,
      method: c.method,
      status: c.status,
      durationMs: c.durationMs,
      requestHeaders: c.requestHeaders,
      responseHeaders: c.responseHeaders,
      requestBody: c.requestBody,
      responseBody: c.responseBody,
      failed: c.failed,
    })),
  };
}
