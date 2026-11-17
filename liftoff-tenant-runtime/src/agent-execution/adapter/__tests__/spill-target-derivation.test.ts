// B3 — the spill has to be reachable.
//
// A spill branch that waits on a `spillTarget` no adapter sets is unreachable,
// and every oversized result is truncated instead. This does not thread a sandbox handle down here; it reads a capability the run
// already advertises — a file-capable agent carries `file_write` in the same
// catalog the tool call just dispatched through.
//
// These assert the derivation, which is what makes the difference between a
// live feature and dead code.

import { deriveSpillTargetForTest } from '../mcp-bridge';

type Catalog = Parameters<typeof deriveSpillTargetForTest>[0];

function catalogWith(names: string[]): Catalog {
  return {
    servers: [],
    tools: names.map((name) => ({
      name,
      inputSchema: {},
      serverId: 'liftoff-tool-gateway',
    })),
  } as unknown as Catalog;
}

describe('deriving a spill target', () => {
  it('produces a writer when the run has file_write', () => {
    const target = deriveSpillTargetForTest(
      catalogWith(['file_read', 'file_write', 'shell_exec']),
      { callTool: async () => ({}) },
    );
    expect(target).not.toBeNull();
  });

  it('produces nothing for a connector-only agent', () => {
    // No filesystem to spill to — truncation is the correct fallback, not a
    // failure.
    const target = deriveSpillTargetForTest(
      catalogWith(['gmail_send', 'slack_send_message']),
      { callTool: async () => ({}) },
    );
    expect(target).toBeNull();
  });

  it('writes through the same client the tool call used', async () => {
    const callTool = jest.fn(async () => ({}));
    const target = deriveSpillTargetForTest(catalogWith(['file_write']), { callTool });

    await target!.writeFile('/tmp/results/abc.txt', 'a very long result');

    expect(callTool.mock.calls[0][0]).toEqual({
      name: 'file_write',
      arguments: { path: '/tmp/results/abc.txt', content: 'a very long result' },
    });
  });

  it('surfaces a write failure so the caller falls back to the bound', async () => {
    const target = deriveSpillTargetForTest(catalogWith(['file_write']), {
      callTool: async () => { throw new Error('sandbox gone'); },
    });
    // spillToolText catches this and returns null, which is what makes the
    // truncation fallback happen rather than losing the result entirely.
    await expect(target!.writeFile('/p', 'c')).rejects.toThrow('sandbox gone');
  });
});
