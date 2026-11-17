// The SDK-version watch for tool-argument deltas on the OpenAI Agents SDK.
//
// The openai-wire adapter emits `tool_call_partial` by reading the SDK's raw
// `model` events — the Responses API's `function_call_arguments.delta`, Chat
// Completions' `delta.tool_calls[]` — because the SDK's TYPED stream union
// carries no argument-delta member (openai-wire/argument-deltas.ts). Both
// halves of that are facts about the INSTALLED version, and a dependency bump
// is the one thing that changes them without touching this tree: a typed
// member arriving means the per-provider raw correlation can give way to it,
// and the generic member disappearing means the raw route is gone. This reads
// the union off the installed package, so either change fails here and names
// the work it unlocks or removes, rather than being noticed in a stream that
// quietly stopped carrying fragments.

import { protocol } from '@openai/agents';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';

/** The `type` literal of every member of the installed StreamEvent union. */
function installedStreamEventTypes(): string[] {
  const union = protocol.StreamEvent as unknown as {
    options: Array<{ shape: { type: { value?: string; _def?: { value?: string } } } }>;
  };
  return union.options.map((o) => o.shape.type.value ?? o.shape.type._def?.value ?? '?');
}

const ARGUMENT_DELTA_SHAPES = /function_call_arguments|tool_call_arguments|arguments_delta|tool_arguments/i;

describe('the OpenAI Agents SDK stream union, as installed', () => {
  const types = installedStreamEventTypes();

  it('is read off the package, not written out', () => {
    // A union with no members would make every assertion below vacuous.
    expect(types.length).toBeGreaterThanOrEqual(3);
    expect(types).toContain('output_text_delta');
  });

  it('carries no typed tool-argument delta — why the openai-wire adapter reads the raw events', () => {
    // When this fails, the SDK now streams argument deltas as a typed member:
    // move the openai-wire correlation (openai-wire/argument-deltas.ts) onto
    // it, drop the per-provider raw parsing, and pin the member here by name
    // so the next bump cannot take it away silently.
    const typed = types.filter((t) => ARGUMENT_DELTA_SHAPES.test(t));
    expect(typed).toEqual([]);
  });

  it('still forwards raw provider events through its generic member', () => {
    // The route the wire adapter's correlation reads. An SDK that stops
    // forwarding raw events closes the only path an argument delta has on
    // these engines today, and `tool_call_partial` would silently stop.
    expect(types).toContain('model');
  });

  it('names the version it was read against', () => {
    // The version this watch was last reconciled with. A bump that changes
    // the union fails the assertions above; a bump that does not still moves
    // this number, so the reconciliation is recorded rather than assumed.
    // The export map does not serve package.json; walk up from the entry
    // point the way node resolved it.
    let dir = dirname(require.resolve('@openai/agents'));
    while (!dir.endsWith(`${join('@openai', 'agents')}`)) dir = dirname(dir);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string };
    expect(pkg.version).toBe('0.18.0');
  });
});
