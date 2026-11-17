// The published schema IS the contract, and the translators honour it in
// both directions.
//
// A consumer publishes agentFacingInputSchema(vendor, overlay): the vendor
// schema minus what the overlay supplies itself, with descriptions filled in.
// Two things can make that contract a lie, and each is a fleet-wide ratchet
// here rather than a Gmail fix:
//
//   1. The schema advertises an argument that translateInput then discards —
//      create_label advertised `label_name` and read `name`; a schema-valid
//      call lost its one argument on the way to the vendor.
//   2. The schema requires an argument the overlay supplies on its own —
//      `user_id` on every Gmail tool, written as 'me' over whatever arrived,
//      yet advertised as required, so the distiller rejected calls the runtime
//      would have dispatched.
//
// Test 1 drives a sentinel per advertised property through translation and
// asserts every one reaches the vendor args. Test 2 runs translateInput on an
// empty input and asserts nothing it fills is still required.

import { COMPOSIO_TOOL_SCHEMAS } from '../schemas';
import { COMPOSIO_TOOL_OVERLAYS } from '../overlays';
import { agentFacingInputSchema } from '../agent-facing-schema';
import type { ComposioToolOverlay, ComposioVendorSchema } from '../types';

function pairs(): Array<[string, ComposioVendorSchema, ComposioToolOverlay]> {
  const out: Array<[string, ComposioVendorSchema, ComposioToolOverlay]> = [];
  for (const [toolkit, schemas] of Object.entries(COMPOSIO_TOOL_SCHEMAS)) {
    const overlays = COMPOSIO_TOOL_OVERLAYS[toolkit] ?? {};
    for (const schema of schemas) {
      const overlay = overlays[schema.slug];
      if (overlay?.translateInput) out.push([`${toolkit}.${overlay.stableName}`, schema, overlay]);
    }
  }
  return out;
}

/** Keys translateInput produces with a value when handed nothing: what the
 *  overlay supplies on its own, plus defaults it applies to agent-settable
 *  arguments. */
function filledFromNothing(overlay: ComposioToolOverlay): string[] {
  let out: Record<string, unknown>;
  try {
    out = overlay.translateInput!({});
  } catch {
    return [];
  }
  return Object.entries(out).filter(([, v]) => v !== undefined && v !== null).map(([k]) => k);
}

/** Every value in a translated args object, at any depth: a sentinel may be
 *  moved into a nested structure and still count as delivered. */
function leafValues(value: unknown, into: unknown[] = []): unknown[] {
  if (Array.isArray(value)) value.forEach((v) => leafValues(v, into));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => leafValues(v, into));
  else into.push(value);
  return into;
}

describe('agentFacingInputSchema', () => {
  it('removes owned arguments from properties and required, and fills descriptions', () => {
    const published = agentFacingInputSchema(
      {
        type: 'object',
        properties: { user_id: { type: 'string' }, thread_id: { type: 'string' }, note: { type: 'string', description: 'kept' } },
        required: ['user_id', 'thread_id'],
      },
      { overlayOwnedArgs: ['user_id'], argDescriptions: { thread_id: 'the thread' } },
    );
    expect(Object.keys(published.properties)).toEqual(['thread_id', 'note']);
    expect(published.required).toEqual(['thread_id']);
    expect(published.properties.thread_id).toEqual({ type: 'string', description: 'the thread' });
    expect(published.properties.note).toEqual({ type: 'string', description: 'kept' });
  });

  it('keeps a defaulted argument settable but never required', () => {
    const published = agentFacingInputSchema(
      { type: 'object', properties: { channel: { type: 'string' }, name: { type: 'string' } }, required: ['channel', 'name'] },
      { defaultedArgs: ['name'] },
    );
    expect(Object.keys(published.properties)).toEqual(['channel', 'name']);
    expect(published.required).toEqual(['channel']);
  });

  it('is the vendor schema unchanged for an overlay that declares nothing', () => {
    const vendor = { type: 'object' as const, properties: { q: { type: 'string' } }, required: ['q'] };
    expect(agentFacingInputSchema(vendor, {})).toEqual(vendor);
  });
});

describe('every advertised argument reaches the vendor through translateInput', () => {
  it.each(pairs())('%s', (_name, schema, overlay) => {
    const published = agentFacingInputSchema(schema.inputSchema, overlay);
    const sentinel: Record<string, unknown> = {};
    for (const key of Object.keys(published.properties)) sentinel[key] = `<${key}>`;
    const delivered = new Set(leafValues(overlay.translateInput!(sentinel)));
    const discarded = Object.keys(published.properties).filter((key) => !delivered.has(`<${key}>`));
    expect(discarded).toEqual([]);
  });
});

describe('no published schema requires what the overlay fills in on its own', () => {
  it.each(pairs())('%s', (_name, schema, overlay) => {
    const published = agentFacingInputSchema(schema.inputSchema, overlay);
    const filled = filledFromNothing(overlay);
    const stillRequired = (published.required ?? []).filter((key) => filled.includes(key));
    expect(stillRequired).toEqual([]);
  });
});

describe('what the overlay owns is really its own', () => {
  // A declared owned argument that translateInput would have forwarded from
  // the agent is a capability hidden by declaration rather than by design;
  // an owned argument must be one the translator sets itself or never emits.
  it.each(pairs())('%s', (_name, schema, overlay) => {
    const owned = overlay.overlayOwnedArgs ?? [];
    if (owned.length === 0) return;
    const sentinel: Record<string, unknown> = {};
    for (const key of owned) sentinel[key] = `<${key}>`;
    const forwarded = new Set(leafValues(overlay.translateInput!(sentinel)));
    const leaked = owned.filter((key) => forwarded.has(`<${key}>`));
    expect(leaked).toEqual([]);
  });
});
