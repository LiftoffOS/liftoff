// Internal router for agent template catalog.
// Mounted before authMiddleware so internal services can access templates
// via X-Service-Auth header without Firebase tokens.

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getActiveTemplates } from './loader';
import { listTeamPresets } from './team-preset-loader';
import type { DepartmentCategory } from './schema';

const VALID_DEPARTMENTS = new Set<DepartmentCategory>([
  'customer_support', 'sales', 'marketing', 'finance',
  'hr', 'legal', 'operations', 'engineering', 'other',
]);

function verifyServiceAuth(req: Request, res: Response, next: () => void): void {
  const token = req.headers['x-service-auth'] as string | undefined;
  const expected = process.env['WORKFORCE_SERVICE_TOKEN'];
  if (!token || !expected) {
    res.status(401).json({ error: 'Missing service authentication' });
    return;
  }
  try {
    const ok =
      Buffer.byteLength(token) === Buffer.byteLength(expected) &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
    if (!ok) throw new Error('token mismatch');
  } catch {
    res.status(401).json({ error: 'Invalid service token' });
    return;
  }
  next();
}

export const agentTemplatesInternalRouter = Router();

// GET /api/internal/agent-templates[?departmentCategory=...&limit=...&cursor=...]
agentTemplatesInternalRouter.get('/', verifyServiceAuth, (req: Request, res: Response) => {
  const dept = req.query.departmentCategory as DepartmentCategory | undefined;
  if (dept && !VALID_DEPARTMENTS.has(dept)) {
    return res.status(400).json({ error: 'Invalid departmentCategory', validValues: [...VALID_DEPARTMENTS] });
  }
  const limit = Math.min(Math.max(parseInt((req.query.limit as string) || '100', 10), 1), 100);
  const cursor = req.query.cursor as string | undefined;

  let templates = getActiveTemplates();
  if (dept) templates = templates.filter(t => t.departmentCategory === dept);
  templates.sort((a, b) => a.id.localeCompare(b.id));

  if (cursor) {
    const idx = templates.findIndex(t => t.id === cursor);
    if (idx >= 0) templates = templates.slice(idx + 1);
  }
  const page = templates.slice(0, limit + 1);
  const hasMore = page.length > limit;
  const results = page.slice(0, limit);
  const nextCursor = hasMore ? results[results.length - 1]?.id : undefined;

  return res.json({ templates: results, ...(nextCursor ? { nextCursor } : {}), hasMore, total: results.length });
});

// GET /api/internal/agent-templates/team-presets — team bundles the CAIO can provision.
// Registered as a distinct literal path so it is not swallowed by a param route.
agentTemplatesInternalRouter.get('/team-presets', verifyServiceAuth, (_req: Request, res: Response) => {
  const presets = listTeamPresets().map((p) => ({
    id: p.id,
    displayName: p.displayName,
    description: p.description,
    roleKeys: p.roles.map((r) => r.key),
    roleCount: p.roles.length,
  }));
  return res.json({ presets, total: presets.length });
});

// GET /api/internal/agent-templates/:templateId
agentTemplatesInternalRouter.get('/:templateId', verifyServiceAuth, (req: Request, res: Response) => {
  const templates = getActiveTemplates();
  const template = templates.find(t => t.id === req.params.templateId);
  if (!template) {
    return res.status(404).json({ error: 'Template not found', templateId: req.params.templateId });
  }
  return res.json(template);
});
