// A tool_call cannot declare `outputField`, because nothing here knows the
// response shape.
//
// The catalog carries `input_schema` and nothing else: arguments are checkable,
// responses are not. So an outputField on a tool_call names a key the model has
// never been shown — and the runtime treats a miss as a hard failure, so the
// step fails on a call that actually SUCCEEDED and the graph takes its
// onFailure branch.
//
// Example: a step calls `list_messages`, which returns 201 with
// `success: true`, and the step fails on
// `outputField "messages" did not resolve in tool result`. The real envelope
// is `{"items": [...]}` — neither `messages` nor connector-service's `records`.
// A one-in-many chance with no way to check.

jest.mock('../../llm/client', () => ({ llmClient: { complete: jest.fn() } }));
jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: { getTenantManifests: jest.fn(), getToolCatalog: jest.fn() },
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { findGuessedToolOutputFields } from '../distill-service';
import type { ToolCatalog } from '../distill-service';

 
const steps = (rows: Array<Record<string, unknown>>) => rows as any;

const GMAIL = new Map([
  ['google-mail-0105297e__list_messages', { name: 'google-mail-0105297e__list_messages', description: '' }],
  ['google-mail-0105297e__get_thread', { name: 'google-mail-0105297e__get_thread', description: '' }],
]) as ToolCatalog;

describe('the step that failed on a successful call', () => {
  it('rejects the exact s2 that shipped', () => {
    const out = findGuessedToolOutputFields(
      steps([{ stepId: 's2', type: 'tool_call', toolName: 'google-mail-0105297e__list_messages', outputField: 'messages' }]),
      GMAIL,
    );
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('tool_output_field_guessed');
    expect(out[0].stepId).toBe('s2');
  });

  it('says why the field cannot be known, and what to do instead', () => {
    const [err] = findGuessedToolOutputFields(
      steps([{ stepId: 's2', toolName: 'google-mail-0105297e__list_messages', outputField: 'messages' }]),
      GMAIL,
    );
    expect(err.detail).toMatch(/INPUT parameters only/i);
    expect(err.detail).toMatch(/hard step failure even when the call itself succeeded/i);
    // The replacement has to be stated or the model will simply pick another key.
    expect(err.detail).toMatch(/whole result becomes its output/i);
    expect(err.detail).toMatch(/llm_reason/);
  });
});

describe('what it must not fire on', () => {
  it('leaves llm_reason outputField alone — the model defines that shape itself', () => {
    // llm_reason returns its value through record_step_output, so the key is the
    // step's own contract rather than a vendor's envelope.
    expect(findGuessedToolOutputFields(
      steps([{ stepId: 's3', type: 'llm_reason', outputField: 'category' }]),
      GMAIL,
    )).toEqual([]);
  });

  it('accepts a tool_call with no outputField', () => {
    expect(findGuessedToolOutputFields(
      steps([{ stepId: 's1', type: 'tool_call', toolName: 'google-mail-0105297e__get_thread' }]),
      GMAIL,
    )).toEqual([]);
  });

  it('allows a path the catalog actually declares', () => {
    // Loosens by itself the moment response schemas reach the catalog, instead
    // of needing to be rediscovered and revisited.
    const withSchema = new Map([
      ['gmail__list_messages', {
        name: 'gmail__list_messages',
        description: '',
        response_schema: { properties: { items: { type: 'array' } } },
      }],
    ]) as unknown as ToolCatalog;
    expect(findGuessedToolOutputFields(
      steps([{ stepId: 's2', type: 'tool_call', toolName: 'gmail__list_messages', outputField: 'items' }]),
      withSchema,
    )).toEqual([]);
    // ...but still rejects a path that schema does NOT declare.
    expect(findGuessedToolOutputFields(
      steps([{ stepId: 's2', type: 'tool_call', toolName: 'gmail__list_messages', outputField: 'messages' }]),
      withSchema,
    )).toHaveLength(1);
  });

  it('treats a step with no explicit type as the tool_call it defaults to', () => {
    expect(findGuessedToolOutputFields(
      steps([{ stepId: 's2', toolName: 'google-mail-0105297e__list_messages', outputField: 'messages' }]),
      GMAIL,
    )).toHaveLength(1);
  });
});
