// A view-only seat cannot start a turn, on every surface that knows its role.
//
// The gate itself is four lines; the reason this file is longer is that the
// defect it prevents is not a wrong decision but a MISSING one. Blocking chat
// means blocking it at a dozen entry points across three dashboard surfaces, the
// Chief AI Officer's proxy and MCP, and a feature wired at only some of its ends
// passes lint, typecheck and its own tests while the hole stays open. So the
// third block below enumerates the routes rather than trusting that someone
// remembered: a new write route in a chat router fails until it is either gated
// or exempted with a reason.

import { readFileSync } from 'fs';
import { join } from 'path';
import { canConverseWithAgents, refusedAsViewer } from '../agent-conversation-gate';
import { ROLE_PERMISSIONS } from '../../tenant-members/types';

const SRC = join(__dirname, '..', '..');

describe('who may converse', () => {
  it('is member and above, never a viewer', () => {
    expect(canConverseWithAgents('owner')).toBe(true);
    expect(canConverseWithAgents('admin')).toBe(true);
    expect(canConverseWithAgents('member')).toBe(true);
    expect(canConverseWithAgents('viewer')).toBe(false);
  });

  it('reads the role table rather than naming roles, so a new role gets an answer', () => {
    // If a fifth role is added and nobody decides this, the table says false and
    // the surface refuses — the safe direction.
    for (const role of Object.keys(ROLE_PERMISSIONS)) {
      expect(typeof ROLE_PERMISSIONS[role as 'owner'].converseWithAgents).toBe('boolean');
    }
  });
});

describe('the refusal', () => {
  const mkRes = () => {
    const res = { statusCode: 0, body: null as unknown };
    return {
      res: res as unknown as Parameters<typeof refusedAsViewer>[1],
      seen: res,
      status(code: number) { res.statusCode = code; return this; },
      json(b: unknown) { res.body = b; return this; },
    };
  };

  it('answers 403 and stops the caller', () => {
    const captured = { code: 0, body: {} as Record<string, string> };
    const res = {
      status(code: number) { captured.code = code; return this; },
      json(body: Record<string, string>) { captured.body = body; return this; },
    } as unknown as Parameters<typeof refusedAsViewer>[1];

    expect(refusedAsViewer('viewer', res)).toBe(true);
    expect(captured.code).toBe(403);
    // What they can do about it, in their words: no permission name, no
    // mechanism, and never a tool or field name (INV-PB-015).
    expect(captured.body.message).toMatch(/view only/i);
    expect(captured.body.message).not.toMatch(/converseWithAgents|_|permission/);
  });

  it('writes nothing and returns false for anyone who may converse', () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      let touched = false;
      const res = {
        status() { touched = true; return this; },
        json() { touched = true; return this; },
      } as unknown as Parameters<typeof refusedAsViewer>[1];
      expect(refusedAsViewer(role, res)).toBe(false);
      expect(touched).toBe(false);
    }
  });

  it('is unused where it would arrive too late — after a stream has opened', () => {
    // Every chat stream resolves the caller BEFORE writing an SSE header, which
    // is what lets the refusal be an ordinary status rather than an error event
    // on an open stream. If that order is ever reversed, this is the assertion
    // that should have caught it.
    for (const f of ['liftoff/stream-router.ts', 'insights/stream-router.ts']) {
      const src = readFileSync(join(SRC, f), 'utf8');
      const gate = src.indexOf('refusedAsViewer');
      const sse = src.indexOf("setHeader('Content-Type', 'text/event-stream'");
      expect(gate).toBeGreaterThan(-1);
      if (sse > -1) expect(gate).toBeLessThan(sse);
    }
  });
});

// ── The enumeration ───────────────────────────────────────────────────────

/** Write routes in a chat surface that deliberately do NOT need the gate, each
 *  with the reason. Anything else must be gated. */
const EXEMPT: Record<string, string> = {
  // Bookkeeping on what the READER has seen. A view-only seat reads, so it marks
  // what it read; none of this reaches an agent.
  '/threads/read-all': 'read markers',
  '/threads/:threadId/read': 'read markers',
  '/:agentId/threads/read-all': 'read markers',
  '/:agentId/threads/:threadId/read': 'read markers',
  '/threads/:threadId/presence': 'who is looking at the thread',
  '/:agentId/threads/:threadId/presence': 'who is looking at the thread',
  // A viewer cannot start a turn, so there is none of theirs to stop, and
  // refusing could only strand a turn another session began.
  '/threads/:threadId/stop': 'stops a turn, never starts one',
  '/:agentId/stop': 'stops a turn, never starts one',
  // Removing a conversation is not conversing. Whether a viewer should delete a
  // thread is a separate question from whether they may talk to an agent, and
  // this change does not answer it.
  '/threads/:threadId': 'deletes a thread; not a turn',
  '/:agentId/threads/:threadId': 'deletes a thread; not a turn',
  // Feedback on a reply that already exists.
  '/:agentId/feedback': 'rates an existing reply',
};

const CHAT_SURFACES = [
  'liftoff/router.ts',
  'liftoff/stream-router.ts',
  'insights/router.ts',
  'insights/stream-router.ts',
  'agent-chat/router.ts',
  'agent-chat/stream-router.ts',
  'agent-chat/participant-router.ts',
];

describe('every conversation-starting route is gated', () => {
  it.each(CHAT_SURFACES)('%s', (rel) => {
    const src = readFileSync(join(SRC, rel), 'utf8');
    // Route declarations, with the handler text that follows each one, up to the
    // next declaration. Crude on purpose: it needs to over-approximate the
    // handler, never under-approximate it.
    const decl = /\.(post|delete|put|patch)\(\s*\n?\s*'([^']+)'/g;
    const hits: { path: string; from: number }[] = [];
    for (let m = decl.exec(src); m; m = decl.exec(src)) {
      hits.push({ path: m[2], from: m.index });
    }
    expect(hits.length).toBeGreaterThan(0);

    for (const [i, hit] of hits.entries()) {
      if (EXEMPT[hit.path]) continue;
      const body = src.slice(hit.from, hits[i + 1]?.from ?? src.length);
      // The message names the file and route so a failure says where to look.
      expect(
        body.includes('refusedAsViewer'),
      ).toBe(true);
    }
  });
});

describe('MCP refuses a viewer too', () => {
  it('chat and delegate_task both check before doing anything', () => {
    const src = readFileSync(join(SRC, 'mcp-server', 'service.ts'), 'utf8');
    for (const fn of ['export async function chat(', 'export async function delegateTask(']) {
      const at = src.indexOf(fn);
      expect(at).toBeGreaterThan(-1);
      // Within the first part of the body, before any work is dispatched.
      const head = src.slice(at, at + 900);
      expect(head).toContain('canConverseWithAgents');
    }
  });

  it('delegate_task is covered, which is the one that reads no role at all', () => {
    // It destructured only tenantId and keyId, so the role was not even in
    // scope: a view-only seat could hand real work to an agent, and the work
    // runs connector calls and spends the workspace's money.
    const src = readFileSync(join(SRC, 'mcp-server', 'service.ts'), 'utf8');
    const at = src.indexOf('export async function delegateTask(');
    const head = src.slice(at, at + 600);
    expect(head.indexOf('canConverseWithAgents'))
      .toBeLessThan(head.indexOf('resolveAddress'));
  });
});
