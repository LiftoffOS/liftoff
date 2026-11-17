// The gateway may add to a sandbox dispatch payload. It may not overwrite it.
//
// `payload` is the model's tool arguments. Platform identity — which workspace
// this dispatch belongs to — is a separate concern and travels in its own
// fields (`threadId`, `invocationId`, `workspaceSessionId`). Merging the two
// into one object with a shared key silently destroyed the argument: eleven
// sandbox tools take a `sessionId` naming a session inside the sandbox, and
// every one of them received the workspace key instead. `nodejs_execute` then
// addressed a REPL that never existed, got a 404, and no `*_session_create`
// tool could produce a handle the next call would survive.
//
// Static source scan, in the idiom of mcp-server-errbody-fence: mcp-server.ts
// pulls the SDK and DB transitively, and the property under test is a property
// of the call sites themselves.

import { readFileSync } from 'fs';
import { join } from 'path';

const MCP = readFileSync(join(__dirname, '..', 'mcp-server.ts'), 'utf8');
const SERVICE = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

/** Every `payload:` object literal written in the MCP server. */
function payloadLiterals(): string[] {
  return Array.from(MCP.matchAll(/payload:\s*\{[^}]*\}/g)).map(m => m[0]);
}

describe('sandbox dispatch payloads carry tool arguments only', () => {
  it('no payload literal assigns sessionId', () => {
    // `{ ...args, sessionId: … }` is the shape that clobbered the argument.
    const offenders = payloadLiterals().filter(p => /\bsessionId\s*:/.test(p));
    expect(offenders).toEqual([]);
  });

  it('no payload literal derives a workspace key from the trace id', () => {
    // Same rule sandboxSessionIdFor states: a trace id is a diagnostic label,
    // not an identity. The workspace-file helpers used to fall back to it,
    // which put a parked file in a different workspace than the agent's own
    // tools could reach on a thread-less run.
    const offenders = payloadLiterals().filter(p => /\?\?\s*traceId/.test(p));
    expect(offenders).toEqual([]);
  });

  it('the sandbox tool dispatch threads the thread through', () => {
    // Without this the workspace falls to the invocation and a conversation
    // gets a fresh workspace every turn.
    const at = MCP.indexOf("entityType: 'sandbox'");
    expect(at).toBeGreaterThan(-1);
    const window = MCP.slice(Math.max(0, at - 900), at + 900);
    expect(window).toMatch(/\bthreadId,/);
  });
});

describe('a failed sandbox dispatch says why', () => {
  it('the sandbox branch returns the executor error', () => {
    // The branch built `{success, data, traceId}` and dropped `error`, so a
    // 404 session_not_found reached the model as `{"success":false,"data":{}}`
    // and was classified `internal_error, retryable:false` — an actionable
    // condition rendered unactionable, which then tripped the permanent-failure
    // cap and escalated the run.
    const at = SERVICE.indexOf('sandboxSessionIdFor(input)');
    expect(at).toBeGreaterThan(-1);
    const window = SERVICE.slice(at, at + 3000);
    const ret = window.match(/return \{\s*success: result\.success,[\s\S]{0,600}?\};/);
    expect(ret).not.toBeNull();
    expect(ret![0]).toMatch(/result\.error/);
  });

  it('carries the structured contract, not just the message', () => {
    // `retryable` is the difference between a model waiting out a workspace
    // that is still starting and abandoning the run over it.
    const at = SERVICE.indexOf('sandboxSessionIdFor(input)');
    const window = SERVICE.slice(at, at + 3000);
    const ret = window.match(/return \{\s*success: result\.success,[\s\S]{0,600}?\};/);
    expect(ret![0]).toMatch(/result\.errorCode/);
    expect(ret![0]).toMatch(/result\.retryable/);
    expect(ret![0]).toMatch(/result\.retryAfterMs/);
  });
});
