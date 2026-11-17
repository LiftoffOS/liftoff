// Agent Templates — fail-safe YAML loader
// Reads every YAML file from src/agent-templates/catalog/ at process startup.
//
// Fail-safe behavior (BE-008):
//   - Schema-fatal violations (wrong type, missing required field): throw — crash boot
//   - Templates with unbuilt required connectors: mark disabled, continue boot
//   - Other non-fatal issues: log structured error, mark disabled, continue boot
//
// Connector availability is derived automatically from FUNCTIONAL_CONNECTOR_TYPES —
// no manual flag in YAML required. Add a connector type to that set when its
// implementation ships and affected templates will automatically become active.
//
// See loader-failsafe.test.ts for behavioral spec.

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { log } from '../infrastructure/logging';
import { agentTemplateZodSchema } from './validator';
import { FUNCTIONAL_CONNECTOR_TYPES } from './connector-availability';
import { capabilitiesForRequirement, connectorTypesForRequirement } from './connector-capabilities';
import type { AgentTemplate } from './schema';

// ── State ──────────────────────────────────────────────────────────────────

const templates = new Map<string, AgentTemplate>();
const disabledTemplates = new Map<string, string>(); // id → reason

let initialized = false;

// ── Catalog directory ──────────────────────────────────────────────────────

// __dirname works in compiled JS (dist/agent-templates/loader.js); resolve upward
// to src/agent-templates/catalog at runtime by going up two dirs from dist.
// In tests (ts-jest executes from src), resolve relative to __dirname directly.
function getCatalogDir(): string {
  // In ts-jest: __dirname = .../src/agent-templates
  // In compiled: __dirname = .../dist/agent-templates
  const candidate1 = path.join(__dirname, 'catalog');
  if (fs.existsSync(candidate1)) return candidate1;

  // Fallback: one level up then into src/agent-templates/catalog
  const candidate2 = path.join(__dirname, '..', '..', 'src', 'agent-templates', 'catalog');
  if (fs.existsSync(candidate2)) return candidate2;

  throw new Error(
    `Agent template catalog directory not found. Tried:\n  ${candidate1}\n  ${candidate2}`,
  );
}

// ── Loader ─────────────────────────────────────────────────────────────────

/**
 * Initializes the template loader. Called once at app startup (src/index.ts).
 * Idempotent — subsequent calls are no-ops.
 *
 * Schema-fatal files throw immediately (crashing boot).
 * Non-fatal files (pendingConnectors=true, semantic issues) are disabled.
 */
export function initTemplateLoader(catalogDirOverride?: string): void {
  if (initialized) return;

  const catalogDir = catalogDirOverride ?? getCatalogDir();

  let yamlFiles: string[];
  try {
    yamlFiles = fs.readdirSync(catalogDir)
      .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
      .map(f => path.join(catalogDir, f));
  } catch (err) {
    throw new Error(
      `Failed to read agent template catalog directory "${catalogDir}": ${(err as Error).message}`,
    );
  }

  for (const filePath of yamlFiles) {
    const filename = path.basename(filePath);

    let raw: unknown;
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      raw = yaml.load(content);
    } catch (err) {
      // YAML parse error is schema-fatal — the file is corrupt, which is a code issue.
      throw new Error(
        `Schema-fatal YAML parse error in template file "${filename}": ${(err as Error).message}`,
      );
    }

    const parseResult = agentTemplateZodSchema.safeParse(raw);

    if (!parseResult.success) {
      const issues = parseResult.error.issues;

      // If the Zod issues include structural/type errors, that's schema drift → crash.
      // Fatal codes: wrong type, wrong union, unrecognized keys, invalid literal at root fields.
      // These indicate code/schema drift (not just a semantic content issue) and must crash boot.
      const FATAL_CODES = new Set([
        'invalid_type',
        'unrecognized_keys',
        'invalid_union',
        'invalid_literal',
        'invalid_enum_value',
      ]);
      const hasFatalIssue = issues.some(
        i => FATAL_CODES.has(i.code) && i.path.length <= 1,
      );

      if (hasFatalIssue) {
        const detail = issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
        throw new Error(
          `Schema-fatal validation error in template "${filename}":\n${detail}`,
        );
      }

      // Non-fatal: log and disable
      const reason = issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      const templateId = (raw as Record<string, unknown>)?.id as string | undefined ?? filename;

      log.error(
        { templateId, filename, issues: parseResult.error.issues },
        'Agent template failed non-fatal validation — disabling template',
      );

      disabledTemplates.set(templateId, `Validation errors: ${reason}`);
      continue;
    }

    const template = parseResult.data as AgentTemplate;

    // Auto-disable templates whose required connectors aren't fully built yet.
    // Derived from FUNCTIONAL_CONNECTOR_TYPES — no manual flag in YAML needed.
    //
    // For capability-based requirements: satisfied if at least one connector type
    // in the capability list is functional (the customer can pick whichever they use).
    // A requirement naming several capabilities is satisfied by any type under
    // any of them, which is what connectorTypesForRequirement unions.
    const unbuiltConnectors = template.requiredConnectors
      .filter(c => !connectorTypesForRequirement(c).some(
        t => FUNCTIONAL_CONNECTOR_TYPES.has(t),
      ))
      .map(c => c.connectorType ?? `capability:${capabilitiesForRequirement(c).join('|')}`);

    if (unbuiltConnectors.length > 0) {
      log.info(
        { templateId: template.id, filename, unbuiltConnectors },
        'Agent template requires connectors that are not yet functional — marking disabled',
      );
      disabledTemplates.set(
        template.id,
        `Template requires connectors not yet implemented: ${unbuiltConnectors.join(', ')}`,
      );
      // Still store in templates map so getTemplate() returns it (for admin/internal use),
      // but isTemplateDisabled will return true.
      templates.set(template.id, template);
      continue;
    }

    templates.set(template.id, template);
  }

  initialized = true;

  log.info(
    {
      total: templates.size,
      active: templates.size - disabledTemplates.size,
      disabled: disabledTemplates.size,
    },
    'Agent template loader initialized',
  );
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Returns all templates (active + disabled). */
export function getAllTemplates(): AgentTemplate[] {
  return [...templates.values()];
}

/** Returns all active (non-disabled) templates. */
export function getActiveTemplates(): AgentTemplate[] {
  return [...templates.values()].filter(t => !disabledTemplates.has(t.id));
}

/** Returns a single template by id, or undefined if not found. */
export function getTemplate(id: string): AgentTemplate | undefined {
  return templates.get(id);
}

/**
 * Returns a single template by id if its version matches the requested version.
 * If the template exists but the version does not match, logs a warning and returns null.
 * Returns null if the template is not found at all.
 */
export function getTemplateAtVersion(id: string, version: string): AgentTemplate | null {
  const template = templates.get(id);
  if (!template) return null;

  if (template.version !== version) {
    log.warn(
      { templateId: id, requestedVersion: version, currentVersion: template.version },
      `Template ${id} version ${version} not available, current is ${template.version}`,
    );
    return null;
  }

  return template;
}

/** Returns true if the template is disabled (pendingConnectors or validation failure). */
export function isTemplateDisabled(id: string): boolean {
  return disabledTemplates.has(id);
}

/** Returns the reason a template was disabled, or undefined if it's active. */
export function getDisabledReason(id: string): string | undefined {
  return disabledTemplates.get(id);
}

/**
 * Resets loader state — for use in tests only.
 * @internal
 */
export function _resetLoaderForTesting(): void {
  templates.clear();
  disabledTemplates.clear();
  initialized = false;
}
