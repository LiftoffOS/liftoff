// Auto-exported barrel for @liftoffos/proto-gen. Domain namespaces match
// the proto package hierarchy so consumers can pick granular imports:
//
//   import { ConnectorService } from '@liftoffos/proto-gen';
//
// or the full namespace import:
//
//   import * as proto from '@liftoffos/proto-gen';
//
// Services are exported directly from the `*_pb.js` files because
// protoc-gen-es v2 emits service descriptors (`GenService<{...}>`)
// alongside message types in the same file. The v1 `*_connect.js`
// sidecar files are no longer generated — that plugin was dropped
// because it emitted `MethodKind` from @bufbuild/protobuf v1, which
// was removed in v2.
//
// NOTE: This file is hand-maintained and must NOT be deleted by `buf generate`
// or `npm run clean`. The clean script uses `find … -name '*_pb.ts' -delete`
// to avoid wiping this barrel on regeneration.

export * as event from './liftoff/event/v1/common_pb.js';
export * as eventMessages from './liftoff/event/v1/event_pb.js';

export * as billing from './liftoff/billing/v1/billing_service_pb.js';
export { BillingService } from './liftoff/billing/v1/billing_service_pb.js';

export * as developerProxy from './liftoff/developer_proxy/v1/developer_proxy_service_pb.js';
export { DeveloperProxyService } from './liftoff/developer_proxy/v1/developer_proxy_service_pb.js';


export * as workforce from './liftoff/workforce/v1/workforce_service_pb.js';
export { WorkforceService } from './liftoff/workforce/v1/workforce_service_pb.js';

export * as governance from './liftoff/governance/v1/types_pb.js';
export * as governanceService from './liftoff/governance/v1/governance_service_pb.js';
export { GovernanceService } from './liftoff/governance/v1/governance_service_pb.js';

export * as connector from './liftoff/connector/v1/types_pb.js';
export * as connectorService from './liftoff/connector/v1/connector_service_pb.js';
export { ConnectorService } from './liftoff/connector/v1/connector_service_pb.js';

export * as platform from './liftoff/platform/v1/types_pb.js';
export * as platformService from './liftoff/platform/v1/tenant_runtime_pb.js';
export { TenantRuntimeService } from './liftoff/platform/v1/tenant_runtime_pb.js';
