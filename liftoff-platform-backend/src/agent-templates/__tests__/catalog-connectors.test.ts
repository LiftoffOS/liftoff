// Cross-validation tests:
//   - Every {{variable}} in roleVariables appears in responsibilities or additionalContext
//   - responsibilities and additionalContext sections are non-empty
//   - No duplicate template ids in catalog

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { agentTemplateZodSchema } from '../validator';
import type { AgentTemplate } from '../schema';

const CATALOG_DIR = path.join(__dirname, '..', 'catalog');

function loadAllTemplates(): Array<{ template: AgentTemplate; filename: string }> {
  const yamlFiles = fs.readdirSync(CATALOG_DIR)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map(f => path.join(CATALOG_DIR, f));

  const results: Array<{ template: AgentTemplate; filename: string }> = [];
  for (const filePath of yamlFiles) {
    const filename = path.basename(filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    const raw = yaml.load(content);
    const parsed = agentTemplateZodSchema.safeParse(raw);
    if (parsed.success) {
      results.push({ template: parsed.data as AgentTemplate, filename });
    }
  }
  return results;
}

const allTemplates = loadAllTemplates();

describe('Agent Template Catalog — cross-validation', () => {
  it('has no duplicate template ids', () => {
    const ids = allTemplates.map(({ template }) => template.id);
    const unique = new Set(ids);
    if (unique.size !== ids.length) {
      const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
      throw new Error(`Duplicate template ids found: ${duplicates.join(', ')}`);
    }
    expect(unique.size).toBe(ids.length);
  });

  describe.each(allTemplates.map(({ template, filename }) => [filename, template]) as [string, AgentTemplate][])(
    'template: %s',
    (_filename, template) => {
      it('every roleVariable name appears in responsibilities or additionalContext as {{name}}', () => {
        const combinedText = `${template.responsibilities}\n${template.additionalContext}`;

        // roleVariables is optional; empty / absent ⇒ no variables to verify.
        for (const variable of template.roleVariables ?? []) {
          const placeholder = `{{${variable.name}}}`;
          if (!combinedText.includes(placeholder)) {
            throw new Error(
              `Template "${template.id}": roleVariable "${variable.name}" does not appear as ` +
              `"{{${variable.name}}}" in responsibilities or additionalContext`,
            );
          }
        }
        expect(true).toBe(true);
      });

      it('responsibilities section is non-empty', () => {
        expect(template.responsibilities.trim().length).toBeGreaterThan(0);
      });

      it('additionalContext section is non-empty', () => {
        expect(template.additionalContext.trim().length).toBeGreaterThan(0);
      });

      it('requiredConnectors ids are unique within the template', () => {
        const reqIds = template.requiredConnectors.map(c => c.id);
        const optIds = template.optionalConnectors.map(c => c.id);
        const allIds = [...reqIds, ...optIds];
        const uniqueIds = new Set(allIds);
        expect(uniqueIds.size).toBe(allIds.length);
      });
    },
  );
});
