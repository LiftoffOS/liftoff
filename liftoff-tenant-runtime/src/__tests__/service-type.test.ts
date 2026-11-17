import {
  ownershipFor,
  resolveServiceType,
  VALID_SERVICE_TYPES,
  isValidServiceType,
} from '../service-type';

describe('service-type', () => {
  describe('resolveServiceType', () => {
    it('defaults to monolith when SERVICE_TYPE is undefined', () => {
      expect(resolveServiceType(undefined)).toBe('monolith');
    });

    it.each(VALID_SERVICE_TYPES)('accepts %s', (value) => {
      expect(resolveServiceType(value)).toBe(value);
    });

    it('returns null for unknown values so the caller can exit(1)', () => {
      expect(resolveServiceType('nonsense')).toBeNull();
      expect(resolveServiceType('')).toBeNull();
      expect(resolveServiceType('Monolith')).toBeNull(); // case-sensitive
    });
  });

  describe('isValidServiceType', () => {
    it.each(VALID_SERVICE_TYPES)('accepts %s', (value) => {
      expect(isValidServiceType(value)).toBe(true);
    });

    it('rejects unknown values', () => {
      expect(isValidServiceType(undefined)).toBe(false);
      expect(isValidServiceType('unknown')).toBe(false);
    });
  });

  describe('ownershipFor', () => {
    it('monolith owns every slice', () => {
      const o = ownershipFor('monolith');
      expect(o).toEqual({
        serviceType: 'monolith',
        ownsAgentRoutes: true,
        ownsCoordinatorRoutes: true,
        ownsToolGatewayRoutes: true,
        ownsReflectionRoutes: true,
        ownsSandboxExecutor: true,
      });
    });

    it('agent owns only agent routes', () => {
      expect(ownershipFor('agent')).toEqual({
        serviceType: 'agent',
        ownsAgentRoutes: true,
        ownsCoordinatorRoutes: false,
        ownsToolGatewayRoutes: false,
        ownsReflectionRoutes: false,
        ownsSandboxExecutor: false,
      });
    });

    it('coordinator owns only coordinator routes', () => {
      expect(ownershipFor('coordinator')).toEqual({
        serviceType: 'coordinator',
        ownsAgentRoutes: false,
        ownsCoordinatorRoutes: true,
        ownsToolGatewayRoutes: false,
        ownsReflectionRoutes: false,
        ownsSandboxExecutor: false,
      });
    });

    it('tool-gateway owns only tool-gateway routes', () => {
      expect(ownershipFor('tool-gateway')).toEqual({
        serviceType: 'tool-gateway',
        ownsAgentRoutes: false,
        ownsCoordinatorRoutes: false,
        ownsToolGatewayRoutes: true,
        ownsReflectionRoutes: false,
        ownsSandboxExecutor: false,
      });
    });

    it('reflection owns only reflection routes', () => {
      expect(ownershipFor('reflection')).toEqual({
        serviceType: 'reflection',
        ownsAgentRoutes: false,
        ownsCoordinatorRoutes: false,
        ownsToolGatewayRoutes: false,
        ownsReflectionRoutes: true,
        ownsSandboxExecutor: false,
      });
    });

    it('sandbox-executor owns only the sandbox subsystem', () => {
      expect(ownershipFor('sandbox-executor')).toEqual({
        serviceType: 'sandbox-executor',
        ownsAgentRoutes: false,
        ownsCoordinatorRoutes: false,
        ownsToolGatewayRoutes: false,
        ownsReflectionRoutes: false,
        ownsSandboxExecutor: true,
      });
    });

    it('every non-monolith mode owns exactly one slice', () => {
      const splits = VALID_SERVICE_TYPES.filter((t) => t !== 'monolith');
      for (const t of splits) {
        const o = ownershipFor(t);
        const ownedSlices = [
          o.ownsAgentRoutes,
          o.ownsCoordinatorRoutes,
          o.ownsToolGatewayRoutes,
          o.ownsReflectionRoutes,
          o.ownsSandboxExecutor,
        ].filter(Boolean).length;
        expect(ownedSlices).toBe(1);
      }
    });
  });
});
