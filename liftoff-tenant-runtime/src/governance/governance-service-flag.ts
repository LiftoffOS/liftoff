// Governance service feature flag — reads GOVERNANCE_SERVICE_ENABLED.
//
// Phase 3 of governance integration:
//   off    — tenant-runtime uses in-process governance only (default)
//   shadow — tenant-runtime calls both in-process and RPC, compares, serves
//            in-process result (RPC is dark-launched)
//   on     — tenant-runtime calls governance-engine RPC only; RPC errors
//            fail-closed per plan (governance is a safety system)

export type GovernanceServiceMode = 'off' | 'shadow' | 'on';

export function getGovernanceServiceMode(): GovernanceServiceMode {
  const raw = (process.env.GOVERNANCE_SERVICE_ENABLED ?? 'off').toLowerCase();
  if (raw === 'shadow' || raw === 'on') return raw;
  return 'off';
}

export function isGovernanceServiceEnabled(): boolean {
  return getGovernanceServiceMode() !== 'off';
}

export function isGovernanceShadowMode(): boolean {
  return getGovernanceServiceMode() === 'shadow';
}
