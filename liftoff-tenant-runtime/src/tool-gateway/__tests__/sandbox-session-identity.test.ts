// A sandbox workspace is keyed by a RUN identity, never by a trace id and
// never by anything the model chose.
//
// Both halves of the sandbox session used to fall back to `input.traceId`,
// which on the autonomous path is the diagnostic label
// `exec-<workflowId>-<taskId>-<hash>`. Runs that carry no thread — delegated
// children and wake polls build their execution context without one — then
// keyed their workspace by that label, and the lookup
// (`SELECT ... WHERE session_id = $1` in sandbox-state-repository) raised
// `invalid input syntax for type uuid` before writing anything. The failure
// was unreachable while sandbox tools were absent from those runs; restoring
// the capability tier exposed it.
//
// The workspace handle also must not share a name with a TOOL ARGUMENT. Eleven
// sandbox tools (`nodejs_execute`, `bash_session_exec`, the `shell_session_*`
// family) take a `sessionId` naming a session INSIDE the sandbox — a Node REPL,
// a PTY — which is a different thing from the workspace the sandbox itself is
// keyed by. While both travelled as `payload.sessionId`, one had to lose.

import { sandboxSessionIdFor } from '../service';

describe('sandboxSessionIdFor', () => {
  it('prefers an explicit caller handle', () => {
    // Provisioning, sidecar callbacks, and the parity rig pass composite
    // handles of the migration-286 kind; those own their own scope. The handle
    // rides its own field, which no tool schema can collide with.
    expect(sandboxSessionIdFor({
      workspaceSessionId: 'sandbox:sandbox-78d368a3:shell_exec:e2e-1781',
      threadId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      invocationId: '9f8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d',
    })).toBe('sandbox:sandbox-78d368a3:shell_exec:e2e-1781');
  });

  it('never keys the workspace by a session the model named', () => {
    // The regression, stated directly. `nodejs_execute` carries the sessionId
    // returned by `nodejs_session_create` — a handle to a REPL inside the
    // workspace. Reading it as the workspace key sends each REPL to its own
    // workspace and, worse, overwrote the tool argument on the way in.
    const replSession = '14312df8-b3ec-4191-886b-e6636d962301';
    expect(sandboxSessionIdFor({
      payload: { sessionId: replSession, code: 'console.log(1)' },
      threadId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      invocationId: '9f8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d',
    })).toBe('f47ac10b-58cc-4372-a567-0e02b2c3d479');
  });

  it('scopes the workspace to the thread when there is one', () => {
    // A conversation keeps one workspace across its turns.
    expect(sandboxSessionIdFor({
      threadId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      invocationId: '9f8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d',
    })).toBe('f47ac10b-58cc-4372-a567-0e02b2c3d479');
  });

  it('falls back to the invocation for a thread-less run', () => {
    // Delegated children and wake polls: a per-run workspace is the correct,
    // narrower scope — and a real uuid either way.
    expect(sandboxSessionIdFor({
      invocationId: '9f8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d',
    })).toBe('9f8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d');
  });

  it('never derives an identity from a trace id', () => {
    // The trace id must not become a key.
    const traceShaped = 'exec-3B317E5A-FC67-4E95-8685-D7F08A8869A8-C53647CB-c48aae49';
    expect(() => sandboxSessionIdFor({ actionType: 'file_write' })).toThrow();
    const resolved = sandboxSessionIdFor({ invocationId: '9f8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d' });
    expect(resolved).not.toBe(traceShaped);
    expect(resolved).not.toMatch(/^exec-/);
  });

  it('surfaces a caller that threaded no run identity at all', () => {
    // Failing loudly beats minting a malformed key that fails later, deeper,
    // and with a Postgres type error instead of a usable message.
    expect(() => sandboxSessionIdFor({ actionType: 'shell_exec' }))
      .toThrow(/no session identity/i);
    expect(() => sandboxSessionIdFor({ actionType: 'shell_exec' }))
      .toThrow(/shell_exec/);
  });

  it('ignores a non-string or empty explicit handle', () => {
    expect(sandboxSessionIdFor({
      workspaceSessionId: '',
      invocationId: '9f8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d',
    })).toBe('9f8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d');
    expect(sandboxSessionIdFor({
      workspaceSessionId: 42 as unknown as string,
      invocationId: '9f8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d',
    })).toBe('9f8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d');
  });
});
