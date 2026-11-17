import { BrowserUseClient } from '../browser-use-client';

// Browser Use caps profile names at 100 characters. Ours is
// liftoff-{tenantId}-{agentId}-{ownerAccountId} — three UUIDs, 118 characters —
// so every pane spawn for this vendor failed at ensureProfile with a 422 before
// a session was ever created.
const LOCAL = 'dd7d80bd-3b77-4677-817c-053fdb8668cd-122662dd-de4e-4b0d-8873-50cd6a00daaf-8bd7d3f4-1234-4321-9876-abcdefabcdef';

describe('vendor profile name', () => {
  it('the real name is over the cap, which is the bug', () => {
    expect(LOCAL.length).toBeGreaterThan(100);
  });

  it('fits inside the vendor cap', () => {
    expect(BrowserUseClient.vendorProfileName(LOCAL).length).toBeLessThanOrEqual(100);
  });

  it('is deterministic, so the same owner reuses one profile and its logins', () => {
    // If this drifted, every spawn would mint a new profile and no login would
    // ever be reused — persistence would look broken for a subtler reason.
    expect(BrowserUseClient.vendorProfileName(LOCAL))
      .toBe(BrowserUseClient.vendorProfileName(LOCAL));
  });

  it('separates different owners', () => {
    const other = LOCAL.replace('8bd7d3f4', '9ce8e4a5');
    expect(BrowserUseClient.vendorProfileName(LOCAL))
      .not.toBe(BrowserUseClient.vendorProfileName(other));
  });

  it('passes short names through untouched, so an existing profile is never renamed', () => {
    expect(BrowserUseClient.vendorProfileName('short')).toBe('short');
  });
});
