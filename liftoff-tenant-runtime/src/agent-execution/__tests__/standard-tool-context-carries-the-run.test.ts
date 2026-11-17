// Two builders hand a standard tool its context: the MCP server's, for the
// engines that call through the catalog, and the dispatcher's, for a workflow
// step, a recovery re-dispatch and every approved replay. What a handler reads
// off the context must be on BOTH, or a tool behaves differently by the path
// it arrived on: an approved replay of run_browser_task runs its Stagehand tail
// on the platform default with another provider's key if only the MCP server's
// builder carries resolvedProvider.

import { readFileSync } from 'fs';
import { join } from 'path';

const dispatcher = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');
const mcpServer = readFileSync(join(__dirname, '..', '..', 'tool-gateway', 'mcp-server.ts'), 'utf8');

/** The dispatcher's executeStandardTool call: the object literal it passes. */
const dispatcherContext = (() => {
  const at = dispatcher.indexOf('() => executeStandardTool(');
  expect(at).toBeGreaterThan(0);
  return dispatcher.slice(at, dispatcher.indexOf('{ toolName: toolCall.actionType }', at));
})();

/** The MCP server's stdToolCtx literal. */
const serverContext = (() => {
  const at = mcpServer.indexOf('const stdToolCtx: StandardToolContext = {');
  expect(at).toBeGreaterThan(0);
  return mcpServer.slice(at, mcpServer.indexOf('};', at));
})();

describe('the fields a handler reads off its context are on both builders', () => {
  it.each(['resolvedProvider', 'contract', 'invocationId', 'threadId', 'memoryScope', 'messageSenderAccountId'])('%s', (field) => {
    expect(dispatcherContext).toContain(field);
    expect(serverContext).toContain(field);
  });
});
