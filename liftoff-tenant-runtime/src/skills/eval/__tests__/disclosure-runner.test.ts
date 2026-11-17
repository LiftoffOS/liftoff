// The runner's own logic — the part that decides what a number means. The
// arithmetic here is where a measurement quietly becomes a wrong claim, so it is
// tested against the deployed harness being a stub.

const query = jest.fn();
jest.mock('../../../infrastructure/database', () => ({
  getPoolForService: () => ({ query }),
}));
jest.mock('../../../memory/embedding', () => ({
  generateEmbeddingDetailed: jest.fn().mockResolvedValue({
    embedding: [0.1, 0.2], model: 'test-embed', provider: 'google', dim: 2,
  }),
}));
// google-auth-library reaches for the metadata server on construction.
jest.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getIdTokenClient(): Promise<{ getRequestHeaders: () => Promise<Record<string, string>> }> {
      return Promise.resolve({ getRequestHeaders: async () => ({ authorization: 'Bearer test' }) });
    }
  },
}));

import { runDisclosureEval, seedEvalSkills, renderReport } from '../disclosure-runner';
import { DISCLOSURE_EVAL_TASKS } from '../disclosure-tasks';

const TENANT = '11111111-1111-4111-8111-111111111111';
const INTERNAL_AGENT = '22222222-2222-4222-8222-222222222222';
const RUNTIME_AGENT = '33333333-3333-4333-8333-333333333333';

/** A harness reply. `answer` is what the agent said; `read` names a skill id it
 *  fetched first. */
function reply(answer: string, read?: string, retrieved?: string[]): Response {
  return {
    ok: true,
    json: async () => ({
      ok: true,
      finalText: answer,
      toolCalls: read ? [{ toolName: 'read_skill', args: { id: read } }] : [],
      exposedToolNames: read !== undefined ? ['read_skill'] : [],
      // Default: retrieval surfaced every eval skill, which is the arrangement a
      // dedicated eval agent produces. Pass an explicit list to simulate a miss.
      retrievedSkillIds: retrieved ?? DISCLOSURE_EVAL_TASKS.map((t) => t.skill.id),
      inputTokens: 100,
      outputTokens: 20,
      outcome: 'success',
    }),
  } as unknown as Response;
}

/** Answer that satisfies every assertion on a task — built from the task so it
 *  stays right as the set grows. */
function perfectAnswer(taskIndex: number): string {
  const t = DISCLOSURE_EVAL_TASKS[taskIndex];
  return [...t.skillEvidence, ...t.substantive].join(' ') || 'ok';
}

const config = {
  tenantId: TENANT,
  internalAgentId: INTERNAL_AGENT,
  runtimeAgentId: RUNTIME_AGENT,
  harnessUrl: 'https://agent-service.example/api/internal/test-harness/run-agent',
  maxTurns: 6,
};

describe('seeding', () => {
  beforeEach(() => query.mockReset());

  it('reports rows the database wrote, not statements it sent', async () => {
    // A tally of calls says ten when ten statements wrote nothing. This is the
    // difference between "seeded" and "ran ten inserts".
    query.mockResolvedValue({ rowCount: 1 });
    expect(await seedEvalSkills(TENANT, RUNTIME_AGENT)).toBe(DISCLOSURE_EVAL_TASKS.length);

    query.mockReset();
    query.mockResolvedValue({ rowCount: 0 });
    expect(await seedEvalSkills(TENANT, RUNTIME_AGENT)).toBe(0);
  });

  it('writes the model that actually produced the vector', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    await seedEvalSkills(TENANT, RUNTIME_AGENT);
    expect(query.mock.calls[0][1]).toContain('test-embed');
  });
});

describe('the run', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rowCount: 1, rows: [{ agent_id: RUNTIME_AGENT }] });
  });

  afterEach(() => {
    (global.fetch as unknown as jest.Mock | undefined)?.mockReset?.();
  });

  it('runs every task both ways', async () => {
    global.fetch = jest.fn(async () => reply('nothing useful')) as unknown as typeof fetch;
    const report = await runDisclosureEval(config);

    expect(report.results).toHaveLength(DISCLOSURE_EVAL_TASKS.length * 2);
    expect(report.results.filter((r) => r.mode === 'inline')).toHaveLength(DISCLOSURE_EVAL_TASKS.length);
    expect(report.results.filter((r) => r.mode === 'disclosed')).toHaveLength(DISCLOSURE_EVAL_TASKS.length);
  });

  it('does not count a task the inline arm failed', async () => {
    // THE result that would otherwise be a wrong claim. Task 0 fails in BOTH
    // arms; its disclosed failure is not evidence that disclosure cost
    // anything, because the guidance did not land when handed over in full.
    let call = 0;
    global.fetch = jest.fn(async () => {
      // Order is task-major: [t0 inline, t0 disclosed, t1 inline, t1 disclosed, …]
      const taskIndex = Math.floor(call / 2);
      const answer = taskIndex === 0 ? 'unrelated' : perfectAnswer(taskIndex);
      call++;
      return reply(answer, DISCLOSURE_EVAL_TASKS[taskIndex].skill.id);
    }) as unknown as typeof fetch;

    const report = await runDisclosureEval(config);
    expect(report.summary.brokenTasks).toEqual([DISCLOSURE_EVAL_TASKS[0].id]);
    // Excluded, not merely annotated: with 10 tasks, counting it would report
    // 90% and blame the mode for a broken task.
    expect(report.summary.disclosedPassRate).toBe(1);
    expect(report.summary.failedWithoutReading).toEqual([]);
    expect(report.summary.failedAfterReading).toEqual([]);
  });

  it('separates a disclosed failure that read from one that did not', async () => {
    // These are different defects and the report must not merge them: one is
    // the cost of disclosure, the other is a comprehension problem that reading
    // more would not fix.
    let call = 0;
    global.fetch = jest.fn(async () => {
      const taskIndex = Math.floor(call / 2);
      const isDisclosed = call % 2 === 1;
      call++;
      if (!isDisclosed) return reply(perfectAnswer(taskIndex));
      if (taskIndex === 0) return reply('wrong', DISCLOSURE_EVAL_TASKS[0].skill.id); // read, still wrong
      if (taskIndex === 1) return reply('wrong');                                    // never read
      return reply(perfectAnswer(taskIndex), DISCLOSURE_EVAL_TASKS[taskIndex].skill.id);
    }) as unknown as typeof fetch;

    const report = await runDisclosureEval(config);
    expect(report.summary.brokenTasks).toEqual([]);
    expect(report.summary.failedAfterReading).toEqual([DISCLOSURE_EVAL_TASKS[0].id]);
    expect(report.summary.failedWithoutReading).toEqual([DISCLOSURE_EVAL_TASKS[1].id]);
  });

  it('notices when read_skill was never in the catalog', async () => {
    // A disclosed arm without the tool did not run in disclosed mode at all. It
    // would score like the inline arm and read as "disclosure is free", which is
    // the most expensive wrong conclusion this eval could produce.
    global.fetch = jest.fn(async () => reply('nothing useful')) as unknown as typeof fetch;
    const report = await runDisclosureEval(config);
    const disclosed = report.results.filter((r) => r.mode === 'disclosed');
    expect(disclosed.every((r) => r.readSkillExposed === false)).toBe(true);
    expect(renderReport(report)).toContain('READ_SKILL NOT EXPOSED');
  });

  it('records a read of the WRONG skill as a read of another skill', async () => {
    // Fetching some other task's guidance is a retrieval problem, not evidence
    // the agent consulted what it needed.
    global.fetch = jest.fn(async () =>
      reply('nothing useful', DISCLOSURE_EVAL_TASKS[9].skill.id)) as unknown as typeof fetch;
    const report = await runDisclosureEval(config);
    const first = report.results.find((r) => r.taskId === DISCLOSURE_EVAL_TASKS[0].id && r.mode === 'disclosed');
    expect(first?.readSkillCalls).toBe(1);
    expect(first?.readItsOwnSkill).toBe(false);
    expect(renderReport(report)).toContain('| other |');
  });

  it('separates "the model ignored it" from "it was never retrieved"', async () => {
    // Opposite findings. A task whose skill retrieval never surfaced was not
    // asked the question in EITHER arm, so it is not a broken task and not
    // evidence about the mode — and reading it as a broken task sends somebody
    // to rewrite a task when the embedding is what missed.
    const missing = DISCLOSURE_EVAL_TASKS[0].skill.id;
    const retrievedWithoutFirst = DISCLOSURE_EVAL_TASKS
      .map((t) => t.skill.id)
      .filter((id) => id !== missing);

    let call = 0;
    global.fetch = jest.fn(async () => {
      const taskIndex = Math.floor(call / 2);
      call++;
      // Task 0's own skill is absent from what retrieval returned, so it fails.
      if (taskIndex === 0) return reply('unrelated', undefined, retrievedWithoutFirst);
      return reply(perfectAnswer(taskIndex));
    }) as unknown as typeof fetch;

    const report = await runDisclosureEval(config);
    expect(report.summary.skillNeverRetrieved).toEqual([DISCLOSURE_EVAL_TASKS[0].id]);
    // Not counted as a broken task, and not dragging either rate down.
    expect(report.summary.brokenTasks).toEqual([]);
    expect(report.summary.inlinePassRate).toBe(1);
    expect(report.summary.disclosedPassRate).toBe(1);
    expect(renderReport(report)).toContain('Skill never retrieved');
  });

  it('turns a harness error into a failed arm, not a crashed run', async () => {
    // Nine good measurements and one HTTP 500 is nine measurements. Throwing
    // would discard them and the whole run would have to start over.
    global.fetch = jest.fn(async () => ({
      ok: false, status: 503, text: async () => 'upstream unavailable',
    }) as unknown as Response) as unknown as typeof fetch;

    const report = await runDisclosureEval(config);
    expect(report.results.every((r) => r.verdict.pass === false)).toBe(true);
    expect(report.results[0].error).toContain('503');
    expect(report.summary.inlinePassRate).toBe(0);
    // Every inline arm failed, so no disclosed arm is measurable. Reporting 0
    // here would say "disclosure destroyed the pass rate" about a run in which
    // disclosure was never tested — opposite findings, so they cannot share a
    // value.
    expect(report.summary.disclosedPassRate).toBeNull();
    expect(renderReport(report)).toContain('not measurable');
  });

  it('resolves the runtime agent id rather than assuming the internal one', async () => {
    global.fetch = jest.fn(async () => reply('x')) as unknown as typeof fetch;
    await runDisclosureEval({ ...config, runtimeAgentId: undefined });
    const mappingCall = query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('internal_agent_runtime_mapping'),
    );
    expect(mappingCall).toBeDefined();
    expect(mappingCall?.[1]).toEqual([INTERNAL_AGENT, TENANT]);
  });

  it('refuses to run when the agent has no runtime mapping', async () => {
    // The id-space trap: a wrong-space id matches zero rows with no error, and
    // seeding would then write ten skills against an agent_id nothing executes.
    query.mockReset();
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    global.fetch = jest.fn(async () => reply('x')) as unknown as typeof fetch;
    await expect(runDisclosureEval({ ...config, runtimeAgentId: undefined }))
      .rejects.toThrow(/no runtime agent mapped/);
  });
});
