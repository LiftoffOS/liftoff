/**
 * Phase 4 — buildToolCallRequest tests: tool name parsing for connector/action
 * extraction, covering standard connectors, external agents, system tools,
 * and aliased tool names with underscores.
 */

import { buildToolCallRequest } from '../build-tool-call-request';

describe('Phase 4 — buildToolCallRequest', () => {
  it('parses standard connector tool: salesforce_prod__read_record', () => {
    const result = buildToolCallRequest(
      'salesforce_prod__read_record',
      { id: '123' },
      { id: 'tc-1' },
    );
    expect(result).toEqual({
      id: 'tc-1',
      connector: 'salesforce_prod',
      entityType: 'workflow',
      actionType: 'read_record',
      payload: { id: '123' },
    });
  });

  it('parses external agent tool: external__coingecko__get_simple_price', () => {
    const result = buildToolCallRequest(
      'external__coingecko__get_simple_price',
      { coin: 'btc' },
      { id: 'tc-2' },
    );
    expect(result).toEqual({
      id: 'tc-2',
      connector: 'external',
      entityType: 'workflow',
      actionType: 'coingecko__get_simple_price',
      payload: { coin: 'btc' },
    });
  });

  it('routes `search` to its builtin dispatcher, not the standard-tool path', () => {
    // Was asserted as connector:'' — which sent `search` to executeStandardTool,
    // which has no `search` case (it is not even in STANDARD_TOOLS; only
    // `corpus_search` is), so it returned null and fired stub_fallback. The
    // sibling request builder already tagged it `__builtin:search`; this one
    // did not, so the same tool worked from chat and failed from a workflow step.
    const result = buildToolCallRequest(
      'search',
      { query: 'test' },
      { id: 'tc-3' },
    );
    expect(result).toEqual({
      id: 'tc-3',
      connector: '__builtin:search',
      entityType: 'workflow',
      actionType: 'search',
      payload: { query: 'test' },
    });
  });

  it('parses tool with underscores in alias: my_crm__read_contact', () => {
    const result = buildToolCallRequest(
      'my_crm__read_contact',
      { email: 'a@b.com' },
      { id: 'tc-4' },
    );
    expect(result).toEqual({
      id: 'tc-4',
      connector: 'my_crm',
      entityType: 'workflow',
      actionType: 'read_contact',
      payload: { email: 'a@b.com' },
    });
  });

  it('parses tool with underscores in function name: slack__send_message', () => {
    const result = buildToolCallRequest(
      'slack__send_message',
      { channel: '#general' },
      { id: 'tc-5' },
    );
    expect(result).toEqual({
      id: 'tc-5',
      connector: 'slack',
      entityType: 'workflow',
      actionType: 'send_message',
      payload: { channel: '#general' },
    });
  });

  it('uses custom entityType when provided', () => {
    const result = buildToolCallRequest(
      'slack__send_message',
      {},
      { id: 'tc-6', entityType: 'custom' },
    );
    expect(result.entityType).toBe('custom');
  });

  it('uses standard entityType for system tools without explicit entityType', () => {
    const result = buildToolCallRequest(
      'memory_save',
      {},
      { id: 'tc-7' },
    );
    expect(result.entityType).toBe('standard');
    expect(result.connector).toBe('');
    expect(result.actionType).toBe('memory_save');
  });
});
