// A memory scope stored in one spelling and read in another is no scope at all.
//
// `agents.memory_scope` here is a verbatim copy of the control plane's column,
// whose create path wrote the default in snake_case while every reader on both
// sides is camelCase. `ctx.memoryScope.writableLayers` therefore read undefined
// and the handlers fell back to hard-coded lists, so memory scoping was never
// enforced as configured for any agent created through the hire flow — only
// agents seeded by another path were readable.
//
// The tell on an affected database: `SELECT layer, count(*) FROM memories`
// returns `individual` and `global` and nothing else — no `role` rows.

import { normalizeMemoryScope, DEFAULT_MEMORY_SCOPE } from '../scope';

describe('normalizeMemoryScope reads either spelling', () => {
  it('reads the shape the control plane stores', () => {
    expect(normalizeMemoryScope({
      readable_layers: ['global', 'individual'],
      writable_layers: ['individual'],
    })).toEqual({
      readableLayers: ['global', 'individual'],
      writableLayers: ['individual'],
    });
  });

  it('reads the shape the types always claimed', () => {
    expect(normalizeMemoryScope({
      readableLayers: ['role'], writableLayers: ['role'],
    })).toEqual({ readableLayers: ['role'], writableLayers: ['role'] });
  });

  it('reads it from a JSON string, as the driver may hand it over', () => {
    expect(normalizeMemoryScope('{"writable_layers":["role"]}'))
      .toEqual({ writableLayers: ['role'] });
  });

  it('prefers camelCase when a row carries both, mid-migration', () => {
    expect(normalizeMemoryScope({
      writableLayers: ['role'], writable_layers: ['individual'],
    })).toEqual({ writableLayers: ['role'] });
  });

  it('carries scope keys across under either spelling', () => {
    expect(normalizeMemoryScope({ scope_keys: ['team-a'] })).toEqual({ scopeKeys: ['team-a'] });
    expect(normalizeMemoryScope({ scopeKeys: ['team-a'] })).toEqual({ scopeKeys: ['team-a'] });
  });

  // A typo must not read as a grant.
  it('drops a layer that does not exist', () => {
    expect(normalizeMemoryScope({ writable_layers: ['individual', 'rôle', 'ROLE'] }))
      .toEqual({ writableLayers: ['individual'] });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string that is not JSON', 'not json'],
    ['an array', ['role']],
    ['a number', 7],
  ])('returns an empty scope for %s, so the handler applies its own default', (_l, raw) => {
    expect(normalizeMemoryScope(raw)).toEqual({});
  });

  it('omits a key rather than inventing an empty list for it', () => {
    expect(normalizeMemoryScope({ writable_layers: ['individual'] }))
      .not.toHaveProperty('readableLayers');
  });
});

// The disagreement that made one dead step look like none.
describe('the default is ONE list, and it agrees with itself about role', () => {
  it('does not let an unscoped agent read a layer it cannot write', () => {
    const readOnly = DEFAULT_MEMORY_SCOPE.readableLayers
      .filter((l) => !DEFAULT_MEMORY_SCOPE.writableLayers.includes(l));
    // `global` is legitimately read-only. `role` must not be: a graph that reads
    // back what it believes it saved is the shape this whole defect took.
    expect(readOnly).not.toContain('role');
  });

  it('grants role on neither side, because a template grants it explicitly', () => {
    expect(DEFAULT_MEMORY_SCOPE.readableLayers).not.toContain('role');
    expect(DEFAULT_MEMORY_SCOPE.writableLayers).not.toContain('role');
  });
});

describe('every handler and read site uses them', () => {
  const read = (rel: string) =>
    require('fs').readFileSync(require('path').join(__dirname, '..', '..', rel), 'utf8');

  it('the tool handler has one default, not three', () => {
    const src = read('tools/standard-tool-handler.ts');
    // The three literals that used to sit here and disagree.
    expect(src).not.toContain("|| ['individual', 'conversation']");
    expect(src).not.toContain("|| ['global', 'role', 'individual', 'conversation']");
    expect(src).not.toContain("|| ['individual']");
    expect((src.match(/DEFAULT_MEMORY_SCOPE\.(readable|writable)Layers/g) ?? []).length).toBe(3);
  });

  it.each([
    ['agent-execution/service.ts'],
    ['interactive-chat/chat-turn-handler.ts'],
    ['interactive-chat/tool-proxy-router.ts'],
    ['agent-lifecycle/repository.ts'],
  ])('%s normalises rather than parsing raw', (rel) => {
    const src = read(rel);
    expect(src).toContain('normalizeMemoryScope(');
    // The parse-and-hope this replaces.
    expect(src).not.toMatch(/memory_scope === 'string'\s*\n?\s*\?\s*JSON\.parse\(row\.memory_scope\)/);
  });
});
