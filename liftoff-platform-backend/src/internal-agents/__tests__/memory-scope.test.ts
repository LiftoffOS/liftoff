// The scope was written in a spelling nothing reads, and the hire path did not
// write the template's scope at all.
//
// Every type, schema and reader in both repositories is camelCase. The create
// path wrote the default in snake_case, and `parseJsonb` hands valid JSON
// straight back — so its camelCase fallback never fired and the wrong shape
// travelled on cast as `MemoryScope`, through the create event, into the tenant
// runtime's own column, where `ctx.memoryScope.writableLayers` read undefined.
//
// Separately, templates grant `role` to the hires whose work spans runs, and
// only team-provisioning ever passed `defaultMemoryScope` to create. So the
// distiller authored `memory_save` against a layer its own template had
// granted, and the agent was never given it.

import { normalizeMemoryScope, DEFAULT_MEMORY_SCOPE } from '../memory-scope';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('normalizeMemoryScope', () => {
  it('reads the shape the create path actually wrote', () => {
    expect(normalizeMemoryScope({
      readable_layers: ['global', 'individual'],
      writable_layers: ['individual'],
    })).toEqual({
      readableLayers: ['global', 'individual'],
      writableLayers: ['individual'],
    });
  });

  it('reads the shape a template declares', () => {
    expect(normalizeMemoryScope({ readableLayers: ['role'], writableLayers: ['role'] }))
      .toEqual({ readableLayers: ['role'], writableLayers: ['role'] });
  });

  it('reads it from a JSON string', () => {
    expect(normalizeMemoryScope('{"writable_layers":["role"]}'))
      .toEqual({ writableLayers: ['role'] });
  });

  it('prefers camelCase when a row carries both, mid-migration', () => {
    expect(normalizeMemoryScope({ writableLayers: ['role'], writable_layers: ['individual'] }))
      .toEqual({ writableLayers: ['role'] });
  });

  it.each([
    ['null', null],
    ['a non-JSON string', 'nope'],
    ['an array', ['role']],
    ['an object naming none of the keys', { colour: 'blue' }],
  ])('falls back to the default for %s', (_l, raw) => {
    expect(normalizeMemoryScope(raw)).toEqual(DEFAULT_MEMORY_SCOPE);
  });

  it('returns a copy, so a caller cannot mutate the shared default', () => {
    const a = normalizeMemoryScope(null);
    a.writableLayers!.push('role');
    expect(DEFAULT_MEMORY_SCOPE.writableLayers).not.toContain('role');
  });
});

describe('the default', () => {
  it('is camelCase, which is the only spelling anything reads', () => {
    expect(Object.keys(DEFAULT_MEMORY_SCOPE).sort()).toEqual(['readableLayers', 'writableLayers']);
  });

  it('does not hand out role, which is a template grant', () => {
    expect(DEFAULT_MEMORY_SCOPE.readableLayers).not.toContain('role');
    expect(DEFAULT_MEMORY_SCOPE.writableLayers).not.toContain('role');
  });
});

describe('the writers and readers agree', () => {
  const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

  it('create writes the shared constant, not a snake_case literal', () => {
    const s = src('service.ts');
    expect(s).toContain('JSON.stringify(input.memoryScope ?? DEFAULT_MEMORY_SCOPE)');
    expect(s).not.toContain("readable_layers: ['global', 'individual']");
  });

  it('the row mapper normalises rather than casting', () => {
    const s = src('row-mapper.ts');
    expect(s).toContain('normalizeMemoryScope(row.memory_scope)');
    expect(s).not.toContain('parseJsonb<MemoryScope>');
  });

  it('the hire path passes the template scope it used to drop', () => {
    expect(src('provisioning-helper.ts')).toContain('memoryScope: distillOutput.memoryScope');
  });

  it('the distiller carries the template scope out to the caller', () => {
    const s = src('distill-service.ts');
    expect(s).toContain('templateMemoryScope = tmpl.defaultMemoryScope');
    expect(s).toContain('{ memoryScope: templateMemoryScope }');
  });
});
