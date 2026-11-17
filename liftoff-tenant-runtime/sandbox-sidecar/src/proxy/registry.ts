import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';

interface MappingRecord {
  id: string;
  pattern: string;
  upstream: string;
}

interface ExcludeRecord {
  id: string;
  pattern: string;
}

interface ProxyConfig {
  mappings: MappingRecord[];
  excludes: ExcludeRecord[];
  upstream: string | null;
}

const CONFIG_PATH = '/workspace/.proxy/config.json';

export class ProxyRegistry {
  private mappings = new Map<string, { pattern: RegExp; upstream: string; raw: string }>();
  private excludes = new Map<string, { pattern: RegExp; raw: string }>();
  private upstream: string | null = null;

  async load(): Promise<void> {
    try {
      const text = await fs.readFile(CONFIG_PATH, 'utf-8');
      const cfg = JSON.parse(text) as ProxyConfig;
      for (const m of cfg.mappings) this.mappings.set(m.id, { pattern: new RegExp(m.pattern), upstream: m.upstream, raw: m.pattern });
      for (const e of cfg.excludes) this.excludes.set(e.id, { pattern: new RegExp(e.pattern), raw: e.pattern });
      this.upstream = cfg.upstream;
    } catch {
      // no config yet
    }
  }

  async save(): Promise<void> {
    await fs.mkdir('/workspace/.proxy', { recursive: true });
    const cfg: ProxyConfig = {
      mappings: Array.from(this.mappings.entries()).map(([id, m]) => ({ id, pattern: m.raw, upstream: m.upstream })),
      excludes: Array.from(this.excludes.entries()).map(([id, e]) => ({ id, pattern: e.raw })),
      upstream: this.upstream,
    };
    await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  }

  async addMapping(pattern: string, upstream: string): Promise<{ mappingId: string }> {
    const id = randomUUID();
    this.mappings.set(id, { pattern: new RegExp(pattern), upstream, raw: pattern });
    await this.save();
    return { mappingId: id };
  }

  async removeMapping(id: string): Promise<void> {
    this.mappings.delete(id);
    await this.save();
  }

  listMappings(): Array<{ id: string; pattern: string; upstream: string }> {
    return Array.from(this.mappings.entries()).map(([id, m]) => ({ id, pattern: m.raw, upstream: m.upstream }));
  }

  async addExclude(pattern: string): Promise<{ excludeId: string }> {
    const id = randomUUID();
    this.excludes.set(id, { pattern: new RegExp(pattern), raw: pattern });
    await this.save();
    return { excludeId: id };
  }

  async removeExclude(id: string): Promise<void> {
    this.excludes.delete(id);
    await this.save();
  }

  listExcludes(): Array<{ id: string; pattern: string }> {
    return Array.from(this.excludes.entries()).map(([id, e]) => ({ id, pattern: e.raw }));
  }

  async setUpstream(upstream: string | null): Promise<void> {
    this.upstream = upstream;
    await this.save();
  }

  getUpstream(): string | null {
    return this.upstream;
  }

  resolveTarget(reqUrl: string): string | 'BLOCK' | null {
    for (const exclude of this.excludes.values()) {
      if (exclude.pattern.test(reqUrl)) return null;
    }
    for (const mapping of this.mappings.values()) {
      if (mapping.pattern.test(reqUrl)) return mapping.upstream;
    }
    return this.upstream;
  }
}

export const proxyRegistry = new ProxyRegistry();
