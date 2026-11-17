// WS-2.5 — catalog/handler symmetry tests.
import { STANDARD_TOOLS } from '../standard-tools';
import { executeStandardTool, StandardToolContext } from '../standard-tool-handler';

function makeMinimalCtx(): StandardToolContext {
  return {
    tenantId: '00000000-0000-0000-0000-000000000000',
    agentId: '00000000-0000-0000-0000-000000000000',
    memoryScope: { readableLayers: [], writableLayers: [] },
    traceId: 'symmetry-test',
  };
}

const EXTERNAL_DISPATCH = new Set(['delegate_to_agent', 'search']);
// B.1 — test-only tools never need a "live" handler in this symmetry
// sweep (they have one, but with a kill-switch gate). Excluding them keeps
// the symmetry test free of TEST_HARNESS_FAILTOOL-conditional plumbing.
const TEST_ONLY = new Set(['__fail_once__']);

describe('catalog/handler symmetry', () => {
  it.each(
    STANDARD_TOOLS
      .filter((t) => !EXTERNAL_DISPATCH.has(t.name) && !TEST_ONLY.has(t.name))
      .map((t) => [t.name] as [string])
  )('handler exists for %s', async (toolName: string) => {
    let result;
    try {
      result = await executeStandardTool(toolName, {}, makeMinimalCtx());
    } catch {
      // handler exists and threw → pass
      return;
    }
    expect(result).not.toBeNull();
  });

  // WS-2.5 negative: a tool advertised in STANDARD_TOOLS without a
  // matching case must make `assertStandardToolHandlersComplete` throw. We
  // monkey-patch the catalog with a synthetic name that we know
  // `executeStandardTool` does not handle, then verify the assertion fails.
  it('throws on missing handler at boot', async () => {
    const SYNTHETIC = '__symmetry_test_unhandled__';
    // Mutate the imported array in place so the boot check sees it. We
    // restore on teardown.
     
    (STANDARD_TOOLS as any).push({
      name: SYNTHETIC,
      description: 'synthetic — must never be invokable',
      input_schema: { type: 'object', properties: {}, required: [] },
    });
    try {
      const { assertStandardToolHandlersComplete } = await import('../handler-completeness');
      await expect(assertStandardToolHandlersComplete()).rejects.toThrow(
        /STANDARD_TOOLS catalog advertises tools with no handler/,
      );
    } finally {
      const i = (STANDARD_TOOLS as Array<{ name: string }>).findIndex((t) => t.name === SYNTHETIC);
      if (i >= 0) (STANDARD_TOOLS as Array<unknown>).splice(i, 1);
    }
  });

  // Confirm the assertion passes for the live catalog after the synthetic
  // entry has been removed.
  it('passes for the canonical catalog', async () => {
    const { assertStandardToolHandlersComplete } = await import('../handler-completeness');
    await expect(assertStandardToolHandlersComplete()).resolves.not.toThrow();
  });
});
