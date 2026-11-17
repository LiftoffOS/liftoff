// A refinement that does not reach a prompt is not a refinement.
//
// The reflection loop wrote `agents.user_instructions` and read it back from the
// same place, so it round-tripped perfectly, bumped a version and wrote an audit
// record — while every prompt path loaded
// `compiled_instructions.user_instructions` for the ACTIVE version and never saw
// any of it. These pin the write to both rows, and pin apply and revert to the
// same writer so they cannot drift apart again.

import { writeAgentInstructions } from '../suggestion-applier';

function fakePool() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    query: jest.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rowCount: /compiled_instructions/.test(sql) ? 1 : 1 };
    }),
  };
}

const INPUT = {
  agentId: 'a1',
  tenantId: 't1',
  userInstructions: 'do the refined thing',
  entityVersion: 7,
};

describe('writing an agent instruction', () => {
  it('writes the row every prompt actually reads', async () => {
    const pool = fakePool();
    await writeAgentInstructions(pool, INPUT);

    const compiled = pool.calls.find((c) => /compiled_instructions/.test(c.sql));
    expect(compiled).toBeDefined();
    expect(compiled!.params).toContain('do the refined thing');
  });

  it('still writes the row the loop reads back from', async () => {
    // The reflection loop re-reads `agents` to compute the next revision, so
    // dropping this write would break the loop in the other direction.
    const pool = fakePool();
    await writeAgentInstructions(pool, INPUT);
    expect(pool.calls.some((c) => /UPDATE agents/.test(c.sql))).toBe(true);
  });

  it('targets only the ACTIVE compiled instruction', async () => {
    // A superseded or draft row is not what a prompt loads. Writing one would
    // reproduce exactly the silence this fixes, somewhere new.
    const pool = fakePool();
    await writeAgentInstructions(pool, INPUT);
    const compiled = pool.calls.find((c) => /compiled_instructions/.test(c.sql))!;
    expect(compiled.sql).toMatch(/status\s*=\s*'active'/);
  });

  it('reports whether a prompt-visible row was actually updated', async () => {
    // The caller must be able to say "this reached nothing" rather than assume
    // it landed. An agent with no active compiled instruction cannot execute,
    // so a refinement for it is silent by definition.
    const pool = fakePool();
    pool.query.mockImplementation(async (sql: string) => ({
      rowCount: /compiled_instructions/.test(sql) ? 0 : 1,
    }));
    await expect(writeAgentInstructions(pool, INPUT)).resolves.toEqual({ compiledUpdated: false });
  });

  it('carries a null through, so a revert to "no instructions" is expressible', async () => {
    const pool = fakePool();
    await writeAgentInstructions(pool, { ...INPUT, userInstructions: null });
    for (const c of pool.calls) expect(c.params[0]).toBeNull();
  });
});
