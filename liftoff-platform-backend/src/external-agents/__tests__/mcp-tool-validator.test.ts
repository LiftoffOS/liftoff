/**
 * Tests for the MCP tool schema validator.
 *
 * This validator runs during MCPClient.discover() before any tools are
 * persisted to external_agents.raw_mcp_tools. It guards against the
 * symmetric bug class to the tenant runtime's connector-functions
 * registry: an MCP server returning a tool schema that's syntactically
 * valid JSON but invalid for OpenAI/Anthropic tool calling.
 *
 * The two specific bug classes guarded against:
 *
 *   1. type:'array' without items — JSON Schema considers items optional,
 *      but OpenAI's tool API rejects bare arrays at request time. Our
 *      custom recursive walker catches this; ajv alone does not.
 *
 *   2. General JSON Schema invalidity (bad type values, malformed enum,
 *      broken nested $ref) — ajv catches this.
 */

import {
  validateMcpTools,
  formatViolations,
  McpToolSchemaValidationError,
} from '../mcp-tool-validator';
import { classifyMcpTools } from '../../mcp/tool-validator';
import type { MCPToolDefinition } from '../types';

describe('mcp-tool-validator', () => {
  describe('validateMcpTools', () => {
    it('returns empty array for an empty tool list', () => {
      expect(validateMcpTools([])).toEqual([]);
    });

    it('returns empty array for a well-formed tool', () => {
      const tools: MCPToolDefinition[] = [
        {
          name: 'get_price',
          description: 'Get the current BTC price',
          inputSchema: {
            type: 'object',
            properties: {
              currency: { type: 'string' },
            },
            required: ['currency'],
          },
        },
      ];
      expect(validateMcpTools(tools)).toEqual([]);
    });

    it('returns empty array for a tool with arrays that have items', () => {
      const tools: MCPToolDefinition[] = [
        {
          name: 'send_batch',
          inputSchema: {
            type: 'object',
            properties: {
              recipients: {
                type: 'array',
                items: { type: 'string' },
              },
              messages: {
                type: 'array',
                items: { type: 'object' },
              },
            },
          },
        },
      ];
      expect(validateMcpTools(tools)).toEqual([]);
    });

    it('rejects type:array without items at the top property level', () => {
      const tools: MCPToolDefinition[] = [
        {
          name: 'broken_tool',
          inputSchema: {
            type: 'object',
            properties: {
              // Cast through unknown to construct the bad shape that the
              // type now prohibits — we're simulating an MCP server
              // returning malformed JSON, not constructing it in TypeScript.
              recipients: { type: 'array' } as unknown as never,
            },
          },
        },
      ];
      const violations = validateMcpTools(tools);
      expect(violations).toHaveLength(1);
      expect(violations[0].toolName).toBe('broken_tool');
      expect(violations[0].path).toBe('inputSchema.recipients');
      expect(violations[0].error).toContain('type:array missing items');
    });

    it('rejects type:array without items at nested array depth', () => {
      const tools: MCPToolDefinition[] = [
        {
          name: 'broken_2d',
          inputSchema: {
            type: 'object',
            properties: {
              matrix: {
                type: 'array',
                items: { type: 'array' } as unknown as never,
              },
            },
          },
        },
      ];
      const violations = validateMcpTools(tools);
      expect(violations).toHaveLength(1);
      expect(violations[0].path).toBe('inputSchema.matrix.items');
    });

    it('reports multiple violations across multiple tools in one pass', () => {
      const tools: MCPToolDefinition[] = [
        {
          name: 'tool_a',
          inputSchema: {
            type: 'object',
            properties: {
              arr1: { type: 'array' } as unknown as never,
            },
          },
        },
        {
          name: 'tool_b',
          inputSchema: {
            type: 'object',
            properties: {
              arr2: { type: 'array' } as unknown as never,
              arr3: { type: 'array' } as unknown as never,
            },
          },
        },
      ];
      const violations = validateMcpTools(tools);
      expect(violations).toHaveLength(3);
      const names = violations.map((v) => v.toolName);
      expect(names).toContain('tool_a');
      expect(names.filter((n) => n === 'tool_b')).toHaveLength(2);
    });

    it('rejects a tool with no name', () => {
      const tools: MCPToolDefinition[] = [
        {
          name: '' as string,
          inputSchema: { type: 'object' },
        },
      ];
      const violations = validateMcpTools(tools);
      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(violations[0].error).toContain('name');
    });

    it('rejects a tool with missing inputSchema', () => {
      const tools: MCPToolDefinition[] = [
        {
          name: 'no_schema_tool',
          // @ts-expect-error — simulating malformed server response
          inputSchema: undefined,
        },
      ];
      const violations = validateMcpTools(tools);
      expect(violations).toHaveLength(1);
      expect(violations[0].error).toContain('inputSchema is missing');
    });

    it('accepts type:object without properties (intentional any-object)', () => {
      // Some MCP servers use type:'object' as a placeholder for "an opaque
      // object payload" — OpenAI's tool API accepts this, so we must too.
      const tools: MCPToolDefinition[] = [
        {
          name: 'opaque_tool',
          inputSchema: {
            type: 'object',
            properties: {
              payload: { type: 'object' },
            },
          },
        },
      ];
      expect(validateMcpTools(tools)).toEqual([]);
    });
  });

  describe('formatViolations', () => {
    it('formats violations with tool name, path, and error', () => {
      const formatted = formatViolations([
        { toolName: 'foo', path: 'inputSchema.bar', error: 'type:array missing items' },
      ]);
      expect(formatted).toContain('foo');
      expect(formatted).toContain('inputSchema.bar');
      expect(formatted).toContain('type:array missing items');
    });
  });

  describe('McpToolSchemaValidationError', () => {
    it('captures violations on the error object', () => {
      const violations = [
        { toolName: 'x', path: 'inputSchema.y', error: 'bad' },
      ];
      const err = new McpToolSchemaValidationError(violations);
      expect(err.violations).toBe(violations);
      expect(err.name).toBe('McpToolSchemaValidationError');
      expect(err.message).toContain('1 invalid tool schema');
      expect(err.message).toContain('x');
      expect(err.message).toContain('inputSchema.y');
    });

    it('is catchable as Error', () => {
      try {
        throw new McpToolSchemaValidationError([
          { toolName: 'x', path: 'p', error: 'e' },
        ]);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
        expect(e).toBeInstanceOf(McpToolSchemaValidationError);
      }
    });
  });
});

// MCP 2026-07-28: classification never throws (no whole-server hard reject).
// A tool the LLM tool API can't consume is degraded; the rest stay usable.
describe('classifyMcpTools (INV-PB-008 no-hard-reject)', () => {
  it('keeps a plain draft-07 tool usable', () => {
    const tools: MCPToolDefinition[] = [
      { name: 'ok', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } },
    ];
    const { usableTools, degradedTools } = classifyMcpTools(tools);
    expect(usableTools.map((t) => t.name)).toEqual(['ok']);
    expect(degradedTools).toEqual([]);
  });

  it('accepts a JSON Schema 2020-12 tuple via prefixItems (no "missing items" violation)', () => {
    const tools: MCPToolDefinition[] = [
      {
        name: 'tuple_tool',
        inputSchema: {
          type: 'object',
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          properties: {
            pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] },
          },
        },
      },
    ];
    const { usableTools, degradedTools } = classifyMcpTools(tools);
    expect(usableTools.map((t) => t.name)).toEqual(['tuple_tool']);
    expect(degradedTools).toEqual([]);
  });

  it('degrades a top-level oneOf tool (Anthropic rejects it) but keeps sibling tools usable — never throws', () => {
    const tools: MCPToolDefinition[] = [
      {
        name: 'union_tool',
        // Cast: simulate a server returning a top-level composition schema.
        inputSchema: { type: 'object', oneOf: [{ required: ['a'] }, { required: ['b'] }] } as unknown as MCPToolDefinition['inputSchema'],
      },
      { name: 'good_tool', inputSchema: { type: 'object', properties: { x: { type: 'string' } } } },
    ];
    expect(() => classifyMcpTools(tools)).not.toThrow();
    const { usableTools, degradedTools } = classifyMcpTools(tools);
    expect(usableTools.map((t) => t.name)).toEqual(['good_tool']);
    expect(degradedTools).toHaveLength(1);
    expect(degradedTools[0].toolName).toBe('union_tool');
    expect(degradedTools[0].reasons.join(' ')).toContain('oneOf');
  });

  it('degrades an array with neither items nor prefixItems', () => {
    const tools: MCPToolDefinition[] = [
      {
        name: 'bare_array',
        inputSchema: { type: 'object', properties: { xs: { type: 'array' } as unknown as never } },
      },
    ];
    const { usableTools, degradedTools } = classifyMcpTools(tools);
    expect(usableTools).toEqual([]);
    expect(degradedTools).toHaveLength(1);
    expect(degradedTools[0].reasons.join(' ')).toContain('missing items');
  });
});
