// Which sandbox capabilities a chat turn exposes.
//
// The rule has two conditions and both matter, so every combination is
// enumerated: a rule tested only where it fires cannot tell "correctly withheld"
// from "withheld always", and that is the shape both halves of this failed as.

import { chatSandboxCapabilities, sandboxCapabilitiesForTier } from '../service';

describe('chatSandboxCapabilities', () => {
  it('gives a connector_only agent nothing, however the browser resolves', () => {
    for (const paneBrowserAvailable of [true, false]) {
      for (const runsWorkflow of [true, false]) {
        expect(
          chatSandboxCapabilities({ tier: 'connector_only', paneBrowserAvailable, runsWorkflow }),
        ).toEqual([]);
      }
    }
  });

  it('withholds ONLY the sandbox browser, and only with a pane and no workflow', () => {
    const caps = chatSandboxCapabilities({
      tier: 'execution_enabled',
      paneBrowserAvailable: true,
      runsWorkflow: false,
    });
    expect(caps).not.toContain('browser');
    // The rest of the workspace is untouched: this is one capability, not a tier
    // downgrade. Chat losing shell/file/vscode is the regression this guards.
    expect(caps).toEqual(expect.arrayContaining(['shell', 'file', 'vscode']));
    expect(caps).toHaveLength(sandboxCapabilitiesForTier('execution_enabled').length - 1);
  });

  it('keeps the sandbox browser when there is no pane to drive instead', () => {
    // Nothing to steer the agent towards, so removing its only browser would
    // leave it unable to browse at all.
    expect(
      chatSandboxCapabilities({
        tier: 'execution_enabled',
        paneBrowserAvailable: false,
        runsWorkflow: false,
      }),
    ).toEqual(sandboxCapabilitiesForTier('execution_enabled'));
  });

  it('keeps the sandbox browser for a workflow turn even when a pane exists', () => {
    // A workflow's steps are authored against the sandbox browser, and a step is
    // not the surface a person is watching.
    expect(
      chatSandboxCapabilities({
        tier: 'execution_enabled',
        paneBrowserAvailable: true,
        runsWorkflow: true,
      }),
    ).toEqual(sandboxCapabilitiesForTier('execution_enabled'));
  });

  it('does not mutate what sandboxCapabilitiesForTier returns', () => {
    // filter() returns a new array today; a future rewrite to splice() would
    // corrupt every later caller in the same process.
    const before = sandboxCapabilitiesForTier('execution_enabled');
    chatSandboxCapabilities({
      tier: 'execution_enabled',
      paneBrowserAvailable: true,
      runsWorkflow: false,
    });
    expect(sandboxCapabilitiesForTier('execution_enabled')).toEqual(before);
  });
});
