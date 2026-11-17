import { Router } from 'express';
import * as actions from './actions';
import * as nav from './navigation';
import * as input from './input';
import * as extraction from './extraction';
import * as screenshotMod from './screenshot';
import * as tabsMod from './tabs';
import * as cookiesMod from './cookies';
import * as consoleMod from './console';
import * as elementsMod from './elements';
import * as networkMod from './network';
import * as stateMod from './state';
import * as captchaMod from './captcha';
import * as cdpInfo from './cdp-info';
import { asyncHandler } from '../shared/error-middleware';

export const browserRoutes = Router();

browserRoutes.get(
  '/info',
  asyncHandler(async (_req, res) => {
    res.json({ cdp_url: await cdpInfo.getCdpWebSocketUrl(), vnc_url: '', vscode_url: '', version: '2.0.0' });
  }),
);

browserRoutes.post(
  '/restart',
  asyncHandler(async (_req, res) => {
    const { browserContextRegistry } = await import('./context');
    await browserContextRegistry.closeAll();
    res.json({ success: true, uptime_ms: 0 });
  }),
);

browserRoutes.post(
  '/screenshot',
  asyncHandler(async (req, res) => {
    const body = req.body as { tabId: string; selector?: string };
    res.json(await screenshotMod.screenshot(body.tabId, body.selector));
  }),
);

// ─── Page verbs ───────────────────────────────────────────────────────────

browserRoutes.post(
  '/page/navigate',
  asyncHandler(async (req, res) => {
    const body = req.body as { tabId?: string; url: string; wait_until?: 'load' | 'domcontentloaded' | 'networkidle'; timeout_ms?: number };
    const result = await actions.navigate(body.tabId, body.url, body.wait_until, body.timeout_ms);
    res.json({ success: true, tabId: result.tabId, data: result.data });
  }),
);

browserRoutes.post('/page/click', asyncHandler(async (req, res) => { await actions.click(req.body.tabId, req.body.selector); res.json({ success: true }); }));
browserRoutes.post('/page/fill', asyncHandler(async (req, res) => { await actions.fill(req.body.tabId, req.body.selector, req.body.value); res.json({ success: true }); }));
browserRoutes.post('/page/type', asyncHandler(async (req, res) => { await actions.type(req.body.tabId, req.body.selector, req.body.value); res.json({ success: true }); }));
browserRoutes.post('/page/press_key', asyncHandler(async (req, res) => { await actions.pressKey(req.body.tabId, req.body.key); res.json({ success: true }); }));
browserRoutes.post('/page/hover', asyncHandler(async (req, res) => { await actions.hover(req.body.tabId, req.body.selector); res.json({ success: true }); }));
browserRoutes.post('/page/select_option', asyncHandler(async (req, res) => { await actions.selectOption(req.body.tabId, req.body.selector, req.body.value); res.json({ success: true }); }));
browserRoutes.post('/page/check', asyncHandler(async (req, res) => { await actions.check(req.body.tabId, req.body.selector); res.json({ success: true }); }));
browserRoutes.post('/page/uncheck', asyncHandler(async (req, res) => { await actions.uncheck(req.body.tabId, req.body.selector); res.json({ success: true }); }));
browserRoutes.post('/page/scroll', asyncHandler(async (req, res) => { await actions.scroll(req.body.tabId, req.body.dx ?? 0, req.body.dy ?? 0); res.json({ success: true }); }));
browserRoutes.post('/page/wait_for', asyncHandler(async (req, res) => { await actions.waitFor(req.body.tabId, req.body.selector, req.body.timeout_ms ?? 30000); res.json({ success: true }); }));
browserRoutes.post('/page/evaluate', asyncHandler(async (req, res) => {
  const result = await actions.evaluate(req.body.tabId, req.body.script);
  res.json({ result });
}));

browserRoutes.post('/page/back', asyncHandler(async (req, res) => { await nav.back(req.body.tabId); res.json({ success: true }); }));
browserRoutes.post('/page/forward', asyncHandler(async (req, res) => { await nav.forward(req.body.tabId); res.json({ success: true }); }));
browserRoutes.post('/page/reload', asyncHandler(async (req, res) => { await nav.reload(req.body.tabId, req.body.waitUntil); res.json({ success: true }); }));

browserRoutes.post('/page/hot_key', asyncHandler(async (req, res) => { await input.hotKey(req.body.tabId, req.body.keys); res.json({ success: true }); }));
browserRoutes.post('/page/upload_file', asyncHandler(async (req, res) => { await input.uploadFile(req.body.tabId, req.body.selector, req.body.filePaths); res.json({ success: true }); }));
browserRoutes.post('/page/scroll_to', asyncHandler(async (req, res) => { await input.scrollTo(req.body.tabId, req.body.x, req.body.y); res.json({ success: true }); }));
browserRoutes.post('/page/scroll_to_element', asyncHandler(async (req, res) => { await input.scrollToElement(req.body.tabId, req.body.selector); res.json({ success: true }); }));

browserRoutes.post('/page/html', asyncHandler(async (req, res) => { res.json(await extraction.extractHtml(req.body.tabId)); }));
browserRoutes.post('/page/text', asyncHandler(async (req, res) => { res.json(await extraction.extractText(req.body.tabId, req.body.selector)); }));
browserRoutes.post('/page/markdown', asyncHandler(async (req, res) => { res.json(await extraction.extractMarkdown(req.body.tabId)); }));

browserRoutes.post('/page/get_elements', asyncHandler(async (req, res) => { res.json(await elementsMod.getElements(req.body.tabId, req.body.selector)); }));
browserRoutes.post('/page/find_text', asyncHandler(async (req, res) => { res.json(await elementsMod.findText(req.body.tabId, req.body.text)); }));

browserRoutes.post('/page/get_console', asyncHandler(async (req, res) => { res.json(await consoleMod.getConsole(req.body.tabId, req.body.since)); }));
browserRoutes.post('/page/export_console', asyncHandler(async (req, res) => { res.json(await consoleMod.exportConsole(req.body.tabId)); }));

// ─── Tabs ─────────────────────────────────────────────────────────────────

browserRoutes.get('/tabs', asyncHandler(async (_req, res) => { res.json(await tabsMod.listTabs()); }));
browserRoutes.post('/tabs/new', asyncHandler(async (_req, res) => { res.json(await tabsMod.newTab()); }));
browserRoutes.post('/tabs/close', asyncHandler(async (req, res) => { await tabsMod.closeTab(req.body.tabId); res.json({ success: true }); }));
browserRoutes.post('/tabs/switch', asyncHandler(async (req, res) => { await tabsMod.switchTab(req.body.tabId); res.json({ success: true }); }));

// ─── Cookies ──────────────────────────────────────────────────────────────

browserRoutes.post('/cookies/get', asyncHandler(async (req, res) => { res.json(await cookiesMod.getCookies(req.body.tabId)); }));
browserRoutes.post('/cookies/set', asyncHandler(async (req, res) => { await cookiesMod.setCookies(req.body.tabId, req.body.cookies); res.json({ success: true }); }));
browserRoutes.post('/cookies/clear', asyncHandler(async (req, res) => { await cookiesMod.clearCookies(req.body.tabId); res.json({ success: true }); }));

// ─── State ────────────────────────────────────────────────────────────────

browserRoutes.post('/state/save', asyncHandler(async (req, res) => { res.json(await stateMod.saveState(req.body.tabId, req.body.stateId)); }));
browserRoutes.post('/state/load', asyncHandler(async (req, res) => { res.json(await stateMod.loadState(req.body.stateId)); }));
browserRoutes.get('/state', asyncHandler(async (_req, res) => { res.json(await stateMod.listStates()); }));
browserRoutes.delete('/state/:id', asyncHandler(async (req, res) => { await stateMod.deleteState(req.params.id); res.json({ success: true }); }));

// ─── Network interception ─────────────────────────────────────────────────

browserRoutes.post('/network/routes/add', asyncHandler(async (req, res) => { res.json(await networkMod.addRoute(req.body.tabId, req.body.urlPattern, req.body.action, req.body.fulfill)); }));
browserRoutes.post('/network/routes/remove', asyncHandler(async (req, res) => { await networkMod.removeRoute(req.body.routeId); res.json({ success: true }); }));
browserRoutes.get('/network/routes', asyncHandler(async (_req, res) => { res.json(networkMod.listRoutes()); }));
browserRoutes.post('/network/headers/set', asyncHandler(async (req, res) => { await networkMod.setHeaders(req.body.tabId, req.body.headers); res.json({ success: true }); }));
browserRoutes.post('/network/headers/scoped', asyncHandler(async (req, res) => { res.json(await networkMod.setHeadersScoped(req.body.tabId, req.body.urlPattern, req.body.headers)); }));
browserRoutes.post('/network/headers/clear', asyncHandler(async (req, res) => { await networkMod.clearHeaders(req.body.tabId); res.json({ success: true }); }));
browserRoutes.get('/network/requests', asyncHandler(async (req, res) => {
  const tabId = req.query.tabId as string;
  const since = req.query.since ? parseInt(req.query.since as string, 10) : undefined;
  res.json(networkMod.listRequests(tabId, since));
}));

// ─── Captcha ─────────────────────────────────────────────────────────────

browserRoutes.post('/captcha/detect', asyncHandler(async (req, res) => { res.json(await captchaMod.detectCaptcha(req.body.tabId)); }));
browserRoutes.post('/captcha/wait', asyncHandler(async (req, res) => { res.json(await captchaMod.waitForCaptchaSolve(req.body.tabId, req.body.timeoutMs)); }));
