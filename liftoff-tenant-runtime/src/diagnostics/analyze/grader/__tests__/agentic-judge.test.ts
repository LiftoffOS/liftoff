// Storage is mocked so seedSandboxArtifacts reads a synthetic small text file
// without touching GCS. The dispatcher mock captures the ExecuteInput so we can
// assert the identity fields ToolGatewayService.validateIdentity requires.
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: () => ({
      file: () => ({
        getMetadata: jest.fn().mockResolvedValue([{ size: 5 }]),
        download: jest.fn().mockResolvedValue([Buffer.from('hello')]),
      }),
    }),
  })),
}));
jest.mock('../../../../tool-gateway/dispatcher', () => {
  const execute = jest.fn().mockResolvedValue({ success: true });
  return { getToolGatewayDispatcher: () => ({ execute, executeBatch: jest.fn() }) };
});

import { graderGateFor, seedSandboxArtifacts } from '../grader-catalog';
import type { McpToolCatalog } from '../../../../agent-execution/adapter';
import { extractScore } from '../agentic-judge';
import { SCORE_AGENTIC_PROMPT_VERSION, SCORE_PROMPT_VERSION } from '../prompts';
import { getToolGatewayDispatcher } from '../../../../tool-gateway/dispatcher';
import type { ReconstructedRun } from '../../../reconstruct/trace-model';

const catalogWith = (names: string[]): McpToolCatalog => ({
  servers: [],
  tools: names.map((name) => ({ name, inputSchema: {}, serverId: 'liftoff-tool-gateway' })),
});

describe('graderGateFor (catalog-scoped read-only gate)', () => {
  // A read-filtered catalog: sandbox tools + a read connector tool. The dangerous
  // built-ins are always in the real catalog too, so include them to prove they
  // are denied regardless.
  const gate = graderGateFor(catalogWith([
    'file_read', 'file_write', 'shell_exec', 'gmail_list_messages',
    'code_session', 'notifications_send', 'memory_save', 'audit_log',
  ]));
  const call = (toolName: string) => gate({ toolName, args: {}, tenantId: 't', invocationId: 'i' });

  it('denies dangerous built-ins even when present in the catalog', async () => {
    expect((await call('code_session')).allow).toBe(false);
    expect((await call('delegate_to_agent')).allow).toBe(false);
    expect((await call('notifications_send')).allow).toBe(false);
    expect((await call('memory_save')).allow).toBe(false);
    expect((await call('audit_log')).allow).toBe(false);
  });

  it('allows sandbox tools, read connector tools in the catalog, and read-only web', async () => {
    expect((await call('file_read')).allow).toBe(true);
    expect((await call('file_write')).allow).toBe(true);
    expect((await call('shell_exec')).allow).toBe(true);
    expect((await call('gmail_list_messages')).allow).toBe(true);
    expect((await call('web_fetch')).allow).toBe(true);
    expect((await call('web_search')).allow).toBe(true);
  });

  it('denies a tool not in the catalog (default-deny) with a hard deny (no hitlPause)', async () => {
    const r = await call('gmail_send_email');
    expect(r.allow).toBe(false);
    expect(r.hitlPause).toBeUndefined();
    expect(typeof r.reason).toBe('string');
  });
});

describe('extractScore (final-message parsing)', () => {
  it('parses a bare JSON final message', () => {
    const r = extractScore('{"items":[{"id":"c0.i0","awarded":8,"note":"ok"}]}');
    expect(r?.items).toHaveLength(1);
    expect(r?.items[0].awarded).toBe(8);
  });

  it('parses a fenced JSON block after prose', () => {
    const r = extractScore('Here are my scores:\n```json\n{"items":[{"id":"c0.i0","awarded":5}]}\n```');
    expect(r?.items[0].id).toBe('c0.i0');
  });

  it('parses the widest brace span from mixed text', () => {
    const r = extractScore('done. {"items":[{"id":"c1.i2","awarded":0,"note":"unverifiable"}]} thanks');
    expect(r?.items[0].note).toBe('unverifiable');
  });

  it('returns null when nothing parses', () => {
    expect(extractScore('no json here')).toBeNull();
    expect(extractScore('')).toBeNull();
    expect(extractScore('{"wrong":"shape"}')).toBeNull();
  });

  // Robustness: a judge occasionally emits a bare array or drops the closing
  // bracket. Every item is present, so the panel must recover it rather than
  // silently drop that judge, which would leave an intermittently mixed panel.
  it('parses a bare [...] array with no {"items"} wrapper', () => {
    const r = extractScore('[{"id":"c0.i0","awarded":8,"note":"ok"},{"id":"c0.i1","awarded":3}]');
    expect(r?.items).toHaveLength(2);
    expect(r?.items[1].awarded).toBe(3);
  });

  it('salvages an object output whose closing ]} was dropped (truncated closer)', () => {
    // All items complete; only the trailing `]}` is missing.
    const r = extractScore('{"items":[{"id":"c0.i0","awarded":8,"note":"ok"},{"id":"c3.i3","awarded":5,"note":"clean"}');
    expect(r?.items).toHaveLength(2);
    expect(r?.items[1].id).toBe('c3.i3');
  });

  it('salvages a bare array whose closing ] was dropped', () => {
    const r = extractScore('[{"id":"c0.i0","awarded":10},{"id":"c0.i1","awarded":0,"note":"unverifiable"}');
    expect(r?.items).toHaveLength(2);
  });

  it('is not confused by braces/brackets inside note strings', () => {
    const r = extractScore('{"items":[{"id":"c0.i0","awarded":7,"note":"array [x] and object {y} in prose"}]}');
    expect(r?.items[0].note).toContain('[x]');
  });
});

describe('grader cohort separation', () => {
  it('agentic and one-shot carry different score prompt versions (never share a calibration cohort)', () => {
    expect(SCORE_AGENTIC_PROMPT_VERSION).not.toBe(SCORE_PROMPT_VERSION);
  });
});

describe('seedSandboxArtifacts (tool-gateway dispatch contract)', () => {
  const run = { ref: { tenantId: 't1', agentId: 'a1', key: 'real-inv-id' } } as unknown as ReconstructedRun;

  it('dispatches file_write with the identity fields validateIdentity requires', async () => {
    const execute = getToolGatewayDispatcher().execute as jest.Mock;
    execute.mockClear();
    await seedSandboxArtifacts(run, 'grade-1', ['gs://bucket/311e/artifacts/inv/deliverable.txt']);
    expect(execute).toHaveBeenCalledTimes(1);
    const arg = execute.mock.calls[0][0];
    // The bug: instructionVersion omitted + `as never` cast hid it → HTTP 500
    // "Instruction version required". validateIdentity rejects falsy, so it must
    // be a truthy number.
    expect(typeof arg.instructionVersion).toBe('number');
    expect(arg.instructionVersion).toBeGreaterThan(0);
    // idempotencyKey is also required by ExecuteInput.
    expect(typeof arg.idempotencyKey).toBe('string');
    expect(arg.idempotencyKey.length).toBeGreaterThan(0);
    // FK fix: `workspaceSessionId = gradeId` keeps the per-judge /workspace,
    // and `payload.invocationId` must be the REAL graded invocation
    // (run.ref.key) so the sandbox call's awaited audit_logs +
    // sandbox_usage_log FK inserts succeed — the session builder reads the
    // invocation from the payload first, a top-level one alone would be ignored.
    expect(arg.traceId).toBe('grade-1');
    expect(arg.workspaceSessionId).toBe('grade-1');
    expect(arg.payload.invocationId).toBe('real-inv-id');
    // The workspace handle never rides in the payload: `sessionId` there is a
    // TOOL argument on the session-bearing sandbox tools, and one would
    // overwrite the other.
    expect(arg.payload.sessionId).toBeUndefined();
    expect(arg.connector).toBe('execution_environment');
    expect(arg.actionType).toBe('file_write');
    expect(arg.payload.path).toBe('/workspace/deliverable.txt');
  });

  it('is a no-op with no artifacts (no dispatch, no error)', async () => {
    const execute = getToolGatewayDispatcher().execute as jest.Mock;
    execute.mockClear();
    await seedSandboxArtifacts(run, 'grade-2', []);
    expect(execute).not.toHaveBeenCalled();
  });
});
