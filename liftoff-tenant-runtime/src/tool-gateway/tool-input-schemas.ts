// The JSON Schema each in-process tool declares, keyed by tool name.
//
// Two engine families read a tool's arguments from different places. The Claude
// Agent SDK mounts the live `McpServer` and derives every schema from the Zod
// shape the tool was registered with. Every other engine reads
// `McpToolCatalog.tools[].inputSchema` — a plain JSON Schema — and that field
// needs a source, because `ModelTool` carries the shape as Zod (and carries it
// for only a handful of tools) while the wire wants JSON Schema for all of them.
//
// This is that source: one conversion, over the SAME array that is handed to
// `createSdkMcpServer`, so the two families cannot describe a tool differently.
// A tool the model is shown without its arguments is not a degraded tool, it is
// an uncallable one — the model has to invent argument names, and a required
// argument it guesses wrong is rejected identically on every retry until the
// turn budget runs out.
//
// Conversion failure is per tool and never throws: a shape that cannot be
// rendered leaves that one tool without a schema, exactly as before, rather
// than costing the run its whole catalog.

import { z } from 'zod';
import { logger } from '../infrastructure/logging';

/** The half of `SdkMcpToolDefinition` this reads. Structural rather than
 *  imported so the diagnostics catalogs, which build their tool lists by hand,
 *  can pass their own arrays through the same conversion. */
export interface SchemaBearingTool {
  name: string;
  /** The Zod RAW SHAPE the tool was registered with (`{ field: z.string() }`),
   *  which is what `tool()` stores. Absent on a hand-built entry. */
  inputSchema?: unknown;
}

/** JSON Schema for a tool that declares no arguments. Stated explicitly rather
 *  than left as `{}`: an empty object still has to say it is an object, or the
 *  model is choosing a shape as well as a value. */
const NO_ARGUMENTS: Record<string, unknown> = { type: 'object', properties: {} };

/**
 * Convert every tool's registered Zod shape to JSON Schema, keyed by tool name.
 *
 * `io: 'input'` because this describes what the model SENDS. `unrepresentable:
 * 'any'` keeps a schema that contains one un-renderable node (a `z.custom()`,
 * say) from failing the whole tool — the node widens to "any" and every other
 * field keeps its constraints.
 */
export function toolInputSchemasFrom(
  tools: readonly SchemaBearingTool[],
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const t of tools) {
    if (!t.name || out[t.name]) continue;
    const shape = t.inputSchema;
    if (shape == null || typeof shape !== 'object') {
      out[t.name] = { ...NO_ARGUMENTS };
      continue;
    }
    try {
      // Copied, because what `toJSONSchema` returns is not only a document.
      // Zod attaches a non-enumerable `~standard` to it — a validator with the
      // document's own `jsonSchema` behind it — so the object IS a Standard
      // Schema, and a consumer that recognises validators (the OpenAI Agents
      // SDK's `tool()`, which then insists on strict mode) treats it as one.
      // The wire wants the document. A spread keeps own enumerable keys only,
      // which is exactly the document and nothing attached to it.
      const json: Record<string, unknown> = {
        ...z.toJSONSchema(z.object(shape as z.ZodRawShape), {
          io: 'input',
          unrepresentable: 'any',
        }),
      };
      // `$schema` is metadata about the document, not about the arguments.
      // Provider function-calling endpoints accept a bare schema and some
      // reject unknown top-level keys, so it is dropped rather than gambled on.
      delete json.$schema;
      out[t.name] = json;
    } catch (err) {
      logger.warn(
        { tool: t.name, err: (err as Error).message },
        'tool input schema could not be rendered as JSON Schema — this tool reaches non-Anthropic engines without its arguments',
      );
      out[t.name] = { ...NO_ARGUMENTS };
    }
  }
  return out;
}
