import { Router } from 'express';
import { proxyRegistry } from './registry';
import { getProxyHealth, diagnoseUrl } from './proxy-server';
import { asyncHandler } from '../shared/error-middleware';

export const proxyRoutes = Router();

proxyRoutes.post('/mappings/add', asyncHandler(async (req, res) => { res.json(await proxyRegistry.addMapping(req.body.matchPattern, req.body.upstreamUrl)); }));
proxyRoutes.post('/mappings/remove', asyncHandler(async (req, res) => { await proxyRegistry.removeMapping(req.body.mappingId); res.json({ success: true }); }));
proxyRoutes.get('/mappings', asyncHandler(async (_req, res) => { res.json({ mappings: proxyRegistry.listMappings() }); }));

proxyRoutes.post('/excludes/add', asyncHandler(async (req, res) => { res.json(await proxyRegistry.addExclude(req.body.pattern)); }));
proxyRoutes.post('/excludes/remove', asyncHandler(async (req, res) => { await proxyRegistry.removeExclude(req.body.excludeId); res.json({ success: true }); }));
proxyRoutes.get('/excludes', asyncHandler(async (_req, res) => { res.json({ excludes: proxyRegistry.listExcludes() }); }));

proxyRoutes.post('/upstream/set', asyncHandler(async (req, res) => { await proxyRegistry.setUpstream(req.body.upstreamUrl); res.json({ success: true }); }));
proxyRoutes.post('/upstream/remove', asyncHandler(async (_req, res) => { await proxyRegistry.setUpstream(null); res.json({ success: true }); }));
proxyRoutes.get('/upstream', asyncHandler(async (_req, res) => { res.json({ upstreamUrl: proxyRegistry.getUpstream() }); }));

proxyRoutes.get('/health', asyncHandler(async (_req, res) => { res.json(getProxyHealth()); }));
proxyRoutes.post('/diagnose', asyncHandler(async (req, res) => { res.json(await diagnoseUrl(req.body.url as string)); }));
