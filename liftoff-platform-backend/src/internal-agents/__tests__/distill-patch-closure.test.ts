// The graph validators, as one closure the patch rung can run twice.
//
// `collectGraphErrors` replaced the validator array inside the distill loop so
// a patched graph is judged by exactly the rule that judged the model's own.
// Three things have to hold for that to mean anything:
//
//   1. MEMBERSHIP — the closure carries every validator the array carried, once
//      each, and nothing was left outside it. Most members are module-local
//      functions that no mock can reach, so this is read from the source.
//   2. ONCE PER INVOCATION — each validator runs once when the closure runs
//      once, and twice when a patch makes it run twice. Asserted on the members
//      that live in other modules, which a mock can count.
//   3. TYPE — the closure's return type covers every validator's declared
//      return type. A `satisfies` per member lives in
//      validation-error-union.check.ts, and this test compiles that file: test
//      files are excluded from `tsc --noEmit` and ts-jest runs with diagnostics
//      off, so a `satisfies` nobody compiles is decoration.

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
// The members that live in other modules: wrapped, not replaced, so the graph
// is still judged and the calls can be counted.
jest.mock('../workflow-steps-executable', () => {
  const actual = jest.requireActual('../workflow-steps-executable');
  return { ...actual, findWorkflowStepProblems: jest.fn(actual.findWorkflowStepProblems) };
});
jest.mock('../announce-gating', () => {
  const actual = jest.requireActual('../announce-gating');
  return { ...actual, findUngatedAnnouncements: jest.fn(actual.findUngatedAnnouncements) };
});
jest.mock('../action-repetition', () => {
  const actual = jest.requireActual('../action-repetition');
  return { ...actual, findRepeatedOutwardActions: jest.fn(actual.findRepeatedOutwardActions) };
});
jest.mock('../reply-contract', () => {
  const actual = jest.requireActual('../reply-contract');
  return { ...actual, findMissingReplyContract: jest.fn(actual.findMissingReplyContract) };
});

import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';
import { distillInternalAgentWithProgress } from '../distill-service';
import { PATCH_TOOL_NAME } from '../distill-patch';
import { findWorkflowStepProblems } from '../workflow-steps-executable';
import { findUngatedAnnouncements } from '../announce-gating';
import { findRepeatedOutwardActions } from '../action-repetition';
import { findMissingReplyContract } from '../reply-contract';
import { llmClient } from '../../llm/client';
import { tenantRuntimeClient } from '../../connectors/tenant-runtime-client';
import type { LLMCompletionResponse } from '../../llm/types';

const SERVICE = join(__dirname, '..', 'distill-service.ts');
const SRC = readFileSync(SERVICE, 'utf8');

/** The members of the validator array as it stood before it became the
 *  closure: two computed arrays spread as they are, and twenty validator
 *  calls. This is the list the closure has to equal. */
const ORIGINAL_ARRAY_MEMBERS = [
  'triggerDeliveryErrors',
  'topicFilterErrors',
  'validateWorkflowSteps',
  'findMissingDeliveryStep',
  'findMissingExtractionStep',
  'findMissingIdempotencyStep',
  'findMissingProvenanceRead',
  'findMissingArtifactWrite',
  'findMissingDestinationFileWrite',
  'findMissingSeriesWrite',
  'validateTriggerCapabilityCoverage',
  'findWorkflowStepProblems',
  'findDegenerateFixes',
  'findConditionsWithoutElse',
  'findToolCallsWithoutFailureEdge',
  'findMemoryStepsOutsideScope',
  'findUngatedAnnouncements',
  'findRepeatedOutwardActions',
  'findMissingReplyContract',
  'findCompanionCronsThatCannotRunTheGraph',
  'findGuessedToolOutputFields',
  'findUnsafeCustomerFacingCopy',
  'findWorkSourceWiderThanBinding',
].sort();

/** The closure's array literal, from the AST. */
function closureArray(): ts.ArrayLiteralExpression {
  const source = ts.createSourceFile(SERVICE, SRC, ts.ScriptTarget.Latest, true);
  let found: ts.ArrayLiteralExpression | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name) && node.name.text === 'collectGraphErrors'
      && node.initializer && ts.isArrowFunction(node.initializer)) {
      let body: ts.Node = node.initializer.body;
      if (ts.isParenthesizedExpression(body)) body = body.expression;
      if (ts.isArrayLiteralExpression(body)) found = body;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) throw new Error('collectGraphErrors is not an arrow function returning an array literal');
  return found;
}

/** The validator each spread element names: a bare identifier, a call, or a
 *  call followed by `.map(...)`. */
function memberName(element: ts.Expression): string {
  if (!ts.isSpreadElement(element)) throw new Error(`not a spread: ${element.getText()}`);
  let e: ts.Expression = element.expression;
  // `find(...).map(...)` → the inner call.
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'map') {
    e = e.expression.expression;
  }
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) return e.expression.text;
  if (ts.isIdentifier(e)) return e.text;
  throw new Error(`unrecognised member: ${element.getText()}`);
}

describe('membership: the closure equals the original array', () => {
  it('carries every member the array carried, once each, and nothing else', () => {
    const members = closureArray().elements.map(memberName);
    expect([...members].sort()).toEqual(ORIGINAL_ARRAY_MEMBERS);
    expect(new Set(members).size).toBe(members.length);
  });

  it('every call inside it is over the closure parameter, not the loop variable', () => {
    // A member still reading `workflowSteps` would judge the model's graph
    // while the patched one is declared converged.
    const text = closureArray().getText();
    expect(text).not.toMatch(/\bworkflowSteps\b/);
    expect(text).toMatch(/\bsteps\b/);
  });

  it('nothing was left outside: between the closure and the rejection block only the closure is called', () => {
    const start = SRC.indexOf('let validationErrors = collectGraphErrors(workflowSteps);');
    const end = SRC.indexOf('if (validationErrors.length > 0) {', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const between = SRC.slice(start, end);
    for (const name of ORIGINAL_ARRAY_MEMBERS) {
      if (name === 'triggerDeliveryErrors' || name === 'topicFilterErrors') continue;
      expect(between).not.toContain(`${name}(`);
    }
    // ...and a patched graph is judged by the same closure.
    expect(between).toContain('collectGraphErrors(patched.steps)');
  });
});

// ── Once per invocation ────────────────────────────────────────────────────
const mockComplete = llmClient.complete as jest.MockedFunction<typeof llmClient.complete>;
const mockGetManifests = tenantRuntimeClient.getTenantManifests as jest.MockedFunction<typeof tenantRuntimeClient.getTenantManifests>;
const mockGetCatalog = tenantRuntimeClient.getToolCatalog as jest.MockedFunction<typeof tenantRuntimeClient.getToolCatalog>;
const counted = [
  findWorkflowStepProblems, findUngatedAnnouncements, findRepeatedOutwardActions, findMissingReplyContract,
] as unknown as jest.Mock[];

const BASE_INPUT = {
  role: 'Sales Analyst',
  responsibilities: 'Analyze CRM data and generate weekly reports',
  integrations: [{ id: 'int-1', name: 'Salesforce', type: 'salesforce', selectedObjects: ['Contact'] }],
  tenantId: 'tenant-1',
};

function agentResponse(steps: Array<Record<string, unknown>>): LLMCompletionResponse {
  return {
    content: '', model: 'test-model', provider: 'anthropic', stopReason: 'tool_use',
    toolCalls: [{
      id: 'call-1', name: 'produce_agent',
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

function patchResponse(edits: unknown): LLMCompletionResponse {
  return {
    content: '', model: 'patch-model', provider: 'anthropic', stopReason: 'tool_use',
    usage: { inputTokens: 1, outputTokens: 1 },
    toolCalls: [{ id: 'p1', name: PATCH_TOOL_NAME, input: { edits } }],
  };
}

const READ = { stepId: 'step_1', description: 'Read contacts', type: 'tool_call', toolName: 'salesforce_prod__read_contacts', onSuccess: 'step_2' };
const REPORT = { stepId: 'step_2', description: 'Create report', type: 'tool_call', toolName: 'salesforce_prod__create_report', onSuccess: '', expectedOutput: 'a short summary of what was found' };

describe('once per invocation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockComplete.mockReset();
    delete process.env.DISTILL_PATCH_ENABLED;
    mockGetManifests.mockResolvedValue({
      schemaVersion: 1 as const,
      manifests: [{ manifestId: 'mf-1', connectorType: 'salesforce', alias: 'salesforce_prod', displayName: 'Salesforce Prod' }],
    });
    mockGetCatalog.mockResolvedValue({
      schemaVersion: 1 as const, connectorType: 'salesforce', alias: 'salesforce_prod',
      tools: [
        { name: 'salesforce_prod__read_contacts', description: 'Read contacts', input_schema: { type: 'object', properties: {} } },
        { name: 'salesforce_prod__create_report', description: 'Create report', input_schema: { type: 'object', properties: {} } },
      ],
    });
  });

  it('a graph accepted first time runs each validator once', async () => {
    mockComplete.mockResolvedValueOnce(agentResponse([{ ...READ, onFailure: 'step_2' }, REPORT]));
    await distillInternalAgentWithProgress(BASE_INPUT);
    expect(mockComplete).toHaveBeenCalledTimes(1);
    for (const fn of counted) expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a patched graph runs each validator twice: once over the model\'s graph, once over the patched one', async () => {
    mockComplete
      .mockResolvedValueOnce(agentResponse([READ, REPORT]))
      .mockResolvedValueOnce(patchResponse([{ stepId: 'step_1', field: 'onFailure', value: 'step_2' }]));
    const result = await distillInternalAgentWithProgress(BASE_INPUT);
    expect(mockComplete).toHaveBeenCalledTimes(2);
    expect(result.workflowSteps?.[0].onFailure).toBe('step_2');
    for (const fn of counted) {
      expect(fn).toHaveBeenCalledTimes(2);
      // The second invocation saw the patched graph.
      const secondSteps = fn.mock.calls[1][0] as Array<{ onFailure?: string }>;
      expect(secondSteps[0].onFailure).toBe('step_2');
    }
  });
});

// ── Type: the closure's return type covers each member's declared type ─────
describe('type: every validator\'s declared return type satisfies ValidationError', () => {
  const CHECK = join(__dirname, 'validation-error-union.check.ts');
  const NEGATIVE = join(__dirname, '__negative-control.check.ts');

  function compile(): { checkDiagnostics: string[]; negativeDiagnostics: string[] } {
    const configPath = ts.findConfigFile(__dirname, ts.sys.fileExists, 'tsconfig.json');
    if (!configPath) throw new Error('tsconfig.json not found');
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(configPath, '..'));
    const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, skipLibCheck: true, rootDir: undefined };

    // The negative control: the same file plus one line the union must
    // refuse. Served from memory at a path beside the real one, so its
    // relative imports resolve identically; if it compiled clean the whole
    // check would be proving nothing.
    const negativeText = readFileSync(CHECK, 'utf8')
      + "\nvoid ({ type: 'not_a_validation_error', stepId: '', detail: '' } satisfies ValidationError);\n";
    const host = ts.createCompilerHost(options, true);
    const realFileExists = host.fileExists.bind(host);
    const realReadFile = host.readFile.bind(host);
    host.fileExists = (f) => f === NEGATIVE || realFileExists(f);
    host.readFile = (f) => (f === NEGATIVE ? negativeText : realReadFile(f));

    const program = ts.createProgram([CHECK, NEGATIVE], options, host);
    const format = (d: ts.Diagnostic) => ts.flattenDiagnosticMessageText(d.messageText, '\n');
    const all = ts.getPreEmitDiagnostics(program);
    return {
      checkDiagnostics: all.filter((d) => d.file?.fileName === CHECK).map(format),
      negativeDiagnostics: all.filter((d) => d.file?.fileName === NEGATIVE).map(format),
    };
  }

  it('compiles the per-member satisfies checks clean, and refuses a type the union lacks', () => {
    const { checkDiagnostics, negativeDiagnostics } = compile();
    expect(checkDiagnostics).toEqual([]);
    expect(negativeDiagnostics.length).toBeGreaterThan(0);
    expect(negativeDiagnostics.join('\n')).toContain('not_a_validation_error');
  }, 180_000);

  it('names one satisfies per closure member and per prose fence', () => {
    const text = readFileSync(CHECK, 'utf8');
    const satisfies = (text.match(/satisfies ValidationError/g) ?? []).length;
    // 17 members spread as they are (validateWorkflowSteps, the 6
    // obligations, the picked-destination fence, findDegenerateFixes, the two
    // edge checks, memory scope, companion crons, guessed output fields, unsafe
    // copy, work source, topicFilterErrors' producer), 4 mapped inline, 3 prose
    // fences.
    expect(satisfies).toBe(17 + 4 + 3);
    for (const name of ORIGINAL_ARRAY_MEMBERS) {
      if (name === 'triggerDeliveryErrors' || name === 'topicFilterErrors' || name === 'validateTriggerCapabilityCoverage') continue;
      const exported = name === 'validateWorkflowSteps' ? '__internalValidateWorkflowSteps' : name;
      expect(text).toContain(`typeof ${exported}`);
    }
  });
});
