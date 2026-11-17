// The timer ladder at the sandbox hop, and the notice that rides with it.
//
// Source scan: sandbox-executor pulls the DB, the provider and the billing
// ledger, and the properties under test are structural — which constant is
// smaller than which, and that provisioning is no longer awaited inline.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'sandbox-executor.ts'), 'utf8');
const GATEWAY = readFileSync(
  join(__dirname, '..', '..', 'tool-gateway', 'mcp-server.ts'), 'utf8',
);

describe('the in-request wait is ordered under the caller that is waiting on it', () => {
  it('waits less than the tool-gateway ceiling it sits behind', () => {
    const wait = Number(/SANDBOX_PROVISION_WAIT_MS = ([\d_]+)/.exec(SRC)![1].replace(/_/g, ''));
    // tool-gateway-service Cloud Run timeout, set in Terraform.
    const callerCeilingMs = 60_000;
    expect(wait).toBeLessThan(callerCeilingMs);
    // ...with real headroom for the round trip, not one second of it.
    expect(callerCeilingMs - wait).toBeGreaterThanOrEqual(10_000);
  });

  it('tells the reader what it is ordered against', () => {
    // A bare number here is how the ladder got inverted in the first place.
    expect(SRC).toMatch(/tool-gateway\s+60s/);
    expect(SRC).toMatch(/sandbox-executor\s*600s/);
  });

  it('retries sooner than it waits, so a retry is cheap', () => {
    const wait = Number(/SANDBOX_PROVISION_WAIT_MS = ([\d_]+)/.exec(SRC)![1].replace(/_/g, ''));
    const retry = Number(/SANDBOX_PROVISION_RETRY_MS = ([\d_]+)/.exec(SRC)![1].replace(/_/g, ''));
    expect(retry).toBeLessThan(wait);
  });
});

describe('provisioning outlives the request that started it', () => {
  it('is raced, not awaited inline', () => {
    expect(SRC).toMatch(/Promise\.race(<[^>]+>)?\(\[/);
    expect(SRC).toContain('provisionAndFinalize');
  });

  it('finishes its bookkeeping even when nobody is waiting', () => {
    // markProvisioned / usage recording / the cache all moved inside the
    // detached routine; leaving any of them at the call site would mean a
    // sandbox that came up but was never recorded as ready.
    const routine = SRC.slice(SRC.indexOf('private async provisionAndFinalize'));
    expect(routine).toContain('markProvisioned');
    expect(routine).toContain('activeSandboxes.set');
  });

  it('cannot surface as an unhandled rejection', () => {
    expect(SRC).toMatch(/provisioning\.catch\(\(\) => undefined\)/);
  });
});

describe('the workspace-reset notice reaches the model', () => {
  it('is attached to the first call after a reset and said once', () => {
    expect(SRC).toMatch(/sandbox\.workspaceReset[\s\S]{0,120}workspaceReset = false/);
    expect(SRC).toMatch(/result\.notice =/);
  });

  it('leads the tool result rather than sitting inside the JSON', () => {
    expect(GATEWAY).toMatch(/NOTICE: \$\{result\.notice\}/);
  });

  it('says the earlier files are gone, not merely that something changed', () => {
    // The text now comes from buildWorkspaceResetNotice, which NAMES the files
    // when the previous run left a manifest. The generic constant is the
    // fallback and still has to say the same thing, so a run with no manifest
    // degrades to today's behaviour rather than to silence.
    const generic = /GENERIC_WORKSPACE_RESET_NOTICE =([\s\S]{0,400}?);/.exec(SRC)![1];
    expect(generic).toMatch(/empty workspace/i);
    expect(generic).toMatch(/gone/i);
  });

  it('prefers the manifest-driven text and falls back to the generic one', () => {
    expect(SRC).toMatch(/result\.notice = buildWorkspaceResetNotice\(/);
    expect(SRC).toMatch(/loadWorkspaceManifest\(session\.sessionId\)/);
    expect(SRC).toMatch(/GENERIC_WORKSPACE_RESET_NOTICE,/);
  });

  it('captures the manifest BEFORE the workspace is destroyed', () => {
    // After destroy there is nothing left to list, and the next run on this
    // session is exactly the one that needs to be told what it lost.
    const capture = SRC.indexOf('captureWorkspaceManifest({');
    const destroy = SRC.indexOf('await this.provider.destroy(sandboxId)');
    expect(capture).toBeGreaterThan(-1);
    expect(destroy).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(destroy);
  });
});
