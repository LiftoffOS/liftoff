// The tenant runtime Docker image supports six operating modes. Each Cloud
// Run service deployment sets a different `SERVICE_TYPE` env var and mounts
// only the routers + background jobs it owns. Monolith is the legacy mode
// that owns everything and is kept as a fallback; the production topology
// is the five split services.
//
// `sandbox-executor` hosts the sandbox provider + executor + alive ticker +
// KMS-fronted JWT envelope. It runs as `sandbox-executor@…` SA (which holds
// run.admin + KMS encrypter); tool-gateway no longer constructs the provider
// in-process — it dispatches over OIDC to /v2/execute on sandbox-executor.

export type ServiceType = 'monolith' | 'agent' | 'coordinator' | 'tool-gateway' | 'reflection' | 'sandbox-executor';

export const VALID_SERVICE_TYPES: ReadonlyArray<ServiceType> = [
  'monolith',
  'agent',
  'coordinator',
  'tool-gateway',
  'reflection',
  'sandbox-executor',
];

export function isValidServiceType(value: string | undefined): value is ServiceType {
  return typeof value === 'string' && (VALID_SERVICE_TYPES as ReadonlyArray<string>).includes(value);
}

// Ownership matrix. Monolith owns everything; each split mode owns one slice.
// Callers use this to gate route mounts and background jobs. Keeping the
// matrix in one place prevents index.ts and the tests from drifting.
export interface ServiceOwnership {
  readonly serviceType: ServiceType;
  readonly ownsAgentRoutes: boolean;
  readonly ownsCoordinatorRoutes: boolean;
  readonly ownsToolGatewayRoutes: boolean;
  readonly ownsReflectionRoutes: boolean;
  readonly ownsSandboxExecutor: boolean;
}

export function ownershipFor(serviceType: ServiceType): ServiceOwnership {
  return {
    serviceType,
    ownsAgentRoutes: serviceType === 'monolith' || serviceType === 'agent',
    ownsCoordinatorRoutes: serviceType === 'monolith' || serviceType === 'coordinator',
    ownsToolGatewayRoutes: serviceType === 'monolith' || serviceType === 'tool-gateway',
    ownsReflectionRoutes: serviceType === 'monolith' || serviceType === 'reflection',
    ownsSandboxExecutor: serviceType === 'monolith' || serviceType === 'sandbox-executor',
  };
}

// Resolve the SERVICE_TYPE env var into a typed value. Returns `null` for
// unknown values so the caller can surface a precise error (and exit 1 at
// the process boundary in index.ts).
export function resolveServiceType(envValue: string | undefined): ServiceType | null {
  const candidate = envValue ?? 'monolith';
  return isValidServiceType(candidate) ? candidate : null;
}
