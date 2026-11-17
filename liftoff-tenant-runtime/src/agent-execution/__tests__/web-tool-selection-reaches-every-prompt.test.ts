// Every path that prompts a model states the web-tool rule.
//
// This test exists because the workflow-step prompt is a hand-maintained array
// and platform rules keep going missing from it. Twice already, recorded in its
// own comments: the voice rules ("chat, autonomous runs, the recovery advisor,
// Liftoff and Insights all carry the same shared block — so the one path that
// most reliably reaches a customer was the one path with nothing to follow"),
// and then the user's own message ("A backboned agent in chat was therefore
// blind to the request"). Each was fixed by adding one more entry by hand, and
// nothing stopped the next one going missing.
//
// The tool-selection rule was the third. A distilled agent asked to "navigate to
// espn.com" chose its tool from its step description alone, fetched the page
// invisibly, and reported success over a blank browser pane.
//
// Source-scanned rather than rendered: two of the three call sites sit hundreds
// of lines inside executeTask, behind a database, a gateway and a live adapter
// stream. The property is structural — that the call site is THERE — and the
// block's own behaviour is asserted below from the function directly.

import { readFileSync } from 'fs';
import { join } from 'path';

// The platform browser is the second half of "does this agent have a browser",
// and it comes from the operator flags. Mocked EXPLICITLY: left alone, the flag
// reader DEFAULTS an unset vendor flag to enabled, so every connector-only case
// below would silently answer "yes, via the platform" and prove nothing about
// the connector half.
const getAllVendorFlagsMock = jest.fn();
const isVendorExcludedForTenantMock = jest.fn();
jest.mock('../../integrations/web-fetch/global-flags', () => ({
  getAllVendorFlags: (...a: unknown[]) => getAllVendorFlagsMock(...a),
  isVendorExcludedForTenant: (...a: unknown[]) => isVendorExcludedForTenantMock(...a),
}));
const platformBrowser = (on: boolean) => {
  getAllVendorFlagsMock.mockResolvedValue({ browser_use: on });
  isVendorExcludedForTenantMock.mockResolvedValue(false);
};

import { webToolSelectionBlock, hasVisibleBrowserFrom } from '../../interactive-chat/web-tool-selection';

const SRC = join(__dirname, '..', '..');
const chatPrompt = readFileSync(join(SRC, 'interactive-chat', 'system-prompt.ts'), 'utf8');
const service = readFileSync(join(SRC, 'agent-execution', 'service.ts'), 'utf8');

describe('the web-tool rule reaches every prompt path', () => {
  it('interactive chat states it', () => {
    expect(chatPrompt).toMatch(/sections\.push\(webToolSelectionBlock\(\{/);
  });

  it('autonomous runs state it', () => {
    expect(service).toMatch(/tail\.add\('stable', webToolSelectionBlock\(\{/);
  });

  it('the workflow-step prompt states it — the path that never did', () => {
    // The array literal that becomes a step's system prompt.
    const stepPrompt = service.slice(service.indexOf('You are executing step'));
    const end = stepPrompt.indexOf('].join(');
    expect(end).toBeGreaterThan(-1);
    expect(stepPrompt.slice(0, end)).toMatch(/webToolSelectionBlock\(\{/);
  });

  it('no path hardcodes the capability', () => {
    // `hasVisibleBrowser: true` on an execution path would promise a browser to
    // agents that have none, which is the failure the palette-agreement test
    // exists for. Chat is the exception: it computes the value one line above.
    expect(service).not.toMatch(/webToolSelectionBlock\(\{\s*hasVisibleBrowser:\s*(true|false)\s*[,}]/);
  });
});

describe('the rule itself', () => {
  const withBrowser = webToolSelectionBlock({ hasVisibleBrowser: true });
  const without = webToolSelectionBlock({ hasVisibleBrowser: false });

  it('decides on the verb, not on whether a URL is present', () => {
    // The distilled step this replaces classified on "is a concrete URL
    // supplied", which makes "navigate to X" and "summarise X" the same input.
    expect(withBrowser).toMatch(/decided by the VERB, never by whether a URL is present/);
  });

  it('names the browser tools only when there IS a browser', () => {
    expect(withBrowser).toContain('navigate_browser_session');
    expect(withBrowser).toContain('run_browser_task');
    // Naming an absent tool makes the model hunt for it and then report that it
    // has no tools at all.
    expect(without).not.toContain('navigate_browser_session');
    expect(without).not.toContain('run_browser_task');
  });

  it('tells a browser-less agent to say so rather than pass a fetch off as navigation', () => {
    expect(without).toMatch(/Do not silently substitute a fetch/);
  });

  it('always offers the content and research routes', () => {
    for (const block of [withBrowser, without]) {
      expect(block).toContain('web_fetch_advanced');
      expect(block).toContain('web_research');
    }
  });

  it('outranks a step description that hardcodes one tool for a whole category', () => {
    // Without this the step text wins: s3 of the agent that failed said
    // "for 'page_read' call web_fetch_advanced", and the model obeyed it.
    expect(withBrowser).toMatch(/outranks any step description/);
  });
});

describe('hasVisibleBrowserFrom', () => {
  // The platform tier is off in these cases so they pin the CONNECTOR half on
  // its own; the case that pins the platform half turns it on explicitly.
  beforeEach(() => platformBrowser(false));

  it('reads the pane-capable connectors off compiled integrations', async () => {
    await expect(hasVisibleBrowserFrom('t1', [{ type: 'browser_use' }])).resolves.toBe(true);
    await expect(hasVisibleBrowserFrom('t1', [{ type: 'anchor_browser' }])).resolves.toBe(true);
  });

  it('is false for connectors that cannot own the pane, and for none at all', async () => {
    await expect(hasVisibleBrowserFrom('t1', [{ type: 'github' }, { type: 'slack' }]))
      .resolves.toBe(false);
    await expect(hasVisibleBrowserFrom('t1', [])).resolves.toBe(false);
    await expect(hasVisibleBrowserFrom('t1', undefined)).resolves.toBe(false);
  });

  it('says YES for an agent bound to nothing when the platform backs a browser', async () => {
    // The half that matters now. The palette is built by
    // buildExposedStandardTools, which the autonomous and workflow-step paths
    // share with chat, so under the platform key those runs are HANDED
    // navigate_browser_session. A connector-only answer here told them "No
    // browser is connected for this workspace" while they held the tool, and a
    // model follows the instruction over the catalog.
    platformBrowser(true);
    await expect(hasVisibleBrowserFrom('t1', [{ type: 'github' }])).resolves.toBe(true);
    await expect(hasVisibleBrowserFrom('t1', [])).resolves.toBe(true);
  });

  it('says NO when an operator has excluded this workspace', async () => {
    platformBrowser(true);
    isVendorExcludedForTenantMock.mockResolvedValue(true);
    await expect(hasVisibleBrowserFrom('t1', [{ type: 'github' }])).resolves.toBe(false);
  });
});

describe('the browser tools are actually IN a workflow step\'s palette', () => {
  // Naming the tool is only half of it. A step whose description declares an
  // outputField rebuilds its catalog rather than reusing chat's prebuilt one,
  // and that rebuild gates the session tools on ctx.messageSenderAccountId:
  //
  //   canSpawnBrowserSession = sessionVendorAgentOn && !!ctx.messageSenderAccountId
  //
  // executeTask mapped chat's senderAccountId only to `userId`, so the context
  // never carried it and every workflow step was built with it undefined. The
  // agent could not have opened the pane on a chat turn whatever the prompt
  // said, which is why prompt-only fixes kept not working.
  it('executeTask carries the message sender onto the execution context', () => {
    expect(service).toMatch(/messageSenderAccountId:\s*input\.senderAccountId/);
  });

  it('the step catalog build forwards it rather than dropping it', () => {
    expect(service).toMatch(/messageSenderAccountId:\s*ctx\.messageSenderAccountId/);
  });
});
