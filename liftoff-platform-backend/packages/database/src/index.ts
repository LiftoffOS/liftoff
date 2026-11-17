export { withTenantScope, withAdminScope } from './tenant-scope.js';
export { withTenantContext, DEFAULT_RLS_VARIABLE_NAME } from './tenant-context.js';
export type {
  TenantScopeOptions,
  AdminScopeOptions,
  AdminScopeContext,
  TenantScopedClient,
} from './tenant-scope.js';

export { collectPoolStats, resolvePoolSize } from './pool-stats.js';
export type { PoolStats, PoolSizeResolverOptions } from './pool-stats.js';

export { DatabasePoolFactory } from './pool-factory.js';
export type { PoolFactoryOptions, Logger as PoolFactoryLogger } from './pool-factory.js';

export { runRlsFence } from './rls-fence.js';
export type { RlsFenceViolation, RlsFenceOptions } from './rls-fence.js';

export { installBorrowedClientGuard } from './borrowed-client-guard.js';
export type {
  BorrowedClientGuardLogger,
  BorrowedClientGuardOptions,
} from './borrowed-client-guard.js';
