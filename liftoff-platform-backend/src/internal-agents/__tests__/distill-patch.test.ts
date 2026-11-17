// The patch rung: edits to listed fields of a rejected graph, before the
// artifact is regenerated.
//
// Two halves. The module's own contract — what a rejection admits, what a
// returned edit must satisfy, what happens when it does not — with the LLM
// client mocked. Then the rung inside the distill loop: a converging patch
// ends the attempt with no large-tier regeneration; a non-converging one falls
// through to the correction turn holding the patched artifact; a thrown call,
// an over-budget prompt and a switched-off rung all take today's path.

jest.mock('../capability-specs-cache', () => ({
  readCachedCapabilitySpecs: jest.fn().mockResolvedValue(null),
  deriveCapabilitySpecsWithin: jest.fn().mockResolvedValue(null),
  SPEC_DERIVATION_WAIT_MS: 0,
}));
jest.mock('../../llm/client', () => ({ llmClient: { complete: jest.fn() } }));
jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: {
    getTenantManifests: jest.fn(),
    getToolCatalog: jest.fn(),
    getDataLandscape: jest.fn().mockResolvedValue(null),
  },
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../capability-discovery', () => ({
  discoverCapabilities: jest.fn().mockResolvedValue({ spec: {}, candidates: [], degraded: true }),
}));
jest.mock('../distill-cache', () => ({
  computePriorArtHash: jest.fn().mockReturnValue(''),
  computeCatalogHash: jest.fn().mockReturnValue('mock-catalog-hash'),
  computeFingerprint: jest.fn().mockReturnValue('mock-fingerprint'),
  getCachedDistillation: jest.fn().mockResolvedValue(null),
  setCachedDistillation: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../connectors/connector-service-client', () => ({
  getCatalog: jest.fn().mockResolvedValue({ connectors: [] }),
  resetCatalogCache: jest.fn(),
}));
jest.mock('../distill-run-recorder', () => {
  const actual = jest.requireActual('../distill-run-recorder');
  return { ...actual, recordDistillCall: jest.fn().mockResolvedValue(undefined) };
});

import {
  patchScopeFor,
  patchWorkflowSteps,
  buildPatchTool,
  PATCH_TOOL_NAME,
  PATCH_TIER,
  PATCH_MAX_TOKENS,
  PATCH_INPUT_BUDGET_CHARS,
  PATCH_INPUT_BUDGET_TOKENS,
  MAX_PATCHES_PER_ATTEMPT,
  isDistillPatchEnabled,
} from '../distill-patch';
import { distillInternalAgentWithProgress, type ValidationError, type ToolCatalog } from '../distill-service';
import { recordDistillCall } from '../distill-run-recorder';
import { llmClient } from '../../llm/client';
import { log } from '../../infrastructure/logging';
import { tenantRuntimeClient } from '../../connectors/tenant-runtime-client';
import { WORKFLOW_STEP_DESCRIPTION_MAX } from '../workflow-step-limits';
import type { WorkflowStep } from '@liftoffos/shared-types';
import type { LLMCompletionResponse } from '../../llm/types';

const mockComplete = llmClient.complete as jest.MockedFunction<typeof llmClient.complete>;
const mockRecord = recordDistillCall as jest.MockedFunction<typeof recordDistillCall>;
const mockGetManifests = tenantRuntimeClient.getTenantManifests as jest.MockedFunction<typeof tenantRuntimeClient.getTenantManifests>;
const mockGetCatalog = tenantRuntimeClient.getToolCatalog as jest.MockedFunction<typeof tenantRuntimeClient.getToolCatalog>;
const mockLog = log as unknown as { info: jest.Mock; warn: jest.Mock };

const catalog: ToolCatalog = new Map([
  ['sf__read', { name: 'sf__read', description: 'read', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
  ['sf__write', { name: 'sf__write', description: 'write', input_schema: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] } }],
]);

const step = (o: Partial<WorkflowStep> & { stepId: string }): WorkflowStep =>
  ({ description: 'd', type: 'tool_call', ...o }) as WorkflowStep;

const err = (o: Partial<ValidationError> & { type: ValidationError['type']; stepId: string }): ValidationError =>
  ({ detail: 'detail', ...o });

const STEPS: WorkflowStep[] = [
  step({ stepId: 's1', toolName: 'sf__read', toolInputTemplate: '{"q":"{{input.q}}"}', onSuccess: 's2' }),
  step({ stepId: 's2', toolName: 'sf__write', toolInput: { body: 'hi' }, onSuccess: '' }),
  step({ stepId: 's3', type: 'llm_reason', description: 'judge', onSuccess: '' }),
];

beforeEach(() => {
  jest.clearAllMocks();
  mockComplete.mockReset();
  delete process.env.DISTILL_PATCH_ENABLED;
});

// ── patchScopeFor: the table ──────────────────────────────────────────────
describe('patchScopeFor — the pairs each rejected error admits', () => {
  const pairs = (errors: ValidationError[], steps = STEPS) =>
    patchScopeFor(errors, steps)?.allowed.map((p) => `${p.stepId}.${p.field}`) ?? null;

  it('tool_call_without_failure_edge → onFailure', () => {
    expect(pairs([err({ type: 'tool_call_without_failure_edge', stepId: 's1', field: 'onFailure' })]))
      .toEqual(['s1.onFailure']);
  });

  it('condition_without_else → onFailure', () => {
    expect(pairs([err({ type: 'condition_without_else', stepId: 's1', field: 'onFailure' })]))
      .toEqual(['s1.onFailure']);
  });

  it('broken_reference → the named edge', () => {
    expect(pairs([err({ type: 'broken_reference', stepId: 's1', field: 'onSuccess' })])).toEqual(['s1.onSuccess']);
    expect(pairs([err({ type: 'broken_reference', stepId: 's1', field: 'onFailure' })])).toEqual(['s1.onFailure']);
  });

  it('unexecutable_graph / DANGLING_REF → the named edge', () => {
    expect(pairs([err({ type: 'unexecutable_graph', stepId: 's1', code: 'DANGLING_REF', field: 'onFailure' })]))
      .toEqual(['s1.onFailure']);
  });

  it('unknown_tool → toolName plus the argument field the step carries', () => {
    // s1 carries a template, s2 an object.
    expect(pairs([err({ type: 'unknown_tool', stepId: 's1', field: 'toolName' })]))
      .toEqual(['s1.toolName', 's1.toolInputTemplate']);
    expect(pairs([err({ type: 'unknown_tool', stepId: 's2', field: 'toolName' })]))
      .toEqual(['s2.toolName', 's2.toolInput']);
  });

  it('undispatchable_tool → the same two', () => {
    expect(pairs([err({ type: 'undispatchable_tool', stepId: 's1', field: 'toolName' })]))
      .toEqual(['s1.toolName', 's1.toolInputTemplate']);
  });

  it('tool_input_mismatch → the argument field the error names', () => {
    expect(pairs([err({ type: 'tool_input_mismatch', stepId: 's1', field: 'toolInputTemplate' })]))
      .toEqual(['s1.toolInputTemplate']);
    expect(pairs([err({ type: 'tool_input_mismatch', stepId: 's2', field: 'toolInput' })]))
      .toEqual(['s2.toolInput']);
  });

  it('unexecutable_graph / UNADDRESSABLE_REF → condition or toolInputTemplate, the one the problem names', () => {
    expect(pairs([err({ type: 'unexecutable_graph', stepId: 's1', code: 'UNADDRESSABLE_REF', field: 'condition' })]))
      .toEqual(['s1.condition']);
    expect(pairs([err({ type: 'unexecutable_graph', stepId: 's1', code: 'UNADDRESSABLE_REF', field: 'toolInputTemplate' })]))
      .toEqual(['s1.toolInputTemplate']);
  });

  it('unsafe_customer_copy → toolInputTemplate', () => {
    expect(pairs([err({ type: 'unsafe_customer_copy', stepId: 's1', field: 'toolInputTemplate' })]))
      .toEqual(['s1.toolInputTemplate']);
  });

  it('description_too_long → description', () => {
    expect(pairs([err({ type: 'description_too_long', stepId: 's3', field: 'description' })]))
      .toEqual(['s3.description']);
  });

  it('the same pair from two errors is listed once', () => {
    expect(pairs([
      err({ type: 'tool_call_without_failure_edge', stepId: 's1', field: 'onFailure' }),
      err({ type: 'broken_reference', stepId: 's1', field: 'onFailure' }),
    ])).toEqual(['s1.onFailure']);
  });
});

describe('patchScopeFor — what regenerates instead', () => {
  const scope = (errors: ValidationError[]) => patchScopeFor(errors, STEPS);

  it('an obligation-only rejection → null', () => {
    expect(scope([err({ type: 'missing_delivery_step', stepId: 'workflowSteps' })])).toBeNull();
    expect(scope([err({ type: 'missing_idempotency_step', stepId: 'workflowSteps' })])).toBeNull();
  });

  it('UNREACHABLE_STEP and DUPLICATE_STEP_ID → null', () => {
    expect(scope([err({ type: 'unexecutable_graph', stepId: 's3', code: 'UNREACHABLE_STEP' })])).toBeNull();
    expect(scope([err({ type: 'unexecutable_graph', stepId: 's1', code: 'DUPLICATE_STEP_ID' })])).toBeNull();
  });

  it('tool_output_field_guessed alone → null (its repair removes a field, which the format cannot say)', () => {
    expect(scope([err({ type: 'tool_output_field_guessed', stepId: 's1', field: 'toolInputTemplate' })])).toBeNull();
  });

  it('a DANGLING_REF problem without a field → null', () => {
    expect(scope([err({ type: 'unexecutable_graph', stepId: 's1', code: 'DANGLING_REF' })])).toBeNull();
  });

  it('an error whose detail names a field but whose field is unset → null: message text is never read', () => {
    expect(scope([err({
      type: 'broken_reference', stepId: 's1',
      detail: 'onSuccess references non-existent stepId "s9"',
    })])).toBeNull();
    expect(scope([err({
      type: 'tool_call_without_failure_edge', stepId: 's1',
      detail: 'Step "s1" calls "sf__read" with no "onFailure".',
    })])).toBeNull();
  });

  it('one non-patchable error makes the whole rejection non-patchable', () => {
    expect(scope([
      err({ type: 'tool_call_without_failure_edge', stepId: 's1', field: 'onFailure' }),
      err({ type: 'unexecutable_graph', stepId: 's3', code: 'UNREACHABLE_STEP' }),
    ])).toBeNull();
    expect(scope([
      err({ type: 'description_too_long', stepId: 's3', field: 'description' }),
      err({ type: 'ungated_announcement', stepId: 's2' }),
    ])).toBeNull();
  });

  it('the six inline and prose types → null', () => {
    for (const type of [
      'ungated_announcement', 'repeated_outward_action', 'missing_reply_contract',
      'missing_prose_delivery', 'unsafe_prose_copy', 'missing_prose_reply_contract',
    ] as const) {
      expect(scope([err({ type, stepId: 's1' })])).toBeNull();
    }
  });

  it('an error naming a step that does not exist → null', () => {
    expect(scope([err({ type: 'description_too_long', stepId: 's9', field: 'description' })])).toBeNull();
  });

  it('no errors → null', () => {
    expect(scope([])).toBeNull();
  });
});

// ── patchWorkflowSteps: request, enforcement, apply ───────────────────────
function patchResponse(edits: unknown, overrides?: Partial<LLMCompletionResponse>): LLMCompletionResponse {
  return {
    content: '',
    model: 'patch-model',
    provider: 'anthropic',
    stopReason: 'tool_use',
    usage: { inputTokens: 100, outputTokens: 20 },
    toolCalls: [{ id: 'p1', name: PATCH_TOOL_NAME, input: { edits } }],
    ...overrides,
  };
}

const MISSING_EDGE = [err({ type: 'tool_call_without_failure_edge', stepId: 's1', field: 'onFailure', detail: 'no onFailure' })];

async function runPatch(errors: ValidationError[], steps = STEPS) {
  const scope = patchScopeFor(errors, steps)!;
  return patchWorkflowSteps({
    steps, errors, scope, catalog,
    tenantId: 'tenant-1', agentId: 'agent-1', sessionId: 'sess-1', runId: 'run-1', attempt: 1,
  });
}

describe('patchWorkflowSteps — the request', () => {
  it('asks the medium tier for one patch_workflow_fields call, at temperature 0, under the output cap, as distill_patch', async () => {
    mockComplete.mockResolvedValueOnce(patchResponse([{ stepId: 's1', field: 'onFailure', value: 's2' }]));
    await runPatch(MISSING_EDGE);

    expect(mockComplete).toHaveBeenCalledTimes(1);
    const [request, provider, context] = mockComplete.mock.calls[0];
    expect(request.tier).toBe(PATCH_TIER);
    expect(PATCH_TIER).toBe('medium');
    expect(request.maxTokens).toBe(PATCH_MAX_TOKENS);
    expect(PATCH_MAX_TOKENS).toBe(4096);
    expect(request.temperature).toBe(0);
    expect(request.tools?.map((t) => t.name)).toEqual([PATCH_TOOL_NAME]);
    expect(request.toolChoice).toEqual({ name: PATCH_TOOL_NAME });
    expect(provider).toBeUndefined();
    expect(context).toEqual({ tenantId: 'tenant-1', agentId: 'agent-1', sessionId: 'sess-1', purpose: 'distill_patch' });
  });

  it('carries the rejection verbatim, the allowed pairs, the affected steps and neighbours, the named tools and the field contracts', async () => {
    mockComplete.mockResolvedValueOnce(patchResponse([{ stepId: 's1', field: 'onFailure', value: 's2' }]));
    await runPatch(MISSING_EDGE);
    const user = String(mockComplete.mock.calls[0][0].messages.find((m) => m.role === 'user')?.content);
    expect(user).toContain('- Step "s1": no onFailure');
    expect(user).toContain('- s1.onFailure');
    // s1 is affected; s2 is its onSuccess neighbour, read-only; s3 is neither.
    expect(user).toContain(JSON.stringify(STEPS[0]));
    expect(user).toContain(`(read-only) ${JSON.stringify(STEPS[1])}`);
    expect(user).not.toContain(JSON.stringify(STEPS[2]));
    expect(user).toContain('"name":"sf__read"');
    expect(user).toContain('"name":"sf__write"');
    // The onFailure contract from the produce_agent schema, not a paraphrase.
    expect(user).toContain('- onFailure: The stepId the run goes to when this step does not succeed.');
    expect(user).not.toContain('- toolName:');
  });

  it('includes a step that iterates the affected step\'s output through loop.over, read-only', async () => {
    const steps: WorkflowStep[] = [
      step({ stepId: 's1', toolName: 'sf__read', toolInputTemplate: '{"q":"x"}', onSuccess: 's3' }),
      step({ stepId: 's2', toolName: 'sf__write', toolInput: { body: 'hi' }, loop: { over: 'steps.s1.rows' }, onSuccess: '' }),
      step({ stepId: 's3', type: 'llm_reason', description: 'judge', onSuccess: '' }),
    ];
    mockComplete.mockResolvedValueOnce(patchResponse([{ stepId: 's1', field: 'onFailure', value: 's3' }]));
    const scope = patchScopeFor(MISSING_EDGE, steps)!;
    await patchWorkflowSteps({ steps, errors: MISSING_EDGE, scope, catalog, tenantId: 'tenant-1', runId: 'run-1', attempt: 1 });
    const user = String(mockComplete.mock.calls[0][0].messages.find((m) => m.role === 'user')?.content);
    expect(user).toContain(`(read-only) ${JSON.stringify(steps[1])}`);
  });

  it('finds the loop source step through the placeholder form the exemplar emits', async () => {
    // `{{steps.s1.rows}}` is the form the distiller's own worked exemplar
    // writes and that four live graphs use. The bare-path match did not see it,
    // so the source step was missing from the patch context of every correctly
    // authored loop — the repair model was asked to fix a step whose input it
    // could not read.
    const steps: WorkflowStep[] = [
      step({ stepId: 's1', toolName: 'sf__read', toolInputTemplate: '{"q":"x"}', onSuccess: 's3' }),
      step({ stepId: 's2', toolName: 'sf__write', toolInput: { body: 'hi' }, loop: { over: '{{steps.s1.rows}}' }, onSuccess: '' }),
      step({ stepId: 's3', type: 'llm_reason', description: 'judge', onSuccess: '' }),
    ];
    mockComplete.mockResolvedValueOnce(patchResponse([{ stepId: 's1', field: 'onFailure', value: 's3' }]));
    const scope = patchScopeFor(MISSING_EDGE, steps)!;
    await patchWorkflowSteps({ steps, errors: MISSING_EDGE, scope, catalog, tenantId: 'tenant-1', runId: 'run-1', attempt: 1 });
    const user = String(mockComplete.mock.calls[0][0].messages.find((m) => m.role === 'user')?.content);
    expect(user).toContain(`(read-only) ${JSON.stringify(steps[1])}`);
  });

  it('the tool takes { edits: [{ stepId, field, value }] } with string values only', () => {
    const tool = buildPatchTool();
    expect(tool.name).toBe(PATCH_TOOL_NAME);
    const items = (tool.input_schema as { properties: { edits: { items: { properties: Record<string, { type: string }>; required: string[] } } } })
      .properties.edits.items;
    expect(items.required).toEqual(['stepId', 'field', 'value']);
    expect(items.properties.value.type).toBe('string');
    expect(items.properties.stepId.type).toBe('string');
  });
});

describe('patchWorkflowSteps — enforcement after the call', () => {
  const discardedWith = async (edits: unknown, errors = MISSING_EDGE) => {
    mockComplete.mockResolvedValueOnce(patchResponse(edits));
    const out = await runPatch(errors);
    expect(out.applied).toBe(false);
    expect(out.steps).toBe(STEPS);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'distill.patch.discarded', reason: expect.any(String) }), expect.any(String),
    );
    return out.rejectedReason!;
  };

  it('an edit outside the allowed pairs discards the whole patch', async () => {
    const reason = await discardedWith([
      { stepId: 's1', field: 'onFailure', value: 's2' },
      { stepId: 's2', field: 'description', value: 'rewritten' },
    ]);
    expect(reason).toContain('outside the allowed pairs: s2.description');
  });

  it('a value failing its constraint discards the whole patch', async () => {
    expect(await discardedWith([{ stepId: 's1', field: 'onFailure', value: 's9' }])).toContain('not a step');
    expect(await discardedWith([{ stepId: 's1', field: 'onFailure', value: 's1' }])).toContain('own step');
    // A tool name that is not a catalog key.
    expect(await discardedWith(
      [{ stepId: 's1', field: 'toolName', value: 'sf__nope' }],
      [err({ type: 'unknown_tool', stepId: 's1', field: 'toolName' })],
    )).toContain('not a catalog key');
    // A template that does not parse.
    expect(await discardedWith(
      [{ stepId: 's1', field: 'toolInputTemplate', value: '{"q":' }],
      [err({ type: 'tool_input_mismatch', stepId: 's1', field: 'toolInputTemplate' })],
    )).toContain('tokenize');
    // A condition that does not start with `$.`.
    expect(await discardedWith(
      [{ stepId: 's1', field: 'condition', value: 'steps.s2.ok == true' }],
      [err({ type: 'unexecutable_graph', stepId: 's1', code: 'UNADDRESSABLE_REF', field: 'condition' })],
    )).toContain('$.');
    // A description over the cap.
    expect(await discardedWith(
      [{ stepId: 's3', field: 'description', value: 'x'.repeat(WORKFLOW_STEP_DESCRIPTION_MAX + 1) }],
      [err({ type: 'description_too_long', stepId: 's3', field: 'description' })],
    )).toContain('over');
    // toolInput that is not an object's JSON.
    expect(await discardedWith(
      [{ stepId: 's2', field: 'toolInput', value: '[1,2]' }],
      [err({ type: 'tool_input_mismatch', stepId: 's2', field: 'toolInput' })],
    )).toContain('object');
  });

  it('a duplicated pair discards the whole patch', async () => {
    expect(await discardedWith([
      { stepId: 's1', field: 'onFailure', value: 's2' },
      { stepId: 's1', field: 'onFailure', value: 's3' },
    ])).toContain('duplicated pair');
  });

  it('an edit that would unset a field (empty value on a non-edge field) is discarded', async () => {
    expect(await discardedWith(
      [{ stepId: 's3', field: 'description', value: '' }],
      [err({ type: 'description_too_long', stepId: 's3', field: 'description' })],
    )).toContain('unset');
    // ...and an empty onFailure on a missing-edge error, since '' is not a step.
    expect(await discardedWith([{ stepId: 's1', field: 'onFailure', value: '' }])).toContain('not a step');
  });

  it("'' is allowed on onSuccess under the named-edge row only", async () => {
    mockComplete.mockResolvedValueOnce(patchResponse([{ stepId: 's1', field: 'onSuccess', value: '' }]));
    const out = await runPatch([err({ type: 'broken_reference', stepId: 's1', field: 'onSuccess' })]);
    expect(out.applied).toBe(true);
    expect(out.steps.find((s) => s.stepId === 's1')?.onSuccess).toBe('');
    expect(await discardedWith(
      [{ stepId: 's1', field: 'onFailure', value: '' }],
      [err({ type: 'broken_reference', stepId: 's1', field: 'onFailure' })],
    )).toContain('onSuccess only');
  });

  it('no tool call, the wrong tool, malformed edits, no edits, or truncation → discarded', async () => {
    expect(await discardedWith(undefined)).toContain('malformed');
    expect(await discardedWith([])).toContain('no edits');
    expect(await discardedWith([{ stepId: 's1', field: 'onFailure', value: 7 }])).toContain('malformed');
    mockComplete.mockResolvedValueOnce(patchResponse([], { toolCalls: undefined }));
    expect((await runPatch(MISSING_EDGE)).rejectedReason).toContain('no tool call');
    mockComplete.mockResolvedValueOnce(patchResponse([], { toolCalls: [{ id: 'x', name: 'produce_agent', input: {} }] }));
    expect((await runPatch(MISSING_EDGE)).rejectedReason).toContain('unexpected tool');
    mockComplete.mockResolvedValueOnce(patchResponse([{ stepId: 's1', field: 'onFailure', value: 's2' }], { stopReason: 'max_tokens' }));
    expect((await runPatch(MISSING_EDGE)).rejectedReason).toContain('max_tokens');
  });

  it('a thrown call is discarded and reported as an error, never rethrown', async () => {
    mockComplete.mockRejectedValueOnce(new Error('boom'));
    const out = await runPatch(MISSING_EDGE);
    expect(out.applied).toBe(false);
    expect(out.rejectedReason).toBe('error: boom');
    expect(out.call?.error).toBe('boom');
    expect(mockLog.warn).toHaveBeenCalledWith(expect.objectContaining({ metric: 'distill.patch.error' }), expect.any(String));
  });
});

describe('patchWorkflowSteps — apply', () => {
  it('applies the edits, carries untouched steps by identity, and logs one applied line per edit', async () => {
    mockComplete.mockResolvedValueOnce(patchResponse([
      { stepId: 's1', field: 'toolName', value: 'sf__write' },
      { stepId: 's1', field: 'toolInputTemplate', value: '{"body":"{{input.q}}"}' },
    ]));
    const out = await runPatch([err({ type: 'unknown_tool', stepId: 's1', field: 'toolName' })]);
    expect(out.applied).toBe(true);
    expect(out.steps[0]).toMatchObject({ stepId: 's1', toolName: 'sf__write', toolInputTemplate: '{"body":"{{input.q}}"}', onSuccess: 's2' });
    expect(out.steps[0]).not.toBe(STEPS[0]);
    expect(out.steps[1]).toBe(STEPS[1]);
    expect(out.steps[2]).toBe(STEPS[2]);
    expect(out.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(out.call).toMatchObject({ provider: 'anthropic', model: 'patch-model' });
    const applied = mockLog.info.mock.calls
      .map((c) => c[0])
      .filter((o) => o?.metric === 'distill.patch.applied');
    expect(applied).toEqual([
      expect.objectContaining({ stepId: 's1', field: 'toolName', errorType: 'unknown_tool' }),
      expect.objectContaining({ stepId: 's1', field: 'toolInputTemplate', errorType: 'unknown_tool' }),
    ]);
  });

  it('toolInput is edited as its JSON text and parsed back', async () => {
    mockComplete.mockResolvedValueOnce(patchResponse([{ stepId: 's2', field: 'toolInput', value: '{"body":"{{steps.s1.q}}"}' }]));
    const out = await runPatch([err({ type: 'tool_input_mismatch', stepId: 's2', field: 'toolInput' })]);
    expect(out.applied).toBe(true);
    expect(out.steps[1].toolInput).toEqual({ body: '{{steps.s1.q}}' });
  });
});

describe('patchWorkflowSteps — the input budget', () => {
  it('is 8,000 tokens enforced as 32,000 characters over the whole serialised request', () => {
    expect(PATCH_INPUT_BUDGET_TOKENS).toBe(8_000);
    expect(PATCH_INPUT_BUDGET_CHARS).toBe(32_000);
  });

  it('an over-budget prompt skips the call and regenerates', async () => {
    const huge = STEPS.map((s) => (s.stepId === 's3'
      ? { ...s, description: 'x'.repeat(PATCH_INPUT_BUDGET_CHARS) }
      : s));
    const errors = [err({ type: 'description_too_long', stepId: 's3', field: 'description' })];
    const out = await runPatch(errors, huge);
    expect(mockComplete).not.toHaveBeenCalled();
    expect(out.applied).toBe(false);
    expect(out.call).toBeUndefined();
    expect(out.rejectedReason).toContain('input_budget');
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'distill.patch.skipped', reason: 'input_budget', chars: expect.any(Number) }),
      expect.any(String),
    );
    const { chars } = mockLog.info.mock.calls.map((c) => c[0]).find((o) => o?.metric === 'distill.patch.skipped');
    expect(chars).toBeGreaterThan(PATCH_INPUT_BUDGET_CHARS);
  });

  it('counts the tool definition, not only the messages', async () => {
    mockComplete.mockResolvedValueOnce(patchResponse([{ stepId: 's1', field: 'onFailure', value: 's2' }]));
    await runPatch(MISSING_EDGE);
    const [request] = mockComplete.mock.calls[0];
    const chars = request.messages.reduce((n, m) => n + String(m.content).length, 0)
      + JSON.stringify(request.tools).length;
    expect(chars).toBeLessThanOrEqual(PATCH_INPUT_BUDGET_CHARS);
    expect(JSON.stringify(request.tools).length).toBeGreaterThan(0);
  });
});

describe('the kill switch and the per-attempt cap', () => {
  it('DISTILL_PATCH_ENABLED defaults on and 0 disables', () => {
    expect(isDistillPatchEnabled()).toBe(true);
    process.env.DISTILL_PATCH_ENABLED = '0';
    expect(isDistillPatchEnabled()).toBe(false);
    process.env.DISTILL_PATCH_ENABLED = '1';
    expect(isDistillPatchEnabled()).toBe(true);
  });

  it('one patch per attempt', () => {
    expect(MAX_PATCHES_PER_ATTEMPT).toBe(1);
  });
});

// ── Inside the distill loop ───────────────────────────────────────────────
const BASE_INPUT = {
  role: 'Sales Analyst',
  responsibilities: 'Analyze CRM data and generate weekly reports',
  integrations: [{ id: 'int-1', name: 'Salesforce', type: 'salesforce', selectedObjects: ['Contact', 'Opportunity'] }],
  tenantId: 'tenant-1',
};

function agentResponse(steps: Array<Record<string, unknown>>): LLMCompletionResponse {
  return {
    content: '',
    model: 'test-model',
    provider: 'anthropic',
    stopReason: 'tool_use',
    toolCalls: [{
      id: 'call-1',
      name: 'produce_agent',
      input: {
        summary: 'Automated CRM pipeline.',
        systemPrompt: 'You are a workflow executor for CRM sync.',
        userInstructions: 'Step 1: Read contacts. Step 2: Write report.',
        instructionsMd: '## Role\nWorkflow executor.\n\n## Tool-use guidance\nUse tools as specified.',
        triggerConfig: { type: 'cron', cronExpr: '0 9 * * 1', reasoning: 'Weekly Monday morning' },
        workflowSteps: steps,
      },
    }],
  };
}

function setupCatalog() {
  mockGetManifests.mockResolvedValue({
    schemaVersion: 1 as const,
    manifests: [{ manifestId: 'mf-1', connectorType: 'salesforce', alias: 'salesforce_prod', displayName: 'Salesforce Prod' }],
  });
  mockGetCatalog.mockResolvedValue({
    schemaVersion: 1 as const,
    connectorType: 'salesforce',
    alias: 'salesforce_prod',
    tools: [
      { name: 'salesforce_prod__read_contacts', description: 'Read contacts', input_schema: { type: 'object', properties: {} } },
      { name: 'salesforce_prod__create_report', description: 'Create report', input_schema: { type: 'object', properties: {} } },
    ],
  });
}

const GOOD_STEP_2 = {
  stepId: 'step_2', description: 'Create report', type: 'tool_call', toolName: 'salesforce_prod__create_report',
  onSuccess: '', expectedOutput: 'a short summary of what was done and what it found',
};

describe('the patch rung inside the distill loop', () => {
  it('a converging patch ends the attempt with no large-tier regeneration', async () => {
    setupCatalog();
    // step_1 hands on to step_2 with no onFailure: the one patchable error.
    mockComplete
      .mockResolvedValueOnce(agentResponse([
        { stepId: 'step_1', description: 'Read contacts', type: 'tool_call', toolName: 'salesforce_prod__read_contacts', onSuccess: 'step_2' },
        GOOD_STEP_2,
      ]))
      .mockResolvedValueOnce(patchResponse([{ stepId: 'step_1', field: 'onFailure', value: 'step_2' }]));

    const result = await distillInternalAgentWithProgress(BASE_INPUT);

    expect(mockComplete).toHaveBeenCalledTimes(2);
    expect(mockComplete.mock.calls[1][0].tools?.[0].name).toBe(PATCH_TOOL_NAME);
    expect(mockComplete.mock.calls[1][2]?.purpose).toBe('distill_patch');
    expect(result.workflowSteps).toHaveLength(2);
    expect(result.workflowSteps?.[0].onFailure).toBe('step_2');
    // One distill_runs row for the patch, under the same run, outcome ok.
    const patchRow = mockRecord.mock.calls.map((c) => c[0]).find((r) => r.phase === 'patch');
    expect(patchRow).toMatchObject({
      phase: 'patch', branch: 'graph', outcome: 'ok', attempt: 1, strategy: 'single',
      provider: 'anthropic', model: 'patch-model', usage: { inputTokens: 100, outputTokens: 20 },
    });
    const singleRow = mockRecord.mock.calls.map((c) => c[0]).find((r) => r.phase === 'single');
    expect(patchRow?.runId).toBe(singleRow?.runId);
  });

  it('a non-converging patch falls through to the correction turn holding the patched artifact', async () => {
    setupCatalog();
    // Two patchable errors; the patch fixes one and leaves the description over cap.
    const overlong = 'x'.repeat(WORKFLOW_STEP_DESCRIPTION_MAX + 1);
    mockComplete
      .mockResolvedValueOnce(agentResponse([
        { stepId: 'step_1', description: overlong, type: 'tool_call', toolName: 'salesforce_prod__read_contacts', onSuccess: 'step_2' },
        GOOD_STEP_2,
      ]))
      .mockResolvedValueOnce(patchResponse([{ stepId: 'step_1', field: 'onFailure', value: 'step_2' }]))
      .mockResolvedValueOnce(agentResponse([
        { stepId: 'step_1', description: 'Read contacts', type: 'tool_call', toolName: 'salesforce_prod__read_contacts', onSuccess: 'step_2', onFailure: 'step_2' },
        GOOD_STEP_2,
      ]));

    const result = await distillInternalAgentWithProgress(BASE_INPUT);

    expect(mockComplete).toHaveBeenCalledTimes(3);
    // The correction turn replays the POST-patch artifact and names only what is left.
    const retry = mockComplete.mock.calls[2][0].messages;
    const replayed = retry.find((m) => m.role === 'assistant' && m.toolCalls)?.toolCalls?.[0].input as { workflowSteps: WorkflowStep[] };
    expect(replayed.workflowSteps[0].onFailure).toBe('step_2');
    const feedback = String(retry.find((m) => Array.isArray(m.toolResults))?.toolResults?.[0].content);
    expect(feedback).toContain('description is');
    expect(feedback).not.toContain('no "onFailure"');
    expect(result.workflowSteps?.[0].description).toBe('Read contacts');
    const patchRow = mockRecord.mock.calls.map((c) => c[0]).find((r) => r.phase === 'patch');
    expect(patchRow?.outcome).toBe('validation_failed');
    expect(mockLog.warn).toHaveBeenCalledWith(expect.objectContaining({ metric: 'distill.patch.rejected' }), expect.any(String));
  });

  it('a thrown patch call is discarded and the attempt regenerates as today', async () => {
    setupCatalog();
    mockComplete
      .mockResolvedValueOnce(agentResponse([
        { stepId: 'step_1', description: 'Read contacts', type: 'tool_call', toolName: 'salesforce_prod__read_contacts', onSuccess: 'step_2' },
        GOOD_STEP_2,
      ]))
      .mockRejectedValueOnce(new Error('patch down'))
      .mockResolvedValueOnce(agentResponse([
        { stepId: 'step_1', description: 'Read contacts', type: 'tool_call', toolName: 'salesforce_prod__read_contacts', onSuccess: 'step_2', onFailure: 'step_2' },
        GOOD_STEP_2,
      ]));

    const result = await distillInternalAgentWithProgress(BASE_INPUT);

    expect(mockComplete).toHaveBeenCalledTimes(3);
    expect(result.workflowSteps?.[0].onFailure).toBe('step_2');
    const patchRow = mockRecord.mock.calls.map((c) => c[0]).find((r) => r.phase === 'patch');
    expect(patchRow).toMatchObject({ outcome: 'error', error: 'patch down' });
  });

  it('a non-patchable rejection makes no patch call', async () => {
    setupCatalog();
    // An unreachable step: regenerates as today, two produce_agent calls, no patch.
    mockComplete
      .mockResolvedValueOnce(agentResponse([
        { stepId: 'step_1', description: 'Read contacts', type: 'tool_call', toolName: 'salesforce_prod__read_contacts', onSuccess: '', expectedOutput: 'a summary' },
        GOOD_STEP_2,
      ]))
      .mockResolvedValueOnce(agentResponse([
        { stepId: 'step_1', description: 'Read contacts', type: 'tool_call', toolName: 'salesforce_prod__read_contacts', onSuccess: 'step_2', onFailure: 'step_2' },
        GOOD_STEP_2,
      ]));

    await distillInternalAgentWithProgress(BASE_INPUT);

    expect(mockComplete).toHaveBeenCalledTimes(2);
    expect(mockComplete.mock.calls.every((c) => c[0].tools?.[0].name === 'produce_agent')).toBe(true);
    expect(mockRecord.mock.calls.map((c) => c[0]).find((r) => r.phase === 'patch')).toBeUndefined();
  });

  it('DISTILL_PATCH_ENABLED=0 takes today\'s path without a deploy', async () => {
    process.env.DISTILL_PATCH_ENABLED = '0';
    setupCatalog();
    mockComplete
      .mockResolvedValueOnce(agentResponse([
        { stepId: 'step_1', description: 'Read contacts', type: 'tool_call', toolName: 'salesforce_prod__read_contacts', onSuccess: 'step_2' },
        GOOD_STEP_2,
      ]))
      .mockResolvedValueOnce(agentResponse([
        { stepId: 'step_1', description: 'Read contacts', type: 'tool_call', toolName: 'salesforce_prod__read_contacts', onSuccess: 'step_2', onFailure: 'step_2' },
        GOOD_STEP_2,
      ]));

    await distillInternalAgentWithProgress(BASE_INPUT);

    expect(mockComplete).toHaveBeenCalledTimes(2);
    expect(mockComplete.mock.calls.every((c) => c[0].tools?.[0].name === 'produce_agent')).toBe(true);
  });
});
