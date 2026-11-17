/**
 * The conversion that gives non-Anthropic engines a tool's arguments.
 *
 * The Claude Agent SDK reads the registered Zod shapes off the live McpServer.
 * openai-wire, gemini, codex and opencode read `McpToolCatalog.tools[].inputSchema`
 * instead, and that field is produced here. A tool that arrives there without
 * its arguments is uncallable in a specific and expensive way: the model has to
 * guess argument names, a required argument it guesses wrong is rejected on
 * every retry with the identical error, and the step burns its whole turn
 * budget before failing.
 *
 * The first case is the exact shape that did it — `record_step_output` for a
 * step declaring `outputField: 'triage'`.
 */

import { z } from 'zod';
import { toolInputSchemasFrom } from '../tool-input-schemas';
import { convertJsonSchemaToZod, extractToolShape } from '../schema-converter';

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

describe('toolInputSchemasFrom', () => {
  it('names the required root key of a dynamically-shaped step output', () => {
    // How mcp-server.ts builds record_step_output when the step declares
    // outputField 'triage' and later steps read keys out of it.
    const schemas = toolInputSchemasFrom([{
      name: 'record_step_output',
      inputSchema: {
        triage: z.object({}).passthrough().describe('The step\'s result, as the "triage" value the next step reads.'),
      },
    }]);

    const schema = schemas.record_step_output;
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['triage']);
    expect((schema.properties as Record<string, { type?: string }>).triage.type).toBe('object');
  });

  it('carries optionality, enums and descriptions through', () => {
    const schemas = toolInputSchemasFrom([{
      name: 'report_task_outcome',
      inputSchema: {
        status: z.enum(['complete', 'fail', 'escalate']),
        summary: z.string().describe('what happened'),
        detail: z.string().optional(),
      },
    }]);

    const schema = schemas.report_task_outcome;
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.status.enum).toEqual(['complete', 'fail', 'escalate']);
    expect(props.summary.description).toBe('what happened');
    expect(schema.required).toEqual(['status', 'summary']);
  });

  it('drops $schema, which is metadata about the document rather than the arguments', () => {
    const schemas = toolInputSchemasFrom([{ name: 't', inputSchema: { a: z.string() } }]);
    expect(schemas.t).not.toHaveProperty('$schema');
  });

  it('produces a document, not a validator', () => {
    // Zod's `toJSONSchema` output carries a NON-ENUMERABLE `~standard`: the
    // document is itself a Standard Schema, invisible to `Object.keys` and
    // `toEqual`, visible to `in`. A consumer that recognises validators treats
    // it as one — the OpenAI Agents SDK's `tool()` then refuses it without
    // strict mode, and every gateway tool failed to construct on every wire
    // engine while every equality assertion here kept passing.
    const schemas = toolInputSchemasFrom([{ name: 't', inputSchema: { a: z.string() } }]);
    expect('~standard' in schemas.t).toBe(false);
    expect(Object.getOwnPropertyNames(schemas.t)).toEqual(Object.keys(schemas.t));
  });

  it('is accepted by the SDK as a non-strict function tool, which is how the wire uses it', () => {
    // The consumer's own check, run here so a change in either the producer
    // or the SDK's notion of what counts as a validator fails at the seam.
    const { tool } = jest.requireActual<typeof import('@openai/agents')>('@openai/agents');
    const schemas = toolInputSchemasFrom([
      { name: 'with_args', inputSchema: { a: z.string(), n: z.number().optional() } },
      { name: 'no_args', inputSchema: {} },
    ]);
    for (const [name, parameters] of Object.entries(schemas)) {
      expect(() => tool({
        name,
        description: 'd',
        parameters: parameters as never,
        strict: false,
        execute: async () => 'ok',
      })).not.toThrow();
    }
  });

  it('states the object type for a tool that takes no arguments', () => {
    // `{}` would leave the model choosing a shape as well as a value.
    const schemas = toolInputSchemasFrom([
      { name: 'no_args', inputSchema: {} },
      { name: 'unregistered', inputSchema: undefined },
    ]);
    expect(schemas.no_args.type).toBe('object');
    expect(schemas.unregistered).toEqual({ type: 'object', properties: {} });
  });

  it('loses one unrenderable tool, not the catalog', () => {
    const schemas = toolInputSchemasFrom([
      { name: 'broken', inputSchema: { field: 'not a zod schema' } },
      { name: 'fine', inputSchema: { q: z.string() } },
    ]);
    expect(schemas.broken).toEqual({ type: 'object', properties: {} });
    expect((schemas.fine.properties as Record<string, unknown>).q).toBeDefined();
  });

  it('round-trips a connector schema back to the arguments it came from', () => {
    // Connector tools are registered as Zod converted FROM the registry's JSON
    // Schema, so this converts it back. The Anthropic path shows the model the
    // same round trip (the SDK renders the identical shapes), which is the
    // point: both engine families describe the tool the same way.
    const fromRegistry = {
      type: 'object',
      properties: {
        thread_id: { type: 'string', description: 'The thread to reply in' },
        message_body: { type: 'string' },
        cc: { type: 'array', items: { type: 'string' } },
        draft: { type: 'boolean' },
      },
      required: ['thread_id', 'message_body'],
    };

    const schemas = toolInputSchemasFrom([{
      name: 'my_gmail__reply_to_thread',
      inputSchema: extractToolShape(convertJsonSchemaToZod(fromRegistry)),
    }]);

    const schema = schemas.my_gmail__reply_to_thread;
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(props).sort()).toEqual(['cc', 'draft', 'message_body', 'thread_id']);
    expect(props.thread_id.type).toBe('string');
    expect(props.cc.type).toBe('array');
    expect((schema.required as string[]).sort()).toEqual(['message_body', 'thread_id']);
  });

  it('keeps the first registration when a name repeats', () => {
    const schemas = toolInputSchemasFrom([
      { name: 'dup', inputSchema: { first: z.string() } },
      { name: 'dup', inputSchema: { second: z.string() } },
    ]);
    expect(Object.keys(schemas.dup.properties as Record<string, unknown>)).toEqual(['first']);
  });
});
