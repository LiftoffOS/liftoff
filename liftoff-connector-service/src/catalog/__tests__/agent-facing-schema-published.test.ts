// The schema this service publishes for an overlaid tool is the agent's
// contract, not the vendor's.
//
// The overlay's translateInput supplies some vendor arguments itself and
// withholds others; the registry used to publish the raw vendor schema
// regardless, so every Gmail tool advertised `user_id` as required while the
// overlay wrote 'me' over whatever arrived, and the platform's distiller —
// validating against what this service publishes — rejected calls the runtime
// would have dispatched. The derivation lives in the overlays package; this
// asserts the registry actually uses it, on the tools that carried the defect.

import { getConnectorFunctions } from '../connector-functions-registry.js';

const gmail = () => getConnectorFunctions('google_mail');
const fn = (name: string) => {
  const f = gmail().find((f) => f.name === name);
  if (!f) throw new Error(`google_mail.${name} is not published`);
  return f;
};

describe('published Gmail schemas are agent-facing', () => {
  it('never advertises user_id, which the overlay supplies', () => {
    for (const f of gmail()) {
      expect(Object.keys(f.inputSchema.properties ?? {})).not.toContain('user_id');
      expect(f.inputSchema.required ?? []).not.toContain('user_id');
    }
  });

  it('mark_as_read asks only for the thread; the label ids are the ack', () => {
    const f = fn('mark_as_read');
    expect(Object.keys(f.inputSchema.properties ?? {})).toEqual(['thread_id']);
    expect(f.inputSchema.required).toEqual(['thread_id']);
  });

  it('carries the descriptions the vendor schema left bare', () => {
    const f = fn('get_thread');
    const thread = f.inputSchema.properties?.thread_id as { description?: string } | undefined;
    expect(thread?.description).toMatch(/THREAD id/);
  });

  it('list_messages advertises query, not the vendor-only user_id', () => {
    const f = fn('list_messages');
    expect(Object.keys(f.inputSchema.properties ?? {})).toContain('query');
    expect(f.inputSchema.required ?? []).toEqual([]);
  });
});
