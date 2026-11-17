// The API schema must accept every field the canonical WorkflowStep declares.
//
// WHY THIS EXISTS. `workflowStepSchema` in router.ts was written by hand as a
// subset of the canonical shape in @liftoffos/shared-types, and drifted. It did
// not declare `type`, `question`, `delay` or `semanticValidation`. zod strips
// undeclared keys by default, so steps arrived correct from the distiller —
// which REQUIRES `type` on every variant and validates it — and were silently
// stripped before persistence.
//
// The cost is not a rejected request. It is an agent carrying steps whose
// `created` audit row shows none of them with a `type` key, and a runtime that
// treats a step with no type and no toolName as a no-op: the workflow walks its
// graph, executes nothing, and reports success.
//
// A test comparing key sets would have failed the day `type` was added to the
// canonical interface. That is the only durable fix — patching four names today
// does nothing about the fifth field somebody adds next quarter.
//
// The interface is read from source rather than reflected, because a TypeScript
// interface does not exist at runtime. Parsing it is unusual, and it is the
// price of having the check at all.

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

/** Field names declared on an interface in the shared-types source. */
function interfaceKeys(source: string, name: string): string[] {
  const start = source.indexOf(`export interface ${name} {`);
  if (start === -1) throw new Error(`interface ${name} not found in shared-types`);
  const body = source.slice(start, source.indexOf('\n}', start));
  const keys = new Set<string>();
  for (const line of body.split('\n')) {
    // `  fieldName?: Type;` — ignore comments, nested braces and the header.
    const m = /^\s{2}([a-zA-Z][a-zA-Z0-9]*)\??\s*:/.exec(line);
    if (m) keys.add(m[1]);
  }
  return [...keys].sort();
}

function zodKeys(schema: z.ZodTypeAny): string[] {
  const shape = (schema as unknown as { _def: { shape?: () => Record<string, unknown> } })
    ._def.shape?.();
  if (!shape) throw new Error('expected a ZodObject');
  return Object.keys(shape).sort();
}

const SHARED_TYPES = fs.readFileSync(
  path.join(__dirname, '../../../packages/shared-types/src/workflow.ts'),
  'utf8',
);

describe('workflow step schema parity with the canonical type', () => {
  it('declares every field the canonical WorkflowStep has', async () => {
    const { __workflowStepSchemaForTest } = await import('../router');
    const canonical = interfaceKeys(SHARED_TYPES, 'WorkflowStep');
    const declared = zodKeys(__workflowStepSchemaForTest);

    const missing = canonical.filter((k) => !declared.includes(k));
    // Each name here is a field the distiller may emit and this API would
    // silently delete.
    expect(missing).toEqual([]);
  });

  it('declares every field the canonical delay shape has', async () => {
    const { __workflowStepDelaySchemaForTest } = await import('../router');
    const canonical = interfaceKeys(SHARED_TYPES, 'WorkflowDelayStep');
    const missing = canonical.filter((k) => !zodKeys(__workflowStepDelaySchemaForTest).includes(k));
    expect(missing).toEqual([]);
  });

  it('rejects an unknown field instead of deleting it', async () => {
    // The behaviour that turned a schema gap into a silent data loss. Strict
    // makes the next omission a 400 somebody sees rather than a field that
    // evaporates between the client and the database.
    const { __workflowStepSchemaForTest } = await import('../router');
    const result = __workflowStepSchemaForTest.safeParse({
      stepId: 's1',
      description: 'd',
      type: 'llm_reason',
      aFieldNobodyDeclared: 'x',
    });
    expect(result.success).toBe(false);
  });

  it('accepts the shapes the distiller actually emits', async () => {
    const { __workflowStepSchemaForTest } = await import('../router');
    const shapes = [
      { stepId: 's1', description: 'd', type: 'llm_reason' },
      { stepId: 's2', description: 'd', type: 'tool_call', toolName: 'slack__send_message' },
      { stepId: 's3', description: 'd', type: 'ask_user', question: 'which repo?' },
      { stepId: 's4', description: 'd', type: 'delay', delay: { durationSeconds: 300 } },
    ];
    for (const shape of shapes) {
      const r = __workflowStepSchemaForTest.safeParse(shape);
      expect(r.success ? null : r.error.issues).toBeNull();
    }
  });

  it('keeps type through a parse, which is the whole point', async () => {
    const { __workflowStepSchemaForTest } = await import('../router');
    const parsed = __workflowStepSchemaForTest.parse({
      stepId: 's1', description: 'd', type: 'llm_reason',
    }) as { type?: string };
    expect(parsed.type).toBe('llm_reason');
  });
});
