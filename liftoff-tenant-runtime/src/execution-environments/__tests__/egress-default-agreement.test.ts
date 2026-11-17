// The egress surface is gone, and must stay gone.
//
// `egressPolicy`, `allowedDomains`, `validateEgressConfig` and the
// EGRESS_POLICY_DEFAULT env var described a control that did not exist. The
// policy travelled to the sandbox container, the sidecar parsed it into
// `config.egressPolicyDefault`, and NOTHING read that field — zero references.
// `block` blocked nothing; `allow-list` restricted nothing.
//
// It was deleted rather than documented, on the same reasoning that applies to
// an EGRESS firewall meant to block the metadata server: VPC egress firewalls
// cannot block Cloud Run's link-local address, so such a rule is "false
// assurance" and belongs removed rather than left in place looking protective.
//
// This is a RATCHET, not a preference. Anyone reintroducing one of these names
// is reintroducing the belief that a sandbox can be network-restricted from
// here, and it cannot — there is no enforcement point. Building one is
// infrastructure work; see docs/design/sandbox-governance.md in
// platform-backend.

import { readFileSync } from 'fs';
import { join } from 'path';

/** Source with comments stripped.
 *
 *  The ratchet forbids the MECHANISM, not the explanation — the deletion is only
 *  useful if the reasoning survives beside it, and a check that forbade the words
 *  outright would forbid the paragraph saying why they are gone. */
const read = (...p: string[]): string =>
  readFileSync(join(__dirname, '..', ...p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

/** Source as written, for the assertions about the comment itself. */
const readRaw = (...p: string[]): string => readFileSync(join(__dirname, '..', ...p), 'utf8');

describe('no inert egress control is reintroduced', () => {
  it('the executor resolves, validates and ships no egress policy', () => {
    const src = read('sandbox-executor.ts');
    expect(src).not.toMatch(/egressPolicy/);
    expect(src).not.toMatch(/allowedDomains/);
    expect(src).not.toMatch(/validateEgressConfig/);
  });

  it('the sandbox config type carries no policy field', () => {
    const src = read('types.ts');
    expect(src).not.toMatch(/egressPolicy/);
    expect(src).not.toMatch(/allowedDomains/);
  });

  it('the provider ships no EGRESS_POLICY_DEFAULT to the container', () => {
    expect(read('cloud-run-sandbox-provider.ts')).not.toMatch(/EGRESS_POLICY_DEFAULT/);
  });

  it('says WHY in the code, so the next reader does not rebuild it', () => {
    // The deletion is only useful if the reasoning survives it. Without this,
    // the surface looks like an oversight worth "fixing" back in.
    const src = readRaw('sandbox-executor.ts');
    expect(src).toContain('NO EGRESS POLICY IS APPLIED HERE');
    expect(src).toContain('sandbox_runtime_sa.tf');
  });
});
