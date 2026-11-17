// Change A: layer-defaults resolver.

import { resolveDefaultLayers } from '../layer-defaults';

describe('resolveDefaultLayers', () => {
  it('strategy=all + thread returns 4 layers, no peer-learning', () => {
    const r = resolveDefaultLayers({ strategy: 'all', hasThread: true });
    expect(r.layers.sort()).toEqual(['conversation', 'global', 'individual', 'role'].sort());
    expect(r.includePeerLearning).toBe(false);
  });

  it('strategy=all + no thread returns 3 layers (no conversation)', () => {
    const r = resolveDefaultLayers({ strategy: 'all', hasThread: false });
    expect(r.layers.sort()).toEqual(['global', 'individual', 'role'].sort());
    expect(r.includePeerLearning).toBe(false);
  });

  it('strategy=narrow_with_peer + thread = individual+conversation + peer', () => {
    const r = resolveDefaultLayers({ strategy: 'narrow_with_peer', hasThread: true });
    expect(r.layers.sort()).toEqual(['conversation', 'individual'].sort());
    expect(r.includePeerLearning).toBe(true);
  });

  it('strategy=narrow_with_peer + no thread = individual + peer', () => {
    const r = resolveDefaultLayers({ strategy: 'narrow_with_peer', hasThread: false });
    expect(r.layers).toEqual(['individual']);
    expect(r.includePeerLearning).toBe(true);
  });
});
