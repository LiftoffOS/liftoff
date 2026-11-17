// A chat turn and a scheduled run must expose the same workspace, with one
// declared exception.
//
// Source scan: the fill under test sits inside the chat HTTP handler, several
// hundred lines past database, entitlements and HITL lookups, and the property
// is structural — that the call site derives the capabilities from the tier
// rather than leaving the optional parameter undefined. The hop it feeds
// (buildChatToolCatalog → gateway) is covered behaviourally in
// agent-execution/__tests__/build-chat-tool-catalog-forwarding.test.ts, and the
// exception itself in agent-execution/__tests__/chat-sandbox-capabilities.test.ts.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'chat-turn-handler.ts'), 'utf8');

/** The buildChatToolCatalog argument object, brace-matched from the call to its
 *  closing brace. A line regex or a search for the first `});` reads the end of
 *  a NESTED call as the end of the arguments, so it silently scans a prefix. */
function catalogCallArgs(): string {
  const start = SRC.indexOf('agentExecutionService.buildChatToolCatalog({');
  expect(start).toBeGreaterThan(-1);
  const open = SRC.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) return SRC.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced buildChatToolCatalog argument object');
}

describe('the chat catalog is built with the agent capability tier', () => {
  it('passes sandboxCapabilities at the call site', () => {
    // sandboxCapabilities is optional on buildChatToolCatalog, so omitting it
    // is not a type error — it silently yields a catalog with no sandbox tool.
    expect(catalogCallArgs()).toContain('sandboxCapabilities:');
  });

  it('derives them from the tier rather than a hardcoded list', () => {
    // chatSandboxCapabilities is tier-derived by construction (it calls
    // sandboxCapabilitiesForTier); what matters here is that the TIER is what
    // reaches it, so chat cannot drift onto a list of its own.
    expect(catalogCallArgs()).toMatch(
      /sandboxCapabilities:\s*chatSandboxCapabilities\(\{[\s\S]*?tier:\s*instruction\.capabilityTier/,
    );
  });

  it('imports the helper it calls', () => {
    // Tolerant of what else is destructured alongside it: this asserts that the
    // helper is imported from the service, not that it is the last name in the
    // list. Pinning the position made adding a sibling look like a regression.
    expect(SRC).toMatch(
      /\{[^}]*\bchatSandboxCapabilities\b[^}]*\}\s*=\s*\n?\s*await import\('\.\.\/agent-execution\/service'\)/,
    );
  });
});

describe('the one withheld capability is decided from real turn state', () => {
  it('passes both conditions, not a constant', () => {
    // Either condition hardcoded would make the withholding unconditional (an
    // agent loses the sandbox browser on every chat turn) or dead (it never
    // does), and both read as working code.
    const args = catalogCallArgs();
    expect(args).toMatch(/paneBrowserAvailable:\s*hasPaneBrowser/);
    expect(args).toMatch(/runsWorkflow:\s*workflowStepsEnabled\(\)\s*&&\s*agentMeta\.hasWorkflowSteps/);
  });

  it('feeds the prompt the SAME pane-browser value it feeds the catalog', () => {
    // The prompt tells the agent which browser it has; the catalog decides which
    // it holds. Computing them separately is how the two drift, which is the
    // defect this whole surface keeps producing.
    expect(SRC).toMatch(/hasBrowserConnector:\s*hasPaneBrowser/);
    // Both halves of "can this agent drive a browser": the connector the
    // WORKSPACE brought, or the platform's own Browser Use key. A gate that
    // asks only the first withholds a browser the platform is funding, which is
    // the same drift in the other direction.
    expect(SRC).toMatch(
      /const hasPaneBrowser\s*=\s*\n?\s*\(hasSessionBrowserConnector\(allowedConnectors\)\s*\|\|\s*await platformPaneBrowserOn\(tenantId\)\)\s*\n?\s*&&\s*!!body\.userId/,
    );
  });
});

describe('the tier the handler logs is the tier the catalog was built with', () => {
  it('logs capabilityTier alongside the tool names', () => {
    // This pairing is why the gap stayed invisible: invocation_start reported
    // capabilityTier execution_enabled next to a toolNames list holding no
    // sandbox tool, so the log looked correct on both counts separately.
    const log = SRC.slice(SRC.indexOf("event: 'invocation_start'"));
    expect(log).toContain('capabilityTier: instruction.capabilityTier');
    expect(log).toContain('toolNames: registeredToolNames');
  });
});
