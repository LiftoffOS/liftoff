// Connectors Module — thin barrel for the Phase 2a cutover.
//
// All /api/connectors/* HTTP traffic is forwarded to connector-service via
// the proxy router. The legacy in-process connector CRUD / OAuth / health
// routers have been deleted. Everything else lives behind the Connect-RPC
// client + the RPC-backed registry cache.

export { proxyRouter, createConnectorsProxyRouter } from './proxy';

export {
  getConnectorServiceClient,
  createConnectorServiceClient,
  resetSharedConnectorServiceClient,
  getConnectorServiceMode,
  isConnectorServiceEnabled,
  isShadowMode,
  ConnectorService,
  ConnectError,
  Code,
  AuthFlowKind,
  ConnectorCapabilityEnum,
} from './connector-service-client';
export type {
  ConnectorServiceMode,
  ConnectorServiceClientOptions,
  ExecuteRequest,
  ExecuteResponse,
  ExecuteBatchRequest,
  ExecuteBatchResponse,
  WarmRequest,
  WarmResponse,
  WarmFailure,
  GetCredentialsRequest,
  GetCredentialsResponse,
  GetFunctionalTypesRequest,
  GetFunctionalTypesResponse,
  GetCapabilitiesRequest,
  GetCapabilitiesResponse,
} from './connector-service-client';

export {
  initConnectorServiceCache,
  stopConnectorServiceCache,
  seedConnectorServiceCache,
  getFunctionalConnectorTypes,
  isFunctionalConnectorType,
  connectorTypesForCapability,
  scopesForConnector,
  getAllCapabilities,
  getCacheSource,
} from './connector-service-cache';
export type { CapabilityOption } from './connector-service-cache';
