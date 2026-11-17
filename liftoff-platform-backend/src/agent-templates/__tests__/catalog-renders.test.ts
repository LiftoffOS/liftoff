// Tests: always-on templates have correct structure for the new role/responsibilities/additionalContext schema.
// Verifies:
//   - role is short (max 60 chars)
//   - responsibilities contains all 5 required sections
//   - additionalContext contains all 4 required sections

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { agentTemplateZodSchema } from '../validator';
import type { AgentTemplate } from '../schema';

const CATALOG_DIR = path.join(__dirname, '..', 'catalog');

const RESPONSIBILITIES_REQUIRED_SECTIONS = [
  '## Responsibilities',
  '## Goals',
  '## Workflows',
  '## Instructions',
  '## Outcomes',
] as const;

const ADDITIONAL_CONTEXT_REQUIRED_SECTIONS = [
  '## Rules',
  '## Constraints',
  '## Edge cases',
  '## Anything to avoid',
] as const;

/** Remove Markdown backtick-fenced segments (inline `code` and triple-fenced
 *  ```code blocks```) before running the {{var}} regex. Templates that
 *  illustrate someone else's placeholder syntax (e.g. Google Slides'
 *  `{{QUARTER}}`) put it in backticks; those literals shouldn't be treated
 *  as live roleVariable references. */
function stripBacktickFences(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ');
}

// Only always-on templates (no pendingConnectors)
function getAlwaysOnTemplates(): AgentTemplate[] {
  const yamlFiles = fs.readdirSync(CATALOG_DIR)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map(f => path.join(CATALOG_DIR, f));

  const templates: AgentTemplate[] = [];
  for (const filePath of yamlFiles) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const raw = yaml.load(content);
    const result = agentTemplateZodSchema.safeParse(raw);
    if (result.success && !result.data.pendingConnectors) {
      templates.push(result.data as AgentTemplate);
    }
  }
  return templates;
}

describe('Agent Template Catalog — render tests (always-on templates)', () => {
  const alwaysOnTemplates = getAlwaysOnTemplates();

  it('there are always-on templates in the catalog', () => {
    expect(alwaysOnTemplates.length).toBeGreaterThan(0);
  });

  // Templates that intentionally use a single-section domain structure
  // rather than the canonical 5-section pattern. These follow the
  // {practice}-associate style (one "## <Deliverable>" section under
  // responsibilities) and are exempt from the strict-5 + strict-4 checks
  // below. Listed explicitly so adding a new template can't accidentally
  // bypass the structure rules.
  const SINGLE_SECTION_TEMPLATE_IDS = new Set([
    'cp-checklist-analyst',
    'credit-agreement-memo-writer',
    'shareholder-agreement-memo-writer',
  ]);

  describe.each(alwaysOnTemplates.map(t => [t.id, t]) as [string, AgentTemplate][])(
    'template: %s',
    (id, template) => {
      const isSingleSection = SINGLE_SECTION_TEMPLATE_IDS.has(id);

      it('role is short (max 60 characters)', () => {
        expect(template.role.length).toBeLessThanOrEqual(60);
        expect(template.role.length).toBeGreaterThan(0);
      });

      it('responsibilities contains all 5 required sections', () => {
        if (isSingleSection) {
          // Single-section templates: assert at least one ## heading + sane length.
          expect(template.responsibilities).toMatch(/^\s*##\s/m);
          expect(template.responsibilities.trim().length).toBeGreaterThan(100);
          return;
        }
        for (const section of RESPONSIBILITIES_REQUIRED_SECTIONS) {
          if (!template.responsibilities.includes(section)) {
            throw new Error(
              `Template "${template.id}": responsibilities is missing section "${section}"`,
            );
          }
          expect(template.responsibilities).toContain(section);
        }
      });

      it('additionalContext contains all 4 required sections', () => {
        // Single-section templates carry the universal Rules/Constraints/
        // Edge-cases/Anything-to-avoid in additionalContext too, so the
        // strict-4 contract still applies — only the strict-5
        // responsibilities check above relaxes for them.
        for (const section of ADDITIONAL_CONTEXT_REQUIRED_SECTIONS) {
          if (!template.additionalContext.includes(section)) {
            throw new Error(
              `Template "${template.id}": additionalContext is missing section "${section}"`,
            );
          }
          expect(template.additionalContext).toContain(section);
        }
      });

      it('responsibilities is a non-empty string', () => {
        expect(typeof template.responsibilities).toBe('string');
        expect(template.responsibilities.trim().length).toBeGreaterThan(100);
      });

      it('additionalContext is a non-empty string', () => {
        expect(typeof template.additionalContext).toBe('string');
        expect(template.additionalContext.trim().length).toBeGreaterThan(50);
      });

      it('responsibilities contains no unresolved {{variable}} placeholders for declared variables', () => {
        // A bare {{id}} in responsibilities is an input answered at hire, so
        // the template must declare it under `inputs`. Backtick-fenced
        // segments are descriptive examples (e.g. a template describing Google
        // Slides' own placeholder syntax) and must not be treated as live
        // template variables — strip them first.
        const stripped = stripBacktickFences(template.responsibilities);
        const varMatches = [...stripped.matchAll(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g)];
        // `inputs` is optional; absence means "no declared inputs", in which
        // case any {{var}} in the body is undeclared.
        const declaredVarNames = new Set((template.inputs ?? []).map(i => i.id));

        for (const match of varMatches) {
          const varName = match[1];
          if (!declaredVarNames.has(varName)) {
            throw new Error(
              `Template "${template.id}": variable "{{${varName}}}" in responsibilities ` +
              `is not declared in inputs`,
            );
          }
        }
        expect(true).toBe(true);
      });

      it('additionalContext contains no undeclared {{variable}} placeholders', () => {
        const stripped = stripBacktickFences(template.additionalContext);
        const varMatches = [...stripped.matchAll(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g)];
        const declaredVarNames = new Set((template.inputs ?? []).map(i => i.id));

        for (const match of varMatches) {
          const varName = match[1];
          if (!declaredVarNames.has(varName)) {
            throw new Error(
              `Template "${template.id}": variable "{{${varName}}}" in additionalContext ` +
              `is not declared in inputs`,
            );
          }
        }
        expect(true).toBe(true);
      });
    },
  );
});
