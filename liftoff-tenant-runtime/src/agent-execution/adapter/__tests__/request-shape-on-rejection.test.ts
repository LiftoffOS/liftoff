// A provider's 4xx names the failure and rarely the parameter. The request's
// SHAPE — parameter names, tool names, message roles and content kinds, never
// content — is the one record of what was actually sent, and it is logged
// only when a provider refuses.

import { requestShapeOf, fetchLoggingShapeOnRejection } from '../request-shape-on-rejection';
import { logger } from '../../../infrastructure/logging';

describe('requestShapeOf', () => {
  it('describes a chat-completions body without its content', () => {
    const shape = requestShapeOf({
      model: 'z-ai/glm-5-turbo',
      messages: [
        { role: 'system', content: 'SECRET SYSTEM PROMPT' },
        { role: 'user', content: [{ type: 'text', text: 'SECRET USER TEXT' }] },
        { role: 'user', content: '' },
      ],
      tools: [{ type: 'function', function: { name: 'pull_request_read', parameters: { secret: 1 } } }],
      tool_choice: { type: 'function', function: { name: 'pull_request_read' } },
      session_id: 'abc',
    });
    expect(shape).toEqual({
      paramKeys: ['messages', 'model', 'session_id', 'tool_choice', 'tools'],
      model: 'z-ai/glm-5-turbo',
      toolCount: 1,
      toolNames: ['pull_request_read'],
      toolChoice: { type: 'function', function: { name: 'pull_request_read' } },
      messageRoles: ['system', 'user', 'user'],
      messageContentKinds: ['empty', 'part:text', 'string'],
      emptyContentMessages: 1,
      systemMessages: 1,
      messageOutline: ['system:string(20)', 'user:part:text', 'user:empty'],
    });
    // Content never appears, in any field.
    expect(JSON.stringify(shape)).not.toMatch(/SECRET/);
  });

  it('outlines tool-call turns so a bad sequence is readable', () => {
    const shape = requestShapeOf({
      model: 'm',
      messages: [
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }, { id: 'c2' }] },
        { role: 'tool', tool_call_id: 'c1', content: 'r1' },
        { role: 'tool', tool_call_id: 'c2', content: 'r2' },
      ],
    });
    expect(shape?.messageOutline).toEqual([
      'assistant:empty:calls=2',
      'tool:string(2):answers',
      'tool:string(2):answers',
    ]);
  });

  it('is null for a body it cannot read', () => {
    expect(requestShapeOf(undefined)).toBeNull();
    expect(requestShapeOf('not json')).toBeNull();
  });
});

describe('fetchLoggingShapeOnRejection', () => {
  afterEach(() => jest.restoreAllMocks());

  it('logs the shape on a 4xx and passes the response through untouched', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const inner = jest.fn(async () => new Response('{"error":{"code":"1210"}}', { status: 400 }));
    const f = fetchLoggingShapeOnRejection(inner as unknown as typeof fetch, 'openrouter');

    const res = await f('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] }),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('1210');
    const entry = warn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(entry.event).toBe('provider_rejected_request');
    expect(entry.status).toBe(400);
    expect(entry.paramKeys).toEqual(['messages', 'model', 'tools']);
    expect(entry.messageRoles).toEqual(['user']);
  });

  it('stays silent on success', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const inner = jest.fn(async () => new Response('{}', { status: 200 }));
    const f = fetchLoggingShapeOnRejection(inner as unknown as typeof fetch, 'openrouter');
    await f('https://x/y', { method: 'POST', body: '{}' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('never turns a logging failure into a request failure', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => { throw new Error('logger down'); });
    const inner = jest.fn(async () => new Response('nope', { status: 400 }));
    const f = fetchLoggingShapeOnRejection(inner as unknown as typeof fetch, 'openrouter');
    const res = await f('https://x/y', { method: 'POST', body: 'not json' });
    expect(res.status).toBe(400);
  });
});
