// The repair layer: our own generator's contract violations must not reach the
// person as a failed create, and must not be "fixed" by changing meaning.
//
// Pattern follows hermes-agent's `_repair_schema` (rewrites LLM output to satisfy
// the consumer's schema instead of failing) and openclaw's `normalization-core`
// (boundary coercion). The hard rule: repairs preserve intent, so nothing
// authored is shortened here.

import { normalizeDistillOutput } from '../distill-normalize';

jest.mock('../../infrastructure/logging', () => ({
  log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

describe('normalizeDistillOutput', () => {
  it('drops null on optional string fields, which is what broke team creation', () => {
    // zod's `.optional()` accepts undefined and REJECTS null. The distiller types
    // instructionsMd as `string | null`, so a create failed whenever no project
    // guide was produced.
    const out = normalizeDistillOutput({ instructionsMd: null, summary: 'ok' });

    expect('instructionsMd' in out).toBe(false);
    expect(out.summary).toBe('ok');
  });

  it('coerces a stringified number and boolean on a step', () => {
    const out = normalizeDistillOutput({
      workflowSteps: [
        { stepId: 's1', description: 'Fetch page 0', timeoutMs: '5000', requiresApproval: 'true' },
      ],
    });
    const step = (out.workflowSteps as Record<string, unknown>[])[0];

    expect(step.timeoutMs).toBe(5000);
    expect(step.requiresApproval).toBe(true);
  });

  it('mints a missing stepId rather than discarding the step', () => {
    const out = normalizeDistillOutput({
      workflowSteps: [{ description: 'Write rows to the sheet' }],
    });
    const steps = out.workflowSteps as Record<string, unknown>[];

    expect(steps).toHaveLength(1);
    expect(steps[0].stepId).toBe('step-1');
    expect(steps[0].description).toBe('Write rows to the sheet');
  });

  it('drops one unusable step instead of failing the whole array', () => {
    // Losing a malformed step leaves a workflow the runtime can still run;
    // rejecting the array costs the entire distillation.
    const out = normalizeDistillOutput({
      workflowSteps: [
        { stepId: 's1', description: 'Fetch page 0' },
        { stepId: 's2' },
        { stepId: 's3', description: 'Write rows' },
      ],
    });
    const steps = out.workflowSteps as Record<string, unknown>[];

    expect(steps.map(s => s.stepId)).toEqual(['s1', 's3']);
  });

  it('omits workflowSteps entirely when no step survives', () => {
    // The agent then runs the pure-LLM loop, which still has its full system
    // prompt, user instructions and skills.
    const out = normalizeDistillOutput({ workflowSteps: [{ stepId: 'x' }] });
    expect(out.workflowSteps).toBeUndefined();
  });

  it('never shortens an over-long description', () => {
    // Trimming would make the save succeed while changing what the agent does.
    // validateWorkflowSteps reports it so the model restates the objective.
    const long = 'x'.repeat(15_000);
    const out = normalizeDistillOutput({
      workflowSteps: [{ stepId: 's1', description: long }],
    });
    const step = (out.workflowSteps as Record<string, unknown>[])[0];

    expect(step.description).toBe(long);
    expect((step.description as string).length).toBe(15_000);
  });

  it('leaves a already-valid payload untouched', () => {
    const input = {
      summary: 'A campaign analyst',
      instructionsMd: '# Guide',
      workflowSteps: [{ stepId: 's1', description: 'Fetch page 0', timeoutMs: 5000 }],
    };
    const out = normalizeDistillOutput(input);

    expect(out.summary).toBe('A campaign analyst');
    expect(out.instructionsMd).toBe('# Guide');
    expect((out.workflowSteps as Record<string, unknown>[])[0]).toEqual({
      stepId: 's1',
      description: 'Fetch page 0',
      timeoutMs: 5000,
    });
  });

  it('does not mutate the caller\'s object', () => {
    const input = { instructionsMd: null, workflowSteps: [{ description: 'a' }] };
    normalizeDistillOutput(input);

    expect(input.instructionsMd).toBeNull();
  });

  it('removes a non-array workflowSteps rather than failing validation', () => {
    const out = normalizeDistillOutput({ workflowSteps: 'not an array' });
    expect('workflowSteps' in out).toBe(false);
  });

  // ── skills ────────────────────────────────────────────────────────────────
  //
  // The distiller emits six top-level fields. Repairing only some of them is the
  // harder bug to spot, because the create still fails — just on a different
  // field than the one that was fixed.

  describe('skills', () => {
    const validSkill = {
      name: 'Reviewing pull requests',
      description: 'Use when a pull request needs review.',
      instruction: 'Read the diff, then comment on correctness.',
    };

    it('drops a skill with no description instead of failing the array', () => {
      // description is the semantic retrieval key — a skill without one can never
      // be selected at runtime, so it has nothing to preserve.
      const out = normalizeDistillOutput({
        skills: [validSkill, { name: 'Nameless', instruction: 'do a thing' }],
      });

      expect(out.skills).toHaveLength(1);
      expect((out.skills as Record<string, unknown>[])[0].name).toBe('Reviewing pull requests');
    });

    it('coerces a stringified boolean on a skill', () => {
      const out = normalizeDistillOutput({
        skills: [{ ...validSkill, archived: 'false', protected: 'true' }],
      });
      const skill = (out.skills as Record<string, unknown>[])[0];

      expect(skill.archived).toBe(false);
      expect(skill.protected).toBe(true);
    });

    it('drops null keys on a skill', () => {
      const out = normalizeDistillOutput({ skills: [{ ...validSkill, id: null, tags: null }] });
      const skill = (out.skills as Record<string, unknown>[])[0];

      expect('id' in skill).toBe(false);
      expect('tags' in skill).toBe(false);
    });

    it('keeps the usable tags and drops the rest', () => {
      // A tag is a relevance hint; one malformed element must not cost the skill.
      const out = normalizeDistillOutput({
        skills: [{ ...validSkill, tags: ['connector:github', 42, null, '', 'type:write'] }],
      });
      const skill = (out.skills as Record<string, unknown>[])[0];

      expect(skill.tags).toEqual(['connector:github', '42', 'type:write']);
    });

    it('never shortens a skill instruction', () => {
      const long = 'i'.repeat(12_000);
      const out = normalizeDistillOutput({ skills: [{ ...validSkill, instruction: long }] });

      expect((out.skills as Record<string, unknown>[])[0].instruction).toBe(long);
    });

    it('removes a non-array skills value', () => {
      const out = normalizeDistillOutput({ skills: 'a skill' });
      expect('skills' in out).toBe(false);
    });
  });

  // ── triggerConfig ─────────────────────────────────────────────────────────

  describe('triggerConfig', () => {
    it('drops the null keys that zod rejects', () => {
      const out = normalizeDistillOutput({
        triggerConfig: { type: 'cron', cronExpr: '0 19 * * *', eventTopic: null },
      });
      const trigger = out.triggerConfig as Record<string, unknown>;

      expect('eventTopic' in trigger).toBe(false);
      expect(trigger.cronExpr).toBe('0 19 * * *');
    });

    it('does NOT invent a missing cron expression', () => {
      // Repairs preserve intent. A schedule the person never asked for is a
      // fabricated instruction, so this stays broken and the structural analyzer
      // feeds it back to the model.
      const out = normalizeDistillOutput({ triggerConfig: { type: 'cron' } });
      const trigger = out.triggerConfig as Record<string, unknown>;

      expect(trigger.type).toBe('cron');
      expect('cronExpr' in trigger).toBe(false);
    });

    it('removes a null or non-object triggerConfig', () => {
      expect('triggerConfig' in normalizeDistillOutput({ triggerConfig: null })).toBe(false);
      expect('triggerConfig' in normalizeDistillOutput({ triggerConfig: 'cron' })).toBe(false);
    });
  });

  // ── integrationConfigs ────────────────────────────────────────────────────

  describe('integrationConfigs', () => {
    it('drops null entries but leaves connector-specific shapes alone', () => {
      const out = normalizeDistillOutput({
        integrationConfigs: {
          google_sheets: { spreadsheetId: '1G833', tabName: 'Sheet1' },
          slack: null,
        },
      });
      const configs = out.integrationConfigs as Record<string, unknown>;

      expect('slack' in configs).toBe(false);
      expect(configs.google_sheets).toEqual({ spreadsheetId: '1G833', tabName: 'Sheet1' });
    });

    it('removes a non-object integrationConfigs', () => {
      expect('integrationConfigs' in normalizeDistillOutput({ integrationConfigs: [] })).toBe(false);
    });
  });

  it('repairs every field the distiller emits in one pass', () => {
    // The regression guard for the shape of the original defect: a payload broken
    // in six places must come back usable, not usable-in-four-places.
    const out = normalizeDistillOutput({
      summary: 'An analyst',
      systemPrompt: 'You are an analyst.',
      userInstructions: 'Run daily.',
      instructionsMd: null,
      workflowSteps: [{ description: 'Fetch page 0', timeoutMs: '5000' }],
      triggerConfig: { type: 'cron', cronExpr: '0 19 * * *', eventTopic: null },
      skills: [
        { name: 'Fetching campaigns', description: 'Use when fetching.', instruction: 'Call the API.', archived: 'false' },
        { name: 'Broken' },
      ],
      integrationConfigs: { google_sheets: { spreadsheetId: '1G833' }, slack: null },
    });

    expect('instructionsMd' in out).toBe(false);
    expect((out.workflowSteps as Record<string, unknown>[])[0]).toEqual({
      stepId: 'step-1',
      description: 'Fetch page 0',
      timeoutMs: 5000,
    });
    expect('eventTopic' in (out.triggerConfig as Record<string, unknown>)).toBe(false);
    expect(out.skills).toHaveLength(1);
    expect((out.skills as Record<string, unknown>[])[0].archived).toBe(false);
    expect('slack' in (out.integrationConfigs as Record<string, unknown>)).toBe(false);
  });
});
