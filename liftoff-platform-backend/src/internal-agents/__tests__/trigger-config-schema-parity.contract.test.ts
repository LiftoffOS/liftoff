// The API's trigger schema must accept every field the distiller emits.
//
// A trigger is more than its primary schedule. The distiller's produce_agent
// tool emits companion crons, reactive subscriptions, a timezone and its
// reasoning on one object, and the runtime schedules off every one of those
// fields. Neither create surface lets a person edit the trigger, so the object
// the browser posts is the distiller's own — and zod strips whatever the API
// schema does not declare. While the schema declared only `type`, `cronExpr`
// and `eventTopic`, every companion cron a wizard hire was designed with was
// dropped between the artifact and the row, with nothing anywhere saying so.
//
// Same shape as the workflow-step parity test, for the same reason: patching
// the missing names today does nothing about the field somebody adds to the
// distiller's schema next quarter. The check is over key sets.

import { z } from 'zod';

function zodKeys(schema: z.ZodTypeAny): string[] {
  const shape = (schema as unknown as { _def: { shape?: () => Record<string, unknown> } })
    ._def.shape?.();
  if (!shape) throw new Error('expected a ZodObject');
  return Object.keys(shape).sort();
}

/** A trigger of the shape a distillation produces for a template hire: a
 *  Monday sweep with a Thursday companion. Without parity, the row it creates
 *  carries only `type` and `cronExpr`. */
const DISTILLED_TRIGGER = {
  type: 'cron',
  cronExpr: '0 8 * * 1',
  reasoning: 'The core responsibility is an explicitly periodic artifact.',
  companionCrons: [{
    label: 'midweek-material-move-check',
    cronExpr: '0 8 * * 4',
    timezone: 'Europe/London',
    objective: 'Run a light mid-week check for MATERIAL moves only. If nothing material is found, reply with exactly [SILENT].',
  }],
};

describe('trigger config schema parity with the distiller', () => {
  it('declares every top-level field the distiller may emit', async () => {
    const { __triggerConfigSchemaForTest } = await import('../router');
    const { __internalGetTriggerConfigSchema } = await import('../distill-service');
    const emitted = Object.keys(__internalGetTriggerConfigSchema().properties ?? {}).sort();
    const declared = zodKeys(__triggerConfigSchemaForTest);

    const missing = emitted.filter((k) => !declared.includes(k));
    expect(missing).toEqual([]);
  });

  it('declares every companion-cron and subscription field the distiller may emit', async () => {
    const { __triggerConfigSchemaForTest } = await import('../router');
    const { __internalGetTriggerConfigSchema } = await import('../distill-service');
    const props = __internalGetTriggerConfigSchema().properties as Record<string, { items?: { properties?: Record<string, unknown> } }>;
    const shape = (__triggerConfigSchemaForTest as unknown as { _def: { shape: () => Record<string, z.ZodTypeAny> } })._def.shape();

    for (const list of ['companionCrons', 'reactiveSubscriptions'] as const) {
      const emitted = Object.keys(props[list].items?.properties ?? {}).sort();
      const element = (shape[list] as z.ZodOptional<z.ZodArray<z.ZodTypeAny>>)._def.innerType._def.type;
      const declared = zodKeys(element);
      expect(emitted.filter((k) => !declared.includes(k))).toEqual([]);
    }
  });

  it('a distilled trigger survives the boundary whole', async () => {
    const { __triggerConfigSchemaForTest } = await import('../router');
    const parsed = __triggerConfigSchemaForTest.parse(DISTILLED_TRIGGER);
    expect(parsed).toEqual(DISTILLED_TRIGGER);
  });

  it('a trigger carrying a timezone and companions with no artifact at all is kept too', async () => {
    // Nothing about keeping the companions depends on a distill handle: the
    // request body is the contract and it is persisted whole.
    const { __triggerConfigSchemaForTest } = await import('../router');
    const parsed = __triggerConfigSchemaForTest.parse({
      type: 'cron', cronExpr: '0 9 * * *', timezone: 'America/Los_Angeles',
      companionCrons: [{ label: 'weekly-pipeline-report', cronExpr: '0 9 * * 1' }],
    });
    expect(parsed.timezone).toBe('America/Los_Angeles');
    expect(parsed.companionCrons).toHaveLength(1);
  });
});
