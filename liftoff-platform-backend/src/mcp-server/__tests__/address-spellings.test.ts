// Both spellings of the MCP addressing argument are accepted (INV-PB-016).
//
// The vocabulary rename made `agent` the name for the thing a caller addresses,
// and `team` the retired spelling. This schema is the one piece of that rename
// which reaches software we do not ship: every connected MCP client holds a
// cached copy of it, and the CLI has written these tool names into users' own
// CLAUDE.md files on their machines. An outright rename would have made every
// installed client fail its next call with a validation error, for as long as it
// went without re-reading the schema.
//
// So this is not a transitional nicety to delete once things settle. It is the
// contract: `agent` is advertised, `team` is honoured, and neither may regress
// without this failing. The asymmetry — only `agent` carries a `.describe()` —
// is what keeps a model from learning the retired word while the door stays open
// for callers already through it.

import { ChatInput, DelegateTaskInput, ListConversationsInput, addressName } from '../types';

describe('MCP addressing accepts both spellings', () => {
  // Only the schemas that ADDRESS one agent. ListConversationsInput takes the
  // same two spellings but as a FILTER — both absent means every conversation —
  // so it carries no exactly-one rule and is checked separately below.
  const schemas: Array<[string, { safeParse: (v: unknown) => { success: boolean } }]> = [
    ['liftoff_chat', ChatInput],
    ['liftoff_delegate_task', DelegateTaskInput],
  ];

  const bodyFor = (name: string, address: Record<string, string>) =>
    name === 'liftoff_delegate_task'
      ? { ...address, objective: 'do the thing' }
      : { ...address, message: 'hello' };

  it.each(schemas)('%s accepts the new spelling', (name, schema) => {
    expect(schema.safeParse(bodyFor(name, { agent: 'Support' })).success).toBe(true);
  });

  it.each(schemas)('%s still accepts the retired spelling', (name, schema) => {
    // The case that matters: a client installed before the rename, calling with
    // the schema it cached then.
    expect(schema.safeParse(bodyFor(name, { team: 'Support' })).success).toBe(true);
  });

  it.each(schemas)('%s accepts an id instead of either name', (name, schema) => {
    expect(schema.safeParse(bodyFor(name, { agentId: '11111111-2222-3333-4444-555555555555' })).success).toBe(true);
  });

  it.each(schemas)('%s rejects a name AND an id, under either spelling', (name, schema) => {
    const id = '11111111-2222-3333-4444-555555555555';
    expect(schema.safeParse(bodyFor(name, { agent: 'Support', agentId: id })).success).toBe(false);
    expect(schema.safeParse(bodyFor(name, { team: 'Support', agentId: id })).success).toBe(false);
  });

  it.each(schemas)('%s rejects neither', (name, schema) => {
    expect(schema.safeParse(bodyFor(name, {})).success).toBe(false);
  });

  it.each(schemas)('%s treats both spellings together as ONE address', (name, schema) => {
    // Sending both is a confused caller, not a way to smuggle two addresses
    // past the exactly-one rule. It parses, and resolution picks `agent`.
    expect(schema.safeParse(bodyFor(name, { agent: 'Support', team: 'Support' })).success).toBe(true);
  });

  it('the conversation FILTER takes both spellings, and neither', () => {
    // Not an address: omitting both is how a caller asks for everything, so the
    // exactly-one rule would be wrong here rather than merely absent.
    expect(ListConversationsInput.safeParse({ agent: 'Support' }).success).toBe(true);
    expect(ListConversationsInput.safeParse({ team: 'Support' }).success).toBe(true);
    expect(ListConversationsInput.safeParse({}).success).toBe(true);
  });

  it('resolves the new spelling first when a caller sends both', () => {
    expect(addressName({ agent: 'Support', team: 'Sales' })).toBe('Support');
    expect(addressName({ team: 'Sales' })).toBe('Sales');
    expect(addressName({})).toBeUndefined();
  });

  it('advertises only the new spelling to a model', () => {
    // A description is what a model reads. The retired spelling carries none,
    // so it cannot be learned from the tool manifest even while it is accepted.
    const shape = (ChatInput as unknown as { _def: { schema: { shape: Record<string, { description?: string }> } } })
      ._def.schema.shape;
    expect(shape.agent.description).toBeTruthy();
    expect(shape.team.description).toBeUndefined();
  });
});
