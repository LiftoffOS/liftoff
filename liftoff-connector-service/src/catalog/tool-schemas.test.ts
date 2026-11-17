// Unit tests for catalog/tool-schemas.ts.
//
// Covers:
//   - Version hash is stable across calls and matches sha1 shape.
//   - cachedVersion match → unchanged short-circuit, empty toolSets.
//   - connectorTypes filter restricts output.
//   - Write vs read categorisation (registry-supplied + heuristic).
//   - Tool name prefix is the connector type.

import { createHash } from 'node:crypto';
import {
  listTools,
  getRegistryVersion,
  __resetToolSchemaCache,
} from './tool-schemas.js';
import { ClassificationSource } from '@liftoffos/proto-gen/liftoff/connector/v1/connector_service_pb.js';

describe('catalog/tool-schemas', () => {
  // Warm the cache ONCE. Building + hashing every tool set (incl. the large generated
  // native HRIS surfaces) is a heavy one-time cost; the version is deterministic, so a
  // per-test reset would just rebuild it repeatedly. Tests here read the warm cache.
  beforeAll(() => {
    __resetToolSchemaCache();
    getRegistryVersion();
  }, 120000);

  it('returns a stable 16-char hex version hash', () => {
    const v1 = getRegistryVersion();
    const v2 = getRegistryVersion();
    expect(v1).toBe(v2);
    expect(v1).toMatch(/^[a-f0-9]{16}$/);
  });

  it('returns non-empty toolSets by default', () => {
    const res = listTools({});
    expect(res.unchanged).toBe(false);
    expect(res.version).toMatch(/^[a-f0-9]{16}$/);
    expect(res.toolSets.length).toBeGreaterThan(0);
    // Every tool set must have non-empty tools (we filter empties out).
    for (const set of res.toolSets) {
      expect(set.tools.length).toBeGreaterThan(0);
      expect(set.connectorType).toBeTruthy();
      expect(set.displayName).toBeTruthy();
    }
  });

  it('short-circuits when cachedVersion matches current version', () => {
    const fresh = listTools({});
    const cached = listTools({ cachedVersion: fresh.version });
    expect(cached.unchanged).toBe(true);
    expect(cached.toolSets).toEqual([]);
    expect(cached.version).toBe(fresh.version);
  });

  it('returns full payload when cachedVersion mismatches', () => {
    const res = listTools({ cachedVersion: 'stale-version-x' });
    expect(res.unchanged).toBe(false);
    expect(res.toolSets.length).toBeGreaterThan(0);
  });

  it('filters by connectorTypes', () => {
    const all = listTools({});
    const sample = all.toolSets.slice(0, 2).map((s) => s.connectorType);
    expect(sample.length).toBeGreaterThan(0);
    const res = listTools({ connectorTypes: sample });
    expect(res.toolSets.map((s) => s.connectorType).sort()).toEqual(
      [...sample].sort(),
    );
  });

  it('silently drops unknown connector types from the filter', () => {
    const res = listTools({ connectorTypes: ['not-a-real-connector-type'] });
    expect(res.toolSets).toEqual([]);
    expect(res.unchanged).toBe(false);
  });

  it('derives write category from the registry for mutation functions', () => {
    // microsoft_teams' send_message carries categories ['write', 'outbound']
    // in the registry — it must surface as isWrite=true. (Was google_mail
    // before that connector moved to composio_managed.)
    const res = listTools({ connectorTypes: ['microsoft_teams'] });
    const teamsSet = res.toolSets.find((s) => s.connectorType === 'microsoft_teams');
    expect(teamsSet).toBeDefined();
    const sendMessage = teamsSet!.tools.find(
      (t) => t.name === 'send_message',
    );
    expect(sendMessage).toBeDefined();
    expect(sendMessage!.isWrite).toBe(true);
    expect(sendMessage!.categories).toEqual(expect.arrayContaining(['write']));
  });

  it('marks read-only functions as non-write', () => {
    const res = listTools({ connectorTypes: ['microsoft_teams'] });
    const teamsSet = res.toolSets.find((s) => s.connectorType === 'microsoft_teams');
    const readChannel = teamsSet!.tools.find(
      (t) => t.name === 'read_channel',
    );
    expect(readChannel).toBeDefined();
    expect(readChannel!.isWrite).toBe(false);
    expect(readChannel!.categories).toEqual(expect.arrayContaining(['read']));
  });

  it('every tool name passes the LLM tool-name regex ^[a-zA-Z0-9_-]+$', () => {
    // Replaces the prior 'prefixes every tool name with its connector type'
    // assertion. The dotted prefix was removed because the dot
    // violated the LLM tool-name regex on the downstream tenant-runtime
    // `${alias}__${fn.name}` prefix path; the connectorType is already
    // carried separately on the ToolDefinition envelope so the prefix was
    // redundant + harmful. This invariant catches regressions: any new
    // registry entry whose name contains `.` / `/` / space will fail here.
    const llmRegex = /^[a-zA-Z0-9_-]+$/;
    const res = listTools({});
    for (const set of res.toolSets) {
      for (const tool of set.tools) {
        expect(tool.name).toMatch(llmRegex);
      }
    }
  });

  it('version hash equals sha1 of the fresh toolSets JSON (first 16 hex chars)', () => {
    const fresh = listTools({});
    const expected = createHash('sha1')
      .update(JSON.stringify(fresh.toolSets))
      .digest('hex')
      .slice(0, 16);
    expect(fresh.version).toBe(expected);
  });

  it('auto-generated history tools appear in listTools output for microsoft_teams', () => {
    const res = listTools({ connectorTypes: ['microsoft_teams'] });
    const teamsSet = res.toolSets.find((s) => s.connectorType === 'microsoft_teams');
    expect(teamsSet).toBeDefined();
    const names = teamsSet!.tools.map((t) => t.name);
    expect(names).toContain('read_thread');
    const readThread = teamsSet!.tools.find((t) => t.name === 'read_thread')!;
    expect(readThread.isWrite).toBe(false);
    expect(readThread.categories).toContain('read');
  });

  it('auto-generated history tools appear for linear and zendesk', () => {
    const res = listTools({ connectorTypes: ['linear', 'zendesk'] });
    const linearSet = res.toolSets.find((s) => s.connectorType === 'linear');
    const zendeskSet = res.toolSets.find((s) => s.connectorType === 'zendesk');
    expect(linearSet!.tools.map((t) => t.name)).toContain('read_comments');
    expect(zendeskSet!.tools.map((t) => t.name)).toContain('read_comments');
  });

  // Classification provenance — the governance Authorize decision trusts a
  // DECLARED read but not an INFERRED one (see AuthorizeRequest.action_read_class).
  it('marks registry-declared categories DECLARED (pdl enrich_company is a declared read)', () => {
    const res = listTools({ connectorTypes: ['pdl'] });
    const pdl = res.toolSets.find((s) => s.connectorType === 'pdl');
    expect(pdl).toBeDefined();
    const enrich = pdl!.tools.find((t) => t.name === 'enrich_company')!;
    expect(enrich).toBeDefined();
    expect(enrich.categories).toEqual(['read']);
    expect(enrich.classificationSource).toBe(ClassificationSource.DECLARED);
  });

  it('every tool carries a resolved classification source (never UNSPECIFIED)', () => {
    const res = listTools({});
    for (const set of res.toolSets) {
      for (const t of set.tools) {
        expect([ClassificationSource.DECLARED, ClassificationSource.INFERRED])
          .toContain(t.classificationSource);
      }
    }
  });
});
