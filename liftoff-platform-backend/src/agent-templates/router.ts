// Agent Templates — read-only catalog API
// GET /api/agent-templates — paginated list with cursor-based pagination

import { Router, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { getActiveTemplates, getTemplate } from './loader';
import { listTeamPresets, getTeamPreset } from './team-preset-loader';
import { describeEditedTemplate } from './description-service';
import { tenantAuthMiddleware } from '../infrastructure/middleware';
import { log } from '../infrastructure/logging';
import type { AgentTemplate } from './schema';
import type { DepartmentCategory } from './schema';

export const agentTemplatesRouter = Router();

const VALID_DEPARTMENTS = new Set<DepartmentCategory>([
  'customer_support', 'sales', 'marketing', 'finance',
  'hr', 'legal', 'operations', 'engineering', 'other',
]);

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Gallery projection.
 *
 * The list route used to `res.json` the whole template object, so loading the
 * Explore page handed the browser every template's `responsibilities` (~2.5k
 * chars) and `additionalContext` (~1.5k chars) — the operative prompt text, for
 * the entire catalog, in one paginated sweep the client already runs to
 * exhaustion. Nothing on a gallery card renders either field.
 *
 * Named explicitly rather than delete-by-omission so the projection cannot
 * silently widen when a field is added to the template schema. Same reasoning
 * as `a2a/agent-card-router.ts`'s AGENT_CARD_COLUMNS.
 *
 * `role` is here because the card's selection analytics report it and the
 * connector step titles off it; it is a job title, not prose.
 */
export function toTemplateCard(t: AgentTemplate) {
  return {
    id: t.id,
    version: t.version,
    schemaVersion: t.schemaVersion,
    displayName: t.displayName,
    departmentCategory: t.departmentCategory,
    description: t.description,
    role: t.role,
    requiredConnectors: t.requiredConnectors,
    optionalConnectors: t.optionalConnectors,
    defaultAgentType: t.defaultAgentType,
  };
}

/**
 * Per-caller cap on single-template reads.
 *
 * The detail route still serves the full body, so the catalog is no longer
 * dumped in one request but remains walkable one template at a time. A person
 * opens a handful before hiring; a sweep of the whole catalog does not look
 * like that. Sized well above real browsing so it never interrupts a session.
 */
const templateDetailLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  // Keyed on the authenticated uid the auth middleware validated. An earlier
  // version keyed on `req.query.tenantId`, which this route is never called
  // with — so it fell through to a bare `req.ip` on every request, making the
  // cap per-IP rather than per-caller and tripping express-rate-limit's IPv6
  // key-generator validation on boot. The ip fallback stays only for the case
  // the middleware let through without a uid, and goes through the helper so
  // an IPv6 caller cannot walk their own address space to evade it.
  keyGenerator: (req) => req.ctx?.userId || ipKeyGenerator(req.ip || 'unknown'),
  message: { error: 'Too many template requests, please try again later' },
});

/**
 * The one endpoint on this router that costs money per call, so it is capped —
 * but sized for editing, not against it.
 *
 * It was 20/min, paired with a client-side ceiling of 20 per visit. Both were
 * sized for abuse and met by ordinary use: somebody rewriting a template
 * commits far more edits than that, one call each. The client ceiling has been
 * removed (it froze the line with nothing to say so), which leaves this as the
 * only guard, so it has to clear a real editing session comfortably.
 *
 * 60/min is roughly one commit a second sustained for a minute, which nobody
 * types, and costs about twelve cents at the small tier even if somebody did.
 * The client also caches by the text it describes, so repeats are free.
 */
const describeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.ctx?.userId || ipKeyGenerator(req.ip || 'unknown'),
  message: { error: 'Too many description requests, please try again later' },
});

/**
 * GET /api/agent-templates
 *
 * Query params:
 *   departmentCategory — filter by department
 *   limit             — page size (default 20, max 100)
 *   cursor            — pagination cursor (template id)
 *
 * Returns: { templates, nextCursor?, total }
 */
agentTemplatesRouter.get('/', (req: Request, res: Response) => {
  try {
    const departmentCategory = req.query.departmentCategory as DepartmentCategory | undefined;
    const limitParam = req.query.limit as string | undefined;
    const cursor = req.query.cursor as string | undefined;

    if (departmentCategory && !VALID_DEPARTMENTS.has(departmentCategory)) {
      return res.status(400).json({
        error: 'Invalid departmentCategory',
        validValues: [...VALID_DEPARTMENTS],
      });
    }

    const limit = limitParam
      ? Math.min(Math.max(parseInt(limitParam, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT)
      : DEFAULT_LIMIT;

    // Get all active templates
    let templates = getActiveTemplates();

    // Filter by department
    if (departmentCategory) {
      templates = templates.filter(t => t.departmentCategory === departmentCategory);
    }

    // Sort by id for stable cursor-based pagination
    templates.sort((a, b) => a.id.localeCompare(b.id));

    const total = templates.length;

    // Apply cursor pagination
    if (cursor) {
      const cursorIndex = templates.findIndex(t => t.id === cursor);
      if (cursorIndex >= 0) {
        templates = templates.slice(cursorIndex + 1);
      }
    }

    // Fetch one extra to detect if there's a next page
    const page = templates.slice(0, limit + 1);
    const hasMore = page.length > limit;
    const results = page.slice(0, limit);

    const nextCursor = hasMore ? results[results.length - 1]?.id : undefined;

    return res.json({
      templates: results.map(toTemplateCard),
      ...(nextCursor ? { nextCursor } : {}),
      total,
    });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/agent-templates/team-presets
 *
 * Lists the team presets (bundles of roles provisioned together). Registered BEFORE
 * `/:templateId` so the literal path is not swallowed by the param route.
 */
agentTemplatesRouter.get('/team-presets', (_req: Request, res: Response) => {
  try {
    // Projected for the same reason as the template list: every role carries
    // `roleProse` (up to 20k chars), which is the prose that distills into the
    // role's behaviour. The service-auth twin in internal-router.ts already
    // projects this way; the public route was the one returning presets whole.
    const presets = listTeamPresets().map((p) => ({
      id: p.id,
      version: p.version,
      schemaVersion: p.schemaVersion,
      displayName: p.displayName,
      description: p.description,
      roles: p.roles.map((r) => ({ key: r.key, templateId: r.templateId })),
      roleCount: p.roles.length,
    }));
    return res.json({ presets, total: presets.length });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/agent-templates/team-presets/:id
 *
 * Returns a single team preset by id.
 */
agentTemplatesRouter.get('/team-presets/:id', (req: Request, res: Response) => {
  try {
    const preset = getTeamPreset(req.params.id);
    if (!preset) {
      return res.status(404).json({ error: 'Team preset not found', id: req.params.id });
    }
    // roleProse withheld here too. Provisioning reads presets server-side via
    // the loader (team-provisioning/service.ts), so no client needs the prose.
    return res.json({
      id: preset.id,
      version: preset.version,
      schemaVersion: preset.schemaVersion,
      displayName: preset.displayName,
      description: preset.description,
      roles: preset.roles.map((r) => ({ key: r.key, templateId: r.templateId })),
    });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/agent-templates/:templateId
 *
 * Returns a single template by id.
 */
agentTemplatesRouter.get('/:templateId', templateDetailLimiter, (req: Request, res: Response) => {
  try {
    const { templateId } = req.params;
    const templates = getActiveTemplates();
    const template = templates.find(t => t.id === templateId);

    if (!template) {
      return res.status(404).json({ error: 'Template not found', templateId });
    }

    return res.json(template);
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/agent-templates/:templateId/description
 *
 * Rewrites the one-line description for a template whose prose has been edited
 * inline on the explore detail step. Nothing is stored: the line is read on
 * that screen and replaced by the distilled `summary` the moment the team is
 * actually hired.
 *
 * This is the only route on an otherwise read-only catalog API that spends
 * money, so it is capped harder than the rest and refuses anything that is not
 * plausibly an edited template.
 */
agentTemplatesRouter.post(
  '/:templateId/description',
  describeLimiter,
  // The only route on this router that needs a tenant, and the only one that
  // spends money, which are the same fact. Every read here is catalog data that
  // is identical for everybody, so the router is mounted without tenancy and
  // `req.ctx.tenantId` is otherwise never set — this attaches the check to the
  // one route that requires it. `editTeams` rather than `viewDashboard`: the
  // caller is part-way through composing a team, and someone who may not edit
  // teams has no reason to be rewriting one's description.
  tenantAuthMiddleware('editTeams'),
  async (req: Request, res: Response) => {
    try {
      const { templateId } = req.params;
      if (!getActiveTemplates().some(t => t.id === templateId)) {
        return res.status(404).json({ error: 'Template not found', templateId });
      }

      // Set by tenantAuthMiddleware above, which has already proved the caller
      // belongs to the tenant they named.
      const tenantId = req.ctx?.tenantId as string;

      const { role, responsibilities, additionalContext } = req.body ?? {};
      if (typeof role !== 'string' || typeof responsibilities !== 'string') {
        return res.status(400).json({ error: 'role and responsibilities are required' });
      }
      // Nothing to describe. The client only calls this after an edit, so an
      // empty body is a bug on one side or the other, not a cheap request.
      if (!role.trim() || !responsibilities.trim()) {
        return res.status(400).json({ error: 'role and responsibilities must not be empty' });
      }

      const description = await describeEditedTemplate(
        templateId,
        {
          role,
          responsibilities,
          additionalContext: typeof additionalContext === 'string' ? additionalContext : '',
        },
        tenantId,
      );

      return res.json({ description });
    } catch (error) {
      // The client renders nothing rather than falling back to the catalog's
      // line, so a 500 here is a visible but honest outcome: no description,
      // rather than one describing a team that no longer exists.
      log.error(
        { err: error, templateId: req.params.templateId },
        'template description generation failed',
      );
      return res.status(500).json({ error: 'Could not write a description' });
    }
  },
);

/**
 * GET /api/agent-templates/:templateId/versions
 *
 * Returns version metadata for a single template.
 * Currently only one version is loaded at a time; availableVersions reflects the
 * current loaded version. Clients can use this to detect template version mismatches
 * before deploying from a cached preview.
 */
agentTemplatesRouter.get('/:templateId/versions', (req: Request, res: Response) => {
  try {
    const { templateId } = req.params;
    const template = getTemplate(templateId);

    if (!template) {
      return res.status(404).json({ error: 'Template not found', templateId });
    }

    const currentVersion = template.version;

    return res.json({
      templateId,
      currentVersion,
      availableVersions: [currentVersion],
    });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});
