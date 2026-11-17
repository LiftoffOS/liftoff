// Tests: every YAML in catalog/ passes agentTemplateZodSchema

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { agentTemplateZodSchema } from '../validator';

const CATALOG_DIR = path.join(__dirname, '..', 'catalog');

describe('Agent Template Catalog — schema validation', () => {
  const yamlFiles = fs.readdirSync(CATALOG_DIR)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map(f => path.join(CATALOG_DIR, f));

  it('catalog directory has at least one template', () => {
    expect(yamlFiles.length).toBeGreaterThan(0);
  });

  it.each(yamlFiles)('%s passes agentTemplateZodSchema', (filePath) => {
    const _filename = path.basename(filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    const raw = yaml.load(content);

    const result = agentTemplateZodSchema.safeParse(raw);

    if (!result.success) {
      const issues = result.error.issues
        .map(i => `  ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      throw new Error(`Template "${_filename}" failed validation:\n${issues}`);
    }

    expect(result.success).toBe(true);
  });

  it('each template has a unique id', () => {
    const ids: string[] = [];
    for (const filePath of yamlFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const raw = yaml.load(content) as Record<string, unknown>;
      const id = raw?.id as string;
      expect(ids).not.toContain(id);
      ids.push(id);
    }
  });

  it('each template has required fields', () => {
    for (const filePath of yamlFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const raw = yaml.load(content) as Record<string, unknown>;

      expect(raw.id).toBeDefined();
      expect(raw.displayName).toBeDefined();
      expect(raw.departmentCategory).toBeDefined();
      expect(raw.schemaVersion).toBeDefined();

      // schemaVersion must be a positive integer
      expect(typeof raw.schemaVersion).toBe('number');
      expect(raw.schemaVersion as number).toBeGreaterThan(0);
    }
  });
});
