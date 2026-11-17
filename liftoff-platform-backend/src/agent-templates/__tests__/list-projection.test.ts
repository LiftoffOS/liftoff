// Fitness function: the gallery projection never carries operative prompt text.
//
// The list route used to `res.json` whole template objects, so one visit to the
// Explore page shipped every template's `responsibilities` and
// `additionalContext` to the browser — the catalog's prompt corpus, in a
// response the client already pages to exhaustion, none of it rendered by a
// card. This test is the guard: the projection is a named allowlist, and a
// field added to the template schema must be added here deliberately rather
// than arriving on the wire because it exists.

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { agentTemplateZodSchema } from '../validator';
import { toTemplateCard } from '../router';

const CATALOG_DIR = path.join(__dirname, '..', 'catalog');

/** Fields that make an agent reproducible elsewhere. Never card fields. */
const WITHHELD = ['responsibilities', 'additionalContext'] as const;

/** Exactly what a gallery card may carry. */
const ALLOWED = [
  'id',
  'version',
  'schemaVersion',
  'displayName',
  'departmentCategory',
  'description',
  'role',
  'requiredConnectors',
  'optionalConnectors',
  'defaultAgentType',
].sort();

describe('agent-templates list projection', () => {
  const templates = fs.readdirSync(CATALOG_DIR)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map(f => {
      const parsed = yaml.load(fs.readFileSync(path.join(CATALOG_DIR, f), 'utf8'));
      return { name: f, template: agentTemplateZodSchema.parse(parsed) };
    });

  it('catalog is non-empty, so the assertions below are not vacuous', () => {
    expect(templates.length).toBeGreaterThan(0);
  });

  it.each(templates.map(t => [t.name, t.template] as const))(
    '%s: card withholds the operative body',
    (_name, template) => {
      const card = toTemplateCard(template) as Record<string, unknown>;
      for (const field of WITHHELD) {
        expect(card).not.toHaveProperty(field);
      }
    },
  );

  it.each(templates.map(t => [t.name, t.template] as const))(
    '%s: card exposes only allowlisted fields',
    (_name, template) => {
      expect(Object.keys(toTemplateCard(template)).sort()).toEqual(ALLOWED);
    },
  );

  it('the source templates really do carry the withheld fields', () => {
    // Guards against the projection passing because the catalog stopped
    // populating these, which would make every assertion above trivially true.
    for (const { template } of templates) {
      for (const field of WITHHELD) {
        expect(typeof template[field]).toBe('string');
        expect((template[field] as string).length).toBeGreaterThan(0);
      }
    }
  });
});
