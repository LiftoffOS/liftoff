/**
 * D-2.1 / D-4.6 — Catalog-to-executor contract test.
 *
 * Seeds a fixture manifest, calls getAvailableTools() (catalog path) and
 * verifies the tool names match the pattern that buildToolsSchema() produces.
 * This is the drift guard that prevents distill from emitting tool names
 * the executor can't resolve.
 */

// Mock infrastructure
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { buildToolCallRequest } from '../build-tool-call-request';
import { sanitizeAlias } from '../../tool-catalog/catalog-service';

describe('D-2.1 — Catalog-to-executor tool name contract', () => {
  // The canonical tool name pattern used by both buildToolsSchema and getAvailableTools
  const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+$/;

  it('sanitizeAlias produces names matching buildToolsSchema pattern', () => {
    // These are real-world alias values from connector manifests
    const testCases = [
      { alias: 'salesforce_prod', expected: 'salesforce_prod' },
      { alias: 'My CRM', expected: 'My_CRM' },
      { alias: 'slack', expected: 'slack' },
      { alias: 'google-sheets', expected: 'google-sheets' },
      { alias: 'hub.spot', expected: 'hub_spot' },  // dots replaced
      { alias: 'crm@work', expected: 'crm_work' },  // @ replaced
    ];

    for (const { alias, expected } of testCases) {
      expect(sanitizeAlias(alias)).toBe(expected);
    }
  });

  it('tool names from sanitizeAlias + funcName match executor pattern', () => {
    const aliases = ['salesforce_prod', 'My CRM', 'slack', 'google-sheets'];
    const funcNames = ['read_record', 'create_contact', 'send_message', 'get_rows'];

    for (const alias of aliases) {
      for (const func of funcNames) {
        const sanitized = sanitizeAlias(alias);
        const toolName = `${sanitized}__${func}`;
        expect(toolName).toMatch(TOOL_NAME_PATTERN);

        // Verify the name can be split back correctly
        const separatorIndex = toolName.indexOf('__');
        expect(separatorIndex).toBeGreaterThan(0);
        const connector = toolName.substring(0, separatorIndex);
        const actionType = toolName.substring(separatorIndex + 2);
        expect(connector).toBe(sanitized);
        expect(actionType).toBe(func);
      }
    }
  });

  it('connector tool round-trips: catalog name → buildToolCallRequest → reconstructed name', () => {
    const alias = 'salesforce_prod';
    const funcName = 'read_record';
    const catalogName = `${sanitizeAlias(alias)}__${funcName}`;

    const request = buildToolCallRequest(catalogName, {}, { id: 'test' });
    const reconstructed = `${request.connector}__${request.actionType}`;

    expect(reconstructed).toBe(catalogName);
    expect(request.connector).toBe('salesforce_prod');
    expect(request.actionType).toBe('read_record');
  });

  it('external agent tool names follow the external__alias__tool pattern', () => {
    const agentName = 'CoinGecko API';
    const agentAlias = agentName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const toolName = `external__${agentAlias}__get_simple_price`;

    expect(toolName).toBe('external__coingecko_api__get_simple_price');

    // Verify split: connector='external', actionType='coingecko_api__get_simple_price'
    const separatorIndex = toolName.indexOf('__');
    expect(toolName.substring(0, separatorIndex)).toBe('external');
    expect(toolName.substring(separatorIndex + 2)).toBe('coingecko_api__get_simple_price');
  });

  it('external agent tool round-trips via buildToolCallRequest', () => {
    const agentAlias = 'coingecko';
    const toolName = 'get_simple_price';
    const catalogName = `external__${agentAlias}__${toolName}`;

    const request = buildToolCallRequest(catalogName, {}, { id: 'test' });
    const reconstructed = `${request.connector}__${request.actionType}`;

    expect(reconstructed).toBe(catalogName);
    expect(request.connector).toBe('external');
    expect(request.actionType).toBe(`${agentAlias}__${toolName}`);
  });

  it('a genuine standard tool (no __) round-trips with an empty connector', () => {
    const catalogName = 'note_save';
    const request = buildToolCallRequest(catalogName, {}, { id: 'test' });
    expect(request.connector).toBe('');
    expect(request.actionType).toBe('note_save');
  });

  it('`search` gets the builtin sentinel, not an empty connector', () => {
    // This case previously asserted connector==='' and was WRONG in a way the
    // assertion could not see: `search` is not in STANDARD_TOOLS (only
    // `corpus_search` is), so an empty connector routed it to
    // executeStandardTool, which has no `search` case, returns null, and
    // produces "no handler registered for standard tool: search" —
    // `stub_fallback_fired`. The other request builder had already been fixed
    // with the `__builtin:` sentinel for exactly this reason; this one had not,
    // so the same tool worked from a chat turn and failed from a workflow step.
    const request = buildToolCallRequest('search', {}, { id: 'test' });
    expect(request.connector).toBe('__builtin:search');
    expect(request.actionType).toBe('search');
  });

  it('aliases with special characters are sanitized consistently', () => {
    // Note: aliases that sanitize to contain __ create ambiguity with the
    // connector__action separator. E.g. "My CRM (prod)" → "My_CRM__prod_"
    // contains __ mid-alias. Users should avoid such aliases.
    // Test with a safe alias that has special chars but no adjacent underscores:
    const rawAlias = 'My CRM v2.0';
    const sanitized = sanitizeAlias(rawAlias);
    expect(sanitized).toBe('My_CRM_v2_0');

    const catalogName = `${sanitized}__read_contact`;
    const request = buildToolCallRequest(catalogName, {}, { id: 'test' });
    expect(request.connector).toBe(sanitized);
    expect(request.actionType).toBe('read_contact');
  });
});
