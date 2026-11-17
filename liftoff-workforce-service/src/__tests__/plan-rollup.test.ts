// A plan has to end somewhere.
//
// Each spec provisions in its own task, so only the write that lands last knows
// the plan is finished. Without that fan-in a plan never leaves `provisioning`
// — and findStuckProvisioningPlans selects on that status alone, so a finished
// plan looks stuck forever and the resumer re-enqueues its specs on every boot,
// running the HRBP agent for real money each time.

import { rollUpPlanStatus } from '../platform-agent/hrbp/tools/provisioning-update-spec-status.js';

const spec = (provisioningStatus?: string) =>
  (provisioningStatus ? { provisioningStatus } : {}) as Record<string, unknown>;

describe('rollUpPlanStatus', () => {
  it('holds while any spec is still outstanding', () => {
    expect(rollUpPlanStatus([spec('completed'), spec('pending')])).toBeNull();
    expect(rollUpPlanStatus([spec('completed'), spec('provisioning')])).toBeNull();
    // A spec that never got a status is outstanding, not done.
    expect(rollUpPlanStatus([spec('completed'), spec()])).toBeNull();
  });

  it('completes only when every spec landed without failing', () => {
    expect(rollUpPlanStatus([spec('completed')])).toBe('completed');
    expect(rollUpPlanStatus([spec('completed'), spec('completed')])).toBe('completed');
    // skipped is terminal and is not a failure.
    expect(rollUpPlanStatus([spec('completed'), spec('skipped')])).toBe('completed');
  });

  it('fails the whole plan when any spec failed', () => {
    // Someone asked for a team. A team missing a member is not the team that
    // was delivered, even though the agents that did land stay live.
    expect(rollUpPlanStatus([spec('completed'), spec('failed')])).toBe('failed');
    expect(rollUpPlanStatus([spec('failed')])).toBe('failed');
    expect(rollUpPlanStatus([spec('skipped'), spec('failed')])).toBe('failed');
  });

  it('holds on a plan with no specs rather than calling it complete', () => {
    // approve() already refuses to provision an empty plan; if one somehow
    // reaches here, "completed" would be a claim that nothing was delivered
    // successfully.
    expect(rollUpPlanStatus([])).toBeNull();
  });

  it('treats the real stuck-plan shape as terminal', () => {
    // Every spec terminal while the plan still sits in `provisioning` is the
    // shape that gets re-enqueued on every restart.
    expect(rollUpPlanStatus([spec('failed')])).not.toBeNull();
    expect(rollUpPlanStatus([spec('completed')])).not.toBeNull();
  });
});
