// The persistence-boundary pass for a browser tool call, enumerated over
// every browser tool name: a synthetic protected literal is absent from what
// would become invocation evidence, and an ordinary business value remains
// in the replay record.

import { safeBrowserToolCallForPersistence, BROWSER_TOOL_NAMES, isBrowserToolName } from '../browser-tool-persistence';
import { STANDARD_TOOLS } from '../standard-tools';
import { _BROWSER_TOOL_RECORDING } from '../standard-tool-handler';

const SECRET = 'hunter2-synthetic-secret';
const BUSINESS = 'jane.doe@acme.example';

describe('the browser tool names', () => {
  it('cover every browser tool in the catalog and the recording allow-list, and nothing else', () => {
    const catalog = STANDARD_TOOLS.map((t) => t.name).filter((n) => /browser/.test(n) && !/^browser_/.test(n) && !/^web_/.test(n)).sort();
    expect([...BROWSER_TOOL_NAMES].sort()).toEqual(catalog);
    expect([...BROWSER_TOOL_NAMES].sort()).toEqual(Object.keys(_BROWSER_TOOL_RECORDING).sort());
    expect(isBrowserToolName('web_fetch_advanced')).toBe(false);
    expect(isBrowserToolName('run_browser_task')).toBe(true);
  });
});

describe('safeBrowserToolCallForPersistence', () => {
  it.each(BROWSER_TOOL_NAMES)('%s: a protected literal in the arguments and output is absent, an ordinary value remains', (name) => {
    const call = {
      id: 'tu_1',
      name,
      input: {
        prompt: `sign in for ${BUSINESS} with password=${SECRET} then read the page`,
        url: `https://a.example/reset-password/3f2a91b8c07d4e659a1b0d3e5f7a9b1c?token=${SECRET}&owner=${BUSINESS}`,
        initial_url: `https://a.example/x?api_key=${SECRET}`,
        full_page: true,
      },
      output: { message: `done with password=${SECRET} for ${BUSINESS}`, lastActions: [{ action: `type password=${SECRET}` }] },
      error: undefined,
    };
    const safe = safeBrowserToolCallForPersistence(call);
    const text = JSON.stringify(safe);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('3f2a91b8c07d4e659a1b0d3e5f7a9b1c');
    expect(text).toContain(BUSINESS);
    expect(safe.input.full_page).toBe(true);
    expect(safe.input.promptProtectedDataOmitted).toBe(true);
    expect(safe.input.urlProtectedDataOmitted).toBe(true);
    expect(safe.input.initial_urlProtectedDataOmitted).toBe(true);
    expect(safe.id).toBe('tu_1');
    expect(safe.name).toBe(name);
  });

  it('leaves a call that is not a browser tool exactly as it came', () => {
    const call = { id: 'tu_2', name: 'web_search', input: { query: `password=${SECRET}` }, output: { hits: 1 }, error: undefined };
    expect(safeBrowserToolCallForPersistence(call)).toBe(call);
  });

  it('adds no marker when nothing changed', () => {
    const call = { id: 'tu_3', name: 'navigate_browser_session', input: { url: 'https://a.example/issues?q=browser' }, output: { url: 'https://a.example/issues?q=browser' }, error: undefined };
    const safe = safeBrowserToolCallForPersistence(call);
    expect(safe.input).toEqual({ url: 'https://a.example/issues?q=browser' });
    expect(safe.output).toEqual({ url: 'https://a.example/issues?q=browser' });
  });

  it('leaves an undefined output undefined', () => {
    const safe = safeBrowserToolCallForPersistence({ id: 'x', name: 'get_browser_session_stats', input: {}, output: undefined, error: 'boom' });
    expect(safe.output).toBeUndefined();
    expect(safe.error).toBe('boom');
  });
});
