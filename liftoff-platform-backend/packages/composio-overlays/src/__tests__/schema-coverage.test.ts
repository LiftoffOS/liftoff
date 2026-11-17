// C1 tests: schema-file shape + per-toolkit non-empty assertions.

import { COMPOSIO_TOOL_SCHEMAS } from '../schemas';

describe('COMPOSIO_TOOL_SCHEMAS', () => {
  it('has at least one tool entry for every seeded toolkit', () => {
    expect(Object.keys(COMPOSIO_TOOL_SCHEMAS).length).toBeGreaterThan(0);
    for (const schemas of Object.values(COMPOSIO_TOOL_SCHEMAS)) {
      expect(schemas.length).toBeGreaterThanOrEqual(1);
      // Sanity per entry — every tool must have a non-empty slug + name.
      for (const s of schemas) {
        expect(typeof s.slug).toBe('string');
        expect(s.slug.length).toBeGreaterThan(0);
        expect(typeof s.name).toBe('string');
        expect(s.name.length).toBeGreaterThan(0);
        expect(s.inputSchema.type).toBe('object');
        expect(s.inputSchema.properties).toBeDefined();
        // Categories must be a non-empty array of valid labels.
        expect(s.categories.length).toBeGreaterThanOrEqual(1);
      }
      // No duplicate vendor slugs within a toolkit.
      const slugs = schemas.map((s) => s.slug);
      const dedup = new Set(slugs);
      expect(dedup.size).toBe(slugs.length);
    }
  });

  it('asserts no two toolkits share a vendor slug', () => {
    const seen = new Map<string, string>();
    for (const [toolkit, schemas] of Object.entries(COMPOSIO_TOOL_SCHEMAS)) {
      for (const s of schemas) {
        const prior = seen.get(s.slug);
        if (prior) {
          throw new Error(
            `vendor slug collision: '${s.slug}' appears in both '${prior}' and '${toolkit}'`,
          );
        }
        seen.set(s.slug, toolkit);
      }
    }
  });
});
