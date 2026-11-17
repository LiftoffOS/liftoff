// A deployment's own Composio ids must beat the ones baked into the catalogue.
//
// The failure this guards is quiet: with the baked ids, a different
// organisation's Composio key cannot see them, so every managed connector
// refuses to start its OAuth flow and the catalogue silently shrinks to the
// api_key and self-registering entries.

import fs from 'fs';
import {
  composioAuthConfigId,
  composioMcpServerId,
  _resetComposioResourceCache,
} from '../composio-resources';

const BAKED = { dev: 'ac_baked_dev', prod: 'ac_baked_prod' };
const BAKED_MCP = { dev: 'mcp-baked-dev', prod: 'mcp-baked-prod' };

function withResourceFile(contents: unknown | null) {
  _resetComposioResourceCache();
  jest.spyOn(fs, 'readFileSync').mockImplementation(((p: string) => {
    if (String(p).endsWith('composio-resources.json')) {
      if (contents === null) throw new Error('ENOENT');
      return JSON.stringify(contents);
    }
    return '';
  }) as unknown as typeof fs.readFileSync);
}

afterEach(() => {
  jest.restoreAllMocks();
  _resetComposioResourceCache();
});

describe('composio resource resolution', () => {
  it('falls back to the baked id when no resource file exists', () => {
    // The normal state before a deployment runs the bootstrap.
    withResourceFile(null);
    expect(composioAuthConfigId('slack', BAKED, 'prod')).toBe('ac_baked_prod');
    expect(composioMcpServerId('slack', BAKED_MCP, 'dev')).toBe('mcp-baked-dev');
  });

  it('prefers a bare string from the resource file over the baked id', () => {
    // A deployment has ONE Composio organisation, so the bootstrap's output is
    // a single id rather than a dev/prod pair.
    withResourceFile({ toolkits: { slack: { toolkitSlug: 'slack', authConfigIds: 'ac_mine' } } });
    expect(composioAuthConfigId('slack', BAKED, 'prod')).toBe('ac_mine');
  });

  it('prefers a keyed entry, so an existing two-environment file still works', () => {
    withResourceFile({
      toolkits: { slack: { toolkitSlug: 'slack', authConfigIds: { dev: 'ac_mine_dev', prod: 'ac_mine_prod' } } },
    });
    expect(composioAuthConfigId('slack', BAKED, 'prod')).toBe('ac_mine_prod');
    expect(composioAuthConfigId('slack', BAKED, 'dev')).toBe('ac_mine_dev');
  });

  it('ignores a placeholder in the resource file and keeps the baked id', () => {
    // The bootstrap writes `<from-phase-0>`-style placeholders for a toolkit it
    // has not provisioned. Treating one as resolved would turn "not set up yet"
    // into a connector that offers to connect and then fails.
    withResourceFile({ toolkits: { slack: { toolkitSlug: 'slack', authConfigIds: '<unprovisioned>' } } });
    expect(composioAuthConfigId('slack', BAKED, 'prod')).toBe('ac_baked_prod');
  });

  it('falls back for a toolkit the file does not mention', () => {
    withResourceFile({ toolkits: { notion: { toolkitSlug: 'notion', authConfigIds: 'ac_notion' } } });
    expect(composioAuthConfigId('slack', BAKED, 'prod')).toBe('ac_baked_prod');
  });

  it('returns undefined when neither source has one', () => {
    withResourceFile(null);
    expect(composioAuthConfigId('slack', undefined, 'prod')).toBeUndefined();
  });

  it('survives an unparseable resource file', () => {
    // Crashing a request path over a malformed config would be worse than
    // using the baked ids, which a placeholder check already reports as
    // not-functional where it matters.
    _resetComposioResourceCache();
    jest.spyOn(fs, 'readFileSync').mockReturnValue('{not json' as unknown as string);
    expect(composioAuthConfigId('slack', BAKED, 'prod')).toBe('ac_baked_prod');
  });
});
