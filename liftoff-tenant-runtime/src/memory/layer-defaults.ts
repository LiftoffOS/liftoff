// src/memory/layer-defaults.ts
// Resolves default memory layers based on tenant strategy. Every caller of
// retrieveMemories goes through this when layers are unset. Per-agent
// memory_scope.readableLayers (when explicit non-empty) overrides strategy.

import type { MemoryLayer } from './types';

export type LayerStrategy = 'all' | 'narrow_with_peer';

export interface ResolveOptions {
  strategy: LayerStrategy;
  hasThread: boolean;
}

export interface ResolvedLayers {
  layers: MemoryLayer[];
  includePeerLearning: boolean;
}

export function resolveDefaultLayers(opts: ResolveOptions): ResolvedLayers {
  if (opts.strategy === 'all') {
    return {
      layers: opts.hasThread
        ? ['global', 'role', 'individual', 'conversation']
        : ['global', 'role', 'individual'],
      includePeerLearning: false,
    };
  }
  return {
    layers: opts.hasThread ? ['individual', 'conversation'] : ['individual'],
    includePeerLearning: true,
  };
}
