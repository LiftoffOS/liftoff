// classify-connector-tools.ts
//
// CLI script: classify connector tools via the platform-backend's classifier
// route (POST /api/internal/tools/classify, CONNECTOR_SERVICE_TOKEN). Does NOT
// call a model directly and carries no prompt of its own — the one classifier
// platform-backend runs decides the sensitivity categories, and its usage is
// recorded there as platform overhead (the global inventory has no tenant).
//
// Modes:
//   --connector <type> --token <oauth_token>    Connect to live MCP, classify all tools
//   --connector <type> --from-registry          Classify from static connector-functions-registry
//   --connector <type> --from-inventory <path>  Classify from a harvested vendor-MCP inventory
//                                               (scripts/harvest-vendor-mcp-inventory.ts) — the
//                                               a priori path: no account, key or token
//   --backfill-all --from-registry              Process all registry connectors without seeds
//   --list-unclassified                         List connectors without seed entries
//
// Every tool is first put through decideClass, which settles its EFFECT from
// evidence stronger than a model's reading of the name — the server's own
// annotations, the HTTP method the operation maps to, a scope set that only
// permits reads, or the registry's declared categories — and only a tool with
// none of those uses the route's effect class. Write-class tools are then
// sent to the route for their SENSITIVITY categories, and the seed row
// carries the union: the sensitivity categories the oversight gate matches on
// plus the effect tokens the runtime reads (write / destructive / outbound).
// A read stays ARRAY[]::TEXT[]. Effect decisions never reach the route: it is
// sent names and descriptions and nothing else.
//
// Required env vars:
//   PLATFORM_BACKEND_URL       e.g. https://platform-backend-YOUR_PROJECT_HASH-uw.a.run.app
//   CONNECTOR_SERVICE_TOKEN    from GCP Secret Manager: connector-service-token
//
// Quick start:
//   export PLATFORM_BACKEND_URL=https://platform-backend-YOUR_PROJECT_HASH-uw.a.run.app
//   export CONNECTOR_SERVICE_TOKEN=$(gcloud secrets versions access latest \
//     --secret=connector-service-token --project=YOUR_CONTROL_PROJECT_STAGING)
//   npm run classify:tools -- --connector linear --from-registry
//   npm run classify:tools -- --backfill-all --from-registry

import crypto from 'crypto';
import { parseArgs } from 'node:util';
import { createTransport } from '@liftoffos/mcp-transports';
// NOTE: We import CONNECTORS directly (not getMCPServerConfig) to avoid pulling
// in ../infra/logging.js which is a production-only dependency not available
// when running scripts outside the service container.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CONNECTORS } from '../src/catalog/connectors';
import { getConnectorFunctions } from '../src/catalog/connector-functions-registry';
import {
  ClassifyRouteRateLimited,
  classifyToolsViaRoute,
  type ClassifyRouteResult,
} from '../src/scripts/classify-tools-route-client';

// ── Seeded connectors (already have migration seed entries in platform-backend) ──────
// Update this set after running successfully for a new connector so --list-unclassified
// reflects actual coverage.
const SEEDED_CONNECTORS = new Set<string>([
  'google_mail',
  'google_calendar',
  'google_docs',
  'google_drive',
  'google_sheets',
  'google_slides',
  'microsoft_outlook_mail',
  'microsoft_outlook_calendar',
  'microsoft_teams',
  'microsoft_todo',
  'microsoft_contacts',
  'microsoft_onenote',
  'microsoft_sharepoint',
  'microsoft_planner',
  'microsoft_onedrive',
  'slack',
  'salesforce',
  'hubspot',
  'stripe',
  'github',
  'dropbox',
  'box',
  // NOTE: atlassian_jira was seeded as 'jira' in migration 039 — intentionally
  // omitted here so --backfill-all re-seeds it under the current connector type name.
  'gmail',
  // Capability-absorption data vendors — seeded from --from-registry runs
  // (platform-funded internal tier; no customer connection required).
  'tikhub',
  'strale',
  'nasdaq',
]);

// ── Types ────────────────────────────────────────────────────────────────────

interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** What the SERVER (or the vendor's docs) says the tool does. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  /** The HTTP method the operation maps to, when the inventory states it. */
  httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Declared categories, for a tool that came from the static registry / overlay. */
  registryCategories?: string[];
}

/** Shape written by scripts/harvest-vendor-mcp-inventory.ts. */
interface VendorToolInventory {
  connectorType: string;
  harvestedAt: string;
  source: 'live_unauthenticated' | 'vendor_docs' | 'vendor_oss' | 'vendor_api_reference' | 'oauth_scopes';
  sourceUrl: string;
  operationKey?: { tool: string; arg: string };
  tools: Array<{
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
    annotations?: MCPTool['annotations'];
    httpMethod?: MCPTool['httpMethod'];
    path?: string;
  }>;
}

// ── Effect decision ───────────────────────────────────────────────────────────

type ClassSource = 'annotation' | 'http_method' | 'scope_proof' | 'registry' | 'llm' | 'meta_tool';

interface ClassDecision {
  effect: 'read' | 'write';
  destructive: boolean;
  source: ClassSource;
}

// SYNC: liftoff-tenant-runtime/src/tool-gateway/tool-effect.ts — MUTATING_VERBS.
// The runtime's own list, so a seed is never weaker than the heuristic it
// replaces: a name the runtime would read as a write cannot be seeded as a
// read by mistake (the check that fails the run below), and an annotation's
// readOnlyHint is honoured only when the name shows no mutating verb, the
// asymmetry the runtime applies.
const MUTATING_VERBS: ReadonlySet<string> = new Set([
  'create', 'update', 'delete', 'remove', 'add', 'set', 'write', 'send',
  'merge', 'insert', 'upsert', 'patch', 'put', 'edit', 'modify', 'replace',
  'move', 'rename', 'archive', 'restore', 'publish', 'unpublish', 'deploy',
  'cancel', 'approve', 'reject', 'assign', 'unassign', 'invite', 'revoke',
  'grant', 'enable', 'disable', 'submit', 'execute', 'trigger', 'import',
  'export', 'upload', 'lock', 'unlock', 'subscribe', 'unsubscribe', 'transfer',
  'convert', 'clear', 'reset', 'dismiss', 'refund', 'charge', 'pay', 'apply',
]);

// SYNC: liftoff-tenant-runtime/src/agent-execution/adapter/vendor-mcp-classify.ts — DESTRUCTIVE_VERBS.
// What the runtime marks destructive from a name; used only for a tool no
// stronger evidence decided, so the seed matches the heuristic there too.
const DESTRUCTIVE_VERBS: ReadonlySet<string> = new Set([
  'delete', 'remove', 'destroy', 'drop', 'purge', 'wipe', 'erase',
  'revoke', 'cancel', 'terminate', 'uninstall', 'archive', 'close', 'void',
]);

function tokenizeName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

/** The name whose verbs are judged. An expanded meta-tool row is keyed
 *  `<tool>:<operation>`; the operation is what the call does, and the tool
 *  half (`execute`) would otherwise read as a mutating verb on every row. */
function operationName(name: string): string {
  const colon = name.indexOf(':');
  return colon > 0 ? name.slice(colon + 1) : name;
}

function nameHasMutatingVerb(name: string): boolean {
  return tokenizeName(operationName(name)).some((t) => MUTATING_VERBS.has(t));
}

function nameHasDestructiveVerb(name: string): boolean {
  return tokenizeName(operationName(name)).some((t) => DESTRUCTIVE_VERBS.has(t));
}

/** The effect tokens the runtime reads off a category array. */
const EFFECT_TOKENS = new Set(['write', 'destructive', 'outbound']);

/**
 * Settle a tool's effect from the strongest evidence available, before any
 * model is asked. Returns source 'llm' only when nothing stronger exists.
 */
function decideClass(tool: MCPTool, inventorySource?: VendorToolInventory['source']): ClassDecision {
  // A token that holds only *:read scopes cannot write, whatever a tool is
  // called or annotated — the strongest evidence there is, so it goes first.
  if (inventorySource === 'oauth_scopes') return { effect: 'read', destructive: false, source: 'scope_proof' };
  const a = tool.annotations;
  if (a?.destructiveHint === true) return { effect: 'write', destructive: true, source: 'annotation' };
  if (a?.readOnlyHint === true && !nameHasMutatingVerb(tool.name)) {
    return { effect: 'read', destructive: false, source: 'annotation' };
  }
  // A GET is a read — unless the name itself reads as a write, in which case
  // the same asymmetry the readOnlyHint gets applies: a seed is never weaker
  // than the runtime's reading of the name, so the tool falls through and the
  // mutating verb keeps it write-class.
  if (tool.httpMethod === 'GET' && !nameHasMutatingVerb(tool.name)) {
    return { effect: 'read', destructive: false, source: 'http_method' };
  }
  if (tool.httpMethod === 'DELETE') return { effect: 'write', destructive: true, source: 'http_method' };
  if (tool.httpMethod === 'POST' || tool.httpMethod === 'PUT' || tool.httpMethod === 'PATCH') {
    return { effect: 'write', destructive: false, source: 'http_method' };
  }
  if (tool.registryCategories) {
    const cats = tool.registryCategories.map((c) => c.toLowerCase());
    const write = cats.some((c) => EFFECT_TOKENS.has(c));
    return { effect: write ? 'write' : 'read', destructive: cats.includes('destructive'), source: 'registry' };
  }
  return { effect: 'write', destructive: nameHasDestructiveVerb(tool.name), source: 'llm' };
}

// ── Meta-tool servers ─────────────────────────────────────────────────────────
//
// A code-mode server exposes a handful of tools whose NAME says nothing about
// what a call does. The rules are stated per connector type rather than
// inferred: what each meta-tool is classified as is a decision about that
// vendor, recorded here so the seed and the review sheet agree.

interface MetaToolRule {
  /** Fixed categories for a named meta-tool; [] is a read. */
  fixed: Record<string, string[]>;
  /** A tool whose rows come from the inventory's `<tool>:<operation>` entries
   *  instead of the bare tool (omnisend's execute). */
  expandedTool?: string;
}

const META_TOOL_RULES: Record<string, MetaToolRule> = {
  omnisend: {
    fixed: { search: [], tool_schema: [], tool_documentation: [] },
    expandedTool: 'execute',
  },
  paddle: {
    fixed: { execute: ['write', 'financialActions'], search: [], report_missing_tool: [] },
  },
  crustdata: {
    fixed: { execute: ['write', 'dataChanges'], list_tools: [], get_schema: [] },
  },
  amplitude: {
    fixed: { get_amplitude_context: [], list_tool_categories: [], get_category_tools: [], describe_tool: [] },
  },
};

// SensitivityCategory and related constants are copied from (and must stay in
// sync with) liftoff-platform-backend/src/external-agents/tool-classifier.ts.
// Canonical source: platform-backend tool-classifier.ts
type SensitivityCategory =
  | 'customerCommunication'
  | 'financialActions'
  | 'dataChanges'
  | 'externalPublishing'
  | 'hiringDecisions';

// The classification prompt is platform-backend's alone (mcp/tool-classifier.ts
// and the TypeSafe question set beside it); this script carries no copy.

// SYNC: liftoff-platform-backend/src/external-agents/tool-classifier.ts — VALID_CATEGORIES
const VALID_CATEGORIES: SensitivityCategory[] = [
  'customerCommunication',
  'financialActions',
  'dataChanges',
  'externalPublishing',
  'hiringDecisions',
];

// SYNC: liftoff-platform-backend/src/external-agents/tool-classifier.ts — hashDescription
function hashDescription(description: string): string {
  return crypto.createHash('sha256').update(description).digest('hex').substring(0, 12);
}

// ── MCP URL resolution (inline to avoid importing mcp-server-registry.ts) ───────────
//
// mcp-server-registry.ts imports ../infra/logging.js which is not available
// outside the service container. We replicate only the URL-resolution logic here.

interface ResolvedMCPConfig {
  mcpUrl: string;
  transport: 'streamable-http' | 'sse' | 'auto';
  isVendorHosted: boolean;
  isSidecar: boolean;
}

function resolveMCPConfig(connectorType: string): ResolvedMCPConfig | null {
  const def = CONNECTORS[connectorType];
  if (!def || !def.mcp) return null;
  const mcp = def.mcp;

  if (mcp.kind === 'vendor_hosted') {
    return {
      mcpUrl: mcp.mcpUrl,
      transport: mcp.transport as 'streamable-http' | 'sse',
      isVendorHosted: true,
      isSidecar: false,
    };
  }

  // sidecar: needs MCP_SIDECAR_BASE_URL env. Narrow to the sidecar kind before
  // reading sidecarPath — the union also includes composio_managed / customer_hosted,
  // which have no sidecarPath (and no static MCP URL resolvable here).
  if (mcp.kind === 'sidecar') {
    const sidecarBase = process.env['MCP_SIDECAR_BASE_URL'] ?? '';
    if (!sidecarBase) return null; // caller handles missing sidecar base

    return {
      mcpUrl: `${sidecarBase}${mcp.sidecarPath}`,
      transport: 'streamable-http',
      isVendorHosted: false,
      isSidecar: true,
    };
  }

  // composio_managed → tools come from the overlay / live Composio MCP;
  // customer_hosted → URL is resolved per tenant at runtime. Neither is
  // resolvable to a static MCP URL here, so classification for these uses the
  // --from-registry path or a live --token connect, not this resolver.
  return null;
}

// ── Classification over the platform-backend route ───────────────────────────
//
// POST /api/internal/tools/classify with the tool's NAME and DESCRIPTION. The
// route answers the sensitivity categories and, beside them, the effect class
// the classifier is confident of; the effect is read only for a tool that
// decideClass could settle from no evidence at all (source 'llm').

async function classifyTool(
  tool: MCPTool,
  pbUrl: string,
  serviceToken: string,
): Promise<ClassifyRouteResult> {
  const results = await classifyToolsViaRoute(
    pbUrl,
    serviceToken,
    [{ name: tool.name, description: tool.description ?? '' }],
    { kind: 'global_inventory' },
  );
  const result = results.find((r) => r.name === tool.name);
  if (!result) return { name: tool.name, categories: [], effectClass: null };
  return {
    ...result,
    categories: result.categories.filter((c): c is SensitivityCategory =>
      VALID_CATEGORIES.includes(c as SensitivityCategory),
    ),
  };
}

// ── Draft-variant detection ────────────────────────────────────────────────────

function detectDraftVariant(
  toolName: string,
  categories: SensitivityCategory[],
  allToolNames: string[],
): string | null {
  if (!categories.includes('customerCommunication')) return null;

  const draftCandidates = allToolNames.filter((t) => {
    const lower = t.toLowerCase();
    return lower.includes('draft') || lower.startsWith('draft_');
  });

  const stem = toolName.replace(/^(send_|create_|post_)/, '');
  for (const candidate of draftCandidates) {
    if (candidate.toLowerCase().includes(stem.toLowerCase())) {
      return candidate;
    }
  }

  if (draftCandidates.length === 1) return draftCandidates[0]!;

  return null;
}

// ── SQL generation ────────────────────────────────────────────────────────────

function escapeStr(s: string): string {
  return s.replace(/'/g, "''");
}

/** One classified tool: the sensitivity categories the classifier route (or a rule)
 *  returned, the effect decision, and the draft variant. */
interface ToolClassification {
  categories: SensitivityCategory[];
  draftVariant: string | null;
  decision: ClassDecision;
  /** Extra effect tokens a declared source carried (the overlay's `outbound`). */
  extraTokens: string[];
  /** What the human pass should look at: evidence the rules refused. */
  reviewNote?: string;
}

/** A vendor readOnlyHint the name rule refused. The runtime applies the same
 *  asymmetry — a server cannot declare `delete_x` read-only and buy its way
 *  past the gate — so the seed cannot be weaker than that; but a job-status
 *  read named `get_bulk_delete_items_job` is exactly what a person reviewing
 *  the sheet can settle with a manual override, and they should not have to
 *  find it themselves. */
function reviewNoteFor(tool: MCPTool, decision: ClassDecision): string | undefined {
  if (decision.effect !== 'write') return undefined;
  if (tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint === true) return undefined;
  const verb = tokenizeName(operationName(tool.name)).find((t) => MUTATING_VERBS.has(t));
  return verb ? `vendor readOnlyHint refused: name carries the mutating verb '${verb}'` : undefined;
}

/** The category array a seed row carries: the sensitivity categories plus the
 *  effect tokens the runtime reads. A read is empty. */
function seedCategories(cls: ToolClassification): string[] {
  const out = new Set<string>(cls.categories);
  if (cls.decision.effect === 'write') out.add('write');
  if (cls.decision.destructive) out.add('destructive');
  for (const t of cls.extraTokens) out.add(t);
  return [...out];
}

const SEED_REVIEWER = 'vendor-mcp-seed';

function generateSQL(
  connectorType: string,
  tools: MCPTool[],
  classifications: Map<string, ToolClassification>,
): string {
  const date = new Date().toISOString().split('T')[0];

  const rows = tools.map((tool) => {
    const cls = classifications.get(tool.name);
    const categories = cls ? seedCategories(cls) : [];
    const hash = hashDescription(tool.description);
    const categoriesArr =
      categories.length > 0
        ? `ARRAY['${categories.map(escapeStr).join("', '")}']::TEXT[]`
        : `ARRAY[]::TEXT[]`;
    const draftVariantVal =
      cls?.draftVariant ? `'${escapeStr(cls.draftVariant)}'` : 'NULL';
    return (
      `  ('${escapeStr(tool.name)}', '${escapeStr(connectorType)}', '${hash}', ` +
      `${categoriesArr}, ${draftVariantVal}, '${SEED_REVIEWER}', false, NULL)`
    );
  });

  // The conflict target is the post-458 identity (tool_name, integration_type,
  // tenant). The pre-458 shape only resolves while the 459 compat index exists,
  // and a seed that names it stops applying the day that index is dropped.
  return [
    `-- Generated by scripts/classify-connector-tools.ts on ${date}`,
    `-- Connector: ${connectorType} (${tools.length} tools)`,
    `INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)`,
    `VALUES`,
    rows.join(',\n'),
    `ON CONFLICT (tool_name, COALESCE(integration_type, ''), COALESCE(tenant_id, '__global__')) DO UPDATE`,
    `  SET categories = EXCLUDED.categories,`,
    `      tool_description_hash = EXCLUDED.tool_description_hash,`,
    `      reviewed_by = EXCLUDED.reviewed_by,`,
    `      classified_at = NOW();`,
  ].join('\n');
}

// ── Review sheet ──────────────────────────────────────────────────────────────
//
// One markdown table per connector, for the human pass before the migration is
// committed: what each tool was classified as and WHICH evidence decided it.

const REVIEW_DIR = path.resolve(__dirname, '../docs/vendor-mcp-classification-review');

function writeReviewSheet(
  connectorType: string,
  tools: MCPTool[],
  classifications: Map<string, ToolClassification>,
  sourceUrl: string,
  inventorySource: string,
): string {
  const lines: string[] = [
    `# ${connectorType} — tool classification review`,
    '',
    `Source: ${inventorySource} (${sourceUrl})`,
    `Generated by scripts/classify-connector-tools.ts on ${new Date().toISOString().split('T')[0]}. ` +
      'Class is what the seed row carries; deciding source is the evidence that settled the effect ' +
      '(annotation, http_method, scope_proof, registry, meta_tool, or llm when nothing stronger existed).',
    '',
    '| Tool | Class | Deciding source | Source URL | Review note |',
    '|---|---|---|---|---|',
  ];
  for (const tool of tools) {
    const cls = classifications.get(tool.name);
    const categories = cls ? seedCategories(cls) : [];
    const label = categories.length === 0 ? 'read' : categories.join(', ');
    const esc = (v: string) => v.replace(/\|/g, '\\|');
    lines.push(`| \`${esc(tool.name)}\` | ${label} | ${cls?.decision.source ?? 'llm'} | ${sourceUrl} | ${esc(cls?.reviewNote ?? '')} |`);
  }
  const flagged = tools.filter((t) => classifications.get(t.name)?.reviewNote).length;
  if (flagged > 0) {
    lines.push('', `${flagged} tool(s) carry a review note: the vendor states read-only and the name rule refused it. ` +
      'A manual override (is_manual_override = true) is the way to settle one; the seed never weakens the runtime rule on its own.');
  }
  mkdirSync(REVIEW_DIR, { recursive: true });
  const file = path.join(REVIEW_DIR, `${connectorType}.md`);
  writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

// ── --list-unclassified ───────────────────────────────────────────────────────

function listUnclassified(): void {
  const unclassified: string[] = [];

  for (const [type, def] of Object.entries(CONNECTORS)) {
    if (def.status !== 'available') continue;
    if (!def.mcp) continue;
    if (SEEDED_CONNECTORS.has(type)) continue;
    unclassified.push(type);
  }

  if (unclassified.length === 0) {
    console.log('All available MCP connectors have seeds. Nothing to classify.');
    return;
  }

  console.log(`Available MCP connectors without seed entries (${unclassified.length}):\n`);
  for (const type of unclassified) {
    const def = CONNECTORS[type]!;
    const mcpKind = def.mcp?.kind ?? 'unknown';
    const hasRegistry = getConnectorFunctions(type).length > 0;
    const source = hasRegistry ? 'registry' : 'mcp-only';
    console.log(`  ${type.padEnd(32)} (${mcpKind}, ${source})`);
  }
  console.log(
    '\nFor registry connectors:  npm run classify:tools -- --connector <type> --from-registry',
  );
  console.log(
    'For MCP-only connectors:  npm run classify:tools -- --connector <type> --token <oauth_token>',
  );
  console.log(
    '\nTo backfill all registry connectors at once:',
  );
  console.log(
    '  npm run classify:tools -- --backfill-all --from-registry',
  );
}

// ── Classify a single connector ───────────────────────────────────────────────

async function classifyWithRetry(tool: MCPTool, pbUrl: string, serviceToken: string): Promise<ClassifyRouteResult> {
  let retries = 0;
  while (true) {
    try {
      return await classifyTool(tool, pbUrl, serviceToken);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if ((err instanceof ClassifyRouteRateLimited || msg === 'RATE_LIMIT') && retries < 3) {
        retries++;
        process.stdout.write('(rate limited, waiting 1s) ');
        await new Promise((r) => setTimeout(r, 1000));
      } else {
        throw err;
      }
    }
  }
}

interface ClassifyOptions {
  dryRun: boolean;
  /** Present for --from-inventory: where the tools came from, for the review sheet
   *  and the scope-proof decision. */
  inventory?: { source: VendorToolInventory['source']; sourceUrl: string; operationKey?: { tool: string; arg: string } };
  /** Present for --from-registry: the review sheet names the registry. */
  registrySource?: string;
}

async function classifyConnector(
  connectorType: string,
  tools: MCPTool[],
  pbUrl: string,
  serviceToken: string,
  opts: ClassifyOptions,
): Promise<string | null> {
  const meta = META_TOOL_RULES[connectorType];
  // A meta-tool server's expanded tool (omnisend's execute) is seeded as its
  // `execute:<operation>` rows, never as the bare tool: the runtime resolves a
  // call to its operation, and a bare row would gate nothing it could name.
  if (meta?.expandedTool) {
    const expanded = meta.expandedTool;
    if (!tools.some((t) => t.name.startsWith(`${expanded}:`))) {
      throw new Error(
        `${connectorType}: META_TOOL_RULES expands "${expanded}" but the inventory carries no ` +
        `"${expanded}:<operation>" rows — re-harvest with --source live`,
      );
    }
    tools = tools.filter((t) => t.name !== expanded);
  }

  const allToolNames = tools.map((t) => t.name);
  const classifications = new Map<string, ToolClassification>();

  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i]!;
    process.stdout.write(
      `  [${String(i + 1).padStart(3)}/${tools.length}] ${tool.name} ... `,
    );

    let decision: ClassDecision;
    let categories: SensitivityCategory[];
    const fixed = meta?.fixed[tool.name];
    if (fixed) {
      // Stated per vendor, not inferred: a code-mode server's tool names say
      // nothing a model could read.
      // The rule states the class; a destructiveHint the vendor publishes on
      // the tool still adds caution, never removes it.
      const write = fixed.some((c) => EFFECT_TOKENS.has(c)) || tool.annotations?.destructiveHint === true;
      decision = {
        effect: write ? 'write' : 'read',
        destructive: fixed.includes('destructive') || tool.annotations?.destructiveHint === true,
        source: 'meta_tool',
      };
      categories = fixed.filter((c): c is SensitivityCategory => VALID_CATEGORIES.includes(c as SensitivityCategory));
    } else {
      decision = decideClass(tool, opts.inventory?.source);
      if (decision.effect === 'read') {
        // A read carries no sensitivity category — the classifier's own rule — so
        // it is not asked.
        categories = [];
      } else {
        const classified = await classifyWithRetry(tool, pbUrl, serviceToken);
        categories = classified.categories as SensitivityCategory[];
        if (decision.source === 'llm' && !nameHasMutatingVerb(tool.name)) {
          // Nothing stronger than the classifier decided this one, so its
          // effect class is used, exactly where the model used to be: a
          // confident read (with no category beside it) is a read; a
          // confident destructive is destructive; and with no confident
          // class, a read is inferred as before from an empty category set.
          // A name carrying a mutating verb stays a write regardless. A
          // registry-declared or annotation-derived effect never reaches
          // this branch and is never overridden.
          if (classified.effectClass === 'read' && categories.length === 0) {
            decision = { ...decision, effect: 'read', destructive: false };
          } else if (classified.effectClass === 'destructive') {
            decision = { ...decision, effect: 'write', destructive: true };
          } else if (classified.effectClass === null && categories.length === 0) {
            decision = { ...decision, effect: 'read', destructive: false };
          }
        }
      }
    }

    // Effect tokens a declared source carried beyond write/destructive — the
    // overlay's `outbound` — travel with the row so the communication policy
    // sees them.
    const extraTokens = (tool.registryCategories ?? []).map((c) => c.toLowerCase()).filter((c) => c === 'outbound');
    const draftVariant = detectDraftVariant(tool.name, categories, allToolNames);
    const reviewNote = reviewNoteFor(tool, decision);
    const cls: ToolClassification = { categories, draftVariant, decision, extraTokens, ...(reviewNote ? { reviewNote } : {}) };
    classifications.set(tool.name, cls);

    const seeded = seedCategories(cls);
    const label = seeded.length === 0 ? 'read-only' : seeded.join(', ');
    const draftLabel = draftVariant ? ` [draft: ${draftVariant}]` : '';
    console.log(`${label}${draftLabel} (${decision.source})`);

    if (decision.source === 'llm' && i < tools.length - 1) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  // Two checks that fail the run. Both catch a seed that is WEAKER than the
  // heuristic it replaces, which is the one way a seed can make things worse.
  const failures: string[] = [];
  for (const tool of tools) {
    const cls = classifications.get(tool.name)!;
    const seeded = seedCategories(cls);
    if (nameHasMutatingVerb(tool.name) && seeded.length === 0) {
      failures.push(`${tool.name}: name carries a mutating verb but would be seeded with no categories`);
    }
    if (tool.annotations?.destructiveHint === true && !seeded.includes('destructive')) {
      failures.push(`${tool.name}: annotated destructive but would be seeded without 'destructive'`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Refusing to emit a seed weaker than the runtime heuristic for "${connectorType}":\n  ` + failures.join('\n  '));
  }

  if (opts.dryRun) {
    console.log(`\n=== Classification summary for "${connectorType}" ===\n`);
    for (const tool of tools) {
      const cls = classifications.get(tool.name)!;
      const seeded = seedCategories(cls);
      const label = seeded.length === 0 ? '(read-only)' : seeded.join(', ');
      const draftLabel = cls.draftVariant ? ` → draft: ${cls.draftVariant}` : '';
      console.log(`  ${tool.name.padEnd(48)} ${label}${draftLabel}  [${cls.decision.source}]`);
    }
    const writeCount = [...classifications.values()].filter((c) => seedCategories(c).length > 0).length;
    console.log(
      `\n${tools.length} tools total · ${writeCount} write-class · ${tools.length - writeCount} read-only`,
    );
    return null;
  }

  const sourceUrl = opts.inventory?.sourceUrl ?? opts.registrySource ?? 'live tools/list';
  const sourceLabel = opts.inventory?.source ?? (opts.registrySource ? 'registry' : 'live_authenticated');
  const sheet = writeReviewSheet(connectorType, tools, classifications, sourceUrl, sourceLabel);
  console.error(`review sheet: ${path.relative(process.cwd(), sheet)}`);

  return generateSQL(connectorType, tools, classifications);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      connector:           { type: 'string' },
      token:               { type: 'string' },
      'mcp-url':           { type: 'string' },
      'from-registry':     { type: 'boolean', default: false },
      'from-inventory':    { type: 'string' },
      'backfill-all':      { type: 'boolean', default: false },
      'list-unclassified': { type: 'boolean', default: false },
      'dry-run':           { type: 'boolean', default: false },
    },
    strict: true,
  });

  // --list-unclassified mode
  if (values['list-unclassified']) {
    listUnclassified();
    return;
  }

  // Resolve the classifier route's credentials (required for all classification modes)
  const pbUrl = process.env['PLATFORM_BACKEND_URL'];
  const serviceToken = process.env['CONNECTOR_SERVICE_TOKEN'];

  if (!values['list-unclassified']) {
    if (!pbUrl) {
      console.error(
        'Error: PLATFORM_BACKEND_URL is not set.\n' +
        'Export the platform-backend URL before running, e.g.:\n' +
        '  export PLATFORM_BACKEND_URL=https://platform-backend-YOUR_PROJECT_HASH-uw.a.run.app',
      );
      process.exit(1);
    }
    if (!serviceToken) {
      console.error(
        'Error: CONNECTOR_SERVICE_TOKEN is not set.\n' +
        'Fetch it from GCP Secret Manager:\n' +
        '  export CONNECTOR_SERVICE_TOKEN=$(gcloud secrets versions access latest \\\n' +
        '    --secret=connector-service-token --project=YOUR_CONTROL_PROJECT_STAGING)',
      );
      process.exit(1);
    }
  }

  // --backfill-all mode: classify all registry connectors that lack seeds
  if (values['backfill-all']) {
    if (!values['from-registry']) {
      console.error(
        'Error: --backfill-all requires --from-registry.\n' +
        'For MCP-only connectors, run --connector <type> --token <token> individually.',
      );
      process.exit(1);
    }

    const pending: string[] = [];
    for (const [type, def] of Object.entries(CONNECTORS)) {
      if (def.status !== 'available') continue;
      if (!def.mcp) continue;
      if (SEEDED_CONNECTORS.has(type)) continue;
      if (getConnectorFunctions(type).length === 0) continue; // skip MCP-only
      pending.push(type);
    }

    if (pending.length === 0) {
      console.log('All registry connectors are already seeded.');
      return;
    }

    console.log(`Backfilling ${pending.length} registry connectors: ${pending.join(', ')}\n`);

    const sqlBlocks: string[] = [];

    for (const connectorType of pending) {
      const registryFns = getConnectorFunctions(connectorType);
      const tools: MCPTool[] = registryFns.map((fn) => ({
        name: fn.name,
        description: fn.description,
        inputSchema: fn.inputSchema as Record<string, unknown>,
        registryCategories: (fn.categories ?? []).map(String),
      }));

      console.log(`\n── ${connectorType} (${tools.length} tools from registry) ──`);
      const sql = await classifyConnector(connectorType, tools, pbUrl!, serviceToken!, {
        dryRun: values['dry-run']!,
        registrySource: 'src/catalog/connector-functions-registry.ts',
      });
      if (sql) sqlBlocks.push(sql);
    }

    if (sqlBlocks.length > 0) {
      const date = new Date().toISOString().split('T')[0];
      console.log('\n\n' + '='.repeat(72));
      console.log('-- Migration SQL — paste into a new migration file');
      console.log('-- in liftoff-platform-backend/migrations/');
      console.log('='.repeat(72) + '\n');
      console.log(`-- Migration: seed tool classifications for registry connectors`);
      console.log(`-- Generated: ${date}`);
      console.log(`-- Connectors: ${pending.join(', ')}\n`);
      for (const block of sqlBlocks) {
        console.log(block);
        console.log('');
      }
    }
    return;
  }

  // --connector mode
  const connectorType = values['connector'];
  if (!connectorType) {
    console.error(
      'Error: --connector <type> is required (or use --list-unclassified / --backfill-all)',
    );
    process.exit(1);
  }

  const connectorDef = CONNECTORS[connectorType];
  if (!connectorDef) {
    console.error(
      `Error: Connector "${connectorType}" not found in CONNECTORS catalog.\n` +
        'Run --list-unclassified to see available MCP connectors.',
    );
    process.exit(1);
  }

  let tools: MCPTool[];
  const classifyOpts: ClassifyOptions = { dryRun: values['dry-run']! };

  if (values['from-inventory']) {
    // ── Inventory mode: the a priori path, from a harvested public inventory ─
    const invPath = path.resolve(values['from-inventory']);
    if (!existsSync(invPath)) {
      console.error(`Error: inventory file not found: ${invPath}`);
      process.exit(1);
    }
    const inventory = JSON.parse(readFileSync(invPath, 'utf8')) as VendorToolInventory;
    if (inventory.connectorType !== connectorType) {
      console.error(
        `Error: inventory is for "${inventory.connectorType}", not "${connectorType}".`,
      );
      process.exit(1);
    }
    tools = inventory.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
      ...(t.annotations ? { annotations: t.annotations } : {}),
      ...(t.httpMethod ? { httpMethod: t.httpMethod } : {}),
    }));
    if (tools.length === 0) {
      console.error(`Error: inventory for "${connectorType}" lists no tools.`);
      process.exit(1);
    }
    classifyOpts.inventory = {
      source: inventory.source,
      sourceUrl: inventory.sourceUrl,
      ...(inventory.operationKey ? { operationKey: inventory.operationKey } : {}),
    };
    console.log(`Using inventory ${path.relative(process.cwd(), invPath)}: ${tools.length} tools for "${connectorType}" (${inventory.source}, harvested ${inventory.harvestedAt})`);
    console.log('');
  } else if (values['from-registry']) {
    // ── Registry mode: get tools from static connector-functions-registry ────
    const registryFns = getConnectorFunctions(connectorType);
    if (registryFns.length === 0) {
      console.error(
        `Error: "${connectorType}" has no tools in the static registry.\n` +
        'Use --token <oauth_token> to classify from a live MCP server instead.',
      );
      process.exit(1);
    }

    tools = registryFns.map((fn) => ({
      name: fn.name,
      description: fn.description,
      inputSchema: fn.inputSchema as Record<string, unknown>,
      registryCategories: (fn.categories ?? []).map(String),
    }));
    classifyOpts.registrySource = 'src/catalog/connector-functions-registry.ts';

    console.log(`Using static registry: ${tools.length} tools for "${connectorType}"`);
    console.log('');
  } else {
    // ── Live MCP mode: connect to running MCP server with OAuth token ─────────
    if (!connectorDef.mcp) {
      console.error(
        `Error: Connector "${connectorType}" has no MCP config.\n` +
          'Only connectors with an "mcp" field can be classified this way.',
      );
      process.exit(1);
    }

    let mcpUrl: string;
    let transportType: 'streamable-http' | 'sse' | 'auto';

    if (values['mcp-url']) {
      mcpUrl = values['mcp-url'];
      transportType = 'auto';
    } else {
      const isSidecar = connectorDef.mcp.kind === 'sidecar';
      if (isSidecar && !process.env['MCP_SIDECAR_BASE_URL']) {
        console.error(
          `Error: "${connectorType}" is a sidecar connector and requires a running local sidecar.\n\n` +
            '  1. Set MCP_SIDECAR_BASE_URL to your local sidecar base URL, e.g.:\n' +
            '       export MCP_SIDECAR_BASE_URL=http://localhost:3100\n' +
            '  2. Start the sidecar locally (see docs/sidecars/ for instructions)\n' +
            `  3. Retry: npm run classify:tools -- --connector ${connectorType} --token <token>\n\n` +
            'Or pass --mcp-url <url> to override the URL directly.',
        );
        process.exit(1);
      }

      const resolved = resolveMCPConfig(connectorType);
      if (!resolved) {
        console.error(
          `Error: Could not resolve MCP URL for "${connectorType}". ` +
            'Try passing --mcp-url <url>.',
        );
        process.exit(1);
      }
      mcpUrl = resolved.mcpUrl;
      transportType = resolved.transport;
    }

    const bearerToken = values['token'];

    console.log(`Connecting to MCP server for "${connectorType}"...`);
    console.log(`  URL: ${mcpUrl}`);
    console.log(`  Transport: ${transportType}`);
    console.log('');

    try {
      const { transport } = await createTransport({
        endpointUrl: mcpUrl,
        authType: bearerToken ? 'bearer_token' : 'none',
        bearerToken: bearerToken,
        transportType,
      });

      const result = await transport.request<{ tools?: MCPTool[] }>('tools/list');
      transport.close();
      tools = result.tools ?? [];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `Error: Failed to connect to MCP server.\n  ${msg}\n\n` +
          'Troubleshooting:\n' +
          '  - Check that the token is valid and not expired\n' +
          '  - For sidecar connectors, ensure the sidecar is running\n' +
          '  - For vendor-hosted connectors, check that the MCP URL is reachable\n' +
          '  - Use --mcp-url <url> to override the URL directly.',
      );
      process.exit(1);
    }

    if (tools.length === 0) {
      console.error(
        `No tools returned by the MCP server for "${connectorType}". ` +
          'Verify the token has the necessary scopes.',
      );
      process.exit(1);
    }

    console.log(`Found ${tools.length} tools. Classifying via the platform-backend classifier route...\n`);
  }

  const sql = await classifyConnector(connectorType, tools, pbUrl!, serviceToken!, classifyOpts);

  if (sql) {
    console.log('');
    console.log(sql);
    console.log('');
    console.log(
      '-- Paste the SQL above into a new migration file in liftoff-platform-backend/migrations/',
    );
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
