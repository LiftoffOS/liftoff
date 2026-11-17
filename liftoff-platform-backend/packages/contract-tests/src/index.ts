/**
 * @liftoffos/contract-tests
 *
 * Cross-repo contract schemas and validators. Each schema in ../fixtures/
 * is the authoritative description of an HTTP or Pub/Sub boundary between
 * Liftoff services. Both ends of a boundary run these validators in their
 * own CI so drift fails the build on BOTH sides.
 *
 * Usage:
 *   import { validateInternalAgentCreatedEvent } from '@liftoffos/contract-tests';
 *   const result = validateInternalAgentCreatedEvent(payload);
 *   if (!result.valid) { console.error(result.errors); }
 */

import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

import internalAgentCreatedSchema from '../fixtures/internal-agent-created.event.schema.json';
import eventCustomReceivedSchema from '../fixtures/event-custom-received.event.schema.json';
import toolCatalogResponseSchema from '../fixtures/tool-catalog.response.schema.json';
import tenantManifestsResponseSchema from '../fixtures/tenant-manifests.response.schema.json';
import createInternalAgentRequestSchema from '../fixtures/internal-agents-create.request.schema.json';

// GovernanceEngine boundary
import governancePreflightRequestSchema from '../fixtures/governance-preflight.request.schema.json';
import governancePreflightResponseSchema from '../fixtures/governance-preflight.response.schema.json';
import governanceAuthorizeRequestSchema from '../fixtures/governance-authorize.request.schema.json';
import governanceAuthorizeResponseSchema from '../fixtures/governance-authorize.response.schema.json';
import governanceRecordRequestSchema from '../fixtures/governance-record.request.schema.json';
import governanceRecordResponseSchema from '../fixtures/governance-record.response.schema.json';
import governanceListApprovalsRequestSchema from '../fixtures/governance-list-approvals.request.schema.json';
import governanceListApprovalsResponseSchema from '../fixtures/governance-list-approvals.response.schema.json';

// ConnectorService boundary
import connectorExecuteRequestSchema from '../fixtures/connector-execute.request.schema.json';
import connectorExecuteResponseSchema from '../fixtures/connector-execute.response.schema.json';
import connectorExecuteBatchRequestSchema from '../fixtures/connector-execute-batch.request.schema.json';
import connectorExecuteBatchResponseSchema from '../fixtures/connector-execute-batch.response.schema.json';
import connectorWarmRequestSchema from '../fixtures/connector-warm.request.schema.json';
import connectorWarmResponseSchema from '../fixtures/connector-warm.response.schema.json';
import connectorGetCredentialsRequestSchema from '../fixtures/connector-get-credentials.request.schema.json';
import connectorGetCredentialsResponseSchema from '../fixtures/connector-get-credentials.response.schema.json';
import connectorGetFunctionalTypesRequestSchema from '../fixtures/connector-get-functional-types.request.schema.json';
import connectorGetFunctionalTypesResponseSchema from '../fixtures/connector-get-functional-types.response.schema.json';
import connectorGetCapabilitiesRequestSchema from '../fixtures/connector-get-capabilities.request.schema.json';
import connectorGetCapabilitiesResponseSchema from '../fixtures/connector-get-capabilities.response.schema.json';
import connectorListToolsRequestSchema from '../fixtures/connector-list-tools.request.schema.json';
import connectorListToolsResponseSchema from '../fixtures/connector-list-tools.response.schema.json';
import connectorListTenantConnectorsRequestSchema from '../fixtures/connector-list-tenant-connectors.request.schema.json';
import connectorListTenantConnectorsResponseSchema from '../fixtures/connector-list-tenant-connectors.response.schema.json';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

// Register the shared-definition schema first so other schemas can $ref its
// internal #/definitions/WorkflowStep path.
ajv.addSchema(internalAgentCreatedSchema);

export interface ContractValidationSuccess<T> {
  valid: true;
  data: T;
}

export interface ContractValidationFailure {
  valid: false;
  errors: Array<{ path: string; message: string; keyword: string }>;
}

export type ContractValidationResult<T> = ContractValidationSuccess<T> | ContractValidationFailure;

function compile<T = unknown>(
  schema: Record<string, unknown>,
): (payload: unknown) => ContractValidationResult<T> {
  const validate: ValidateFunction = ajv.compile(schema);
  return (payload: unknown): ContractValidationResult<T> => {
    if (validate(payload)) {
      return { valid: true, data: payload as T };
    }
    return {
      valid: false,
      errors: (validate.errors ?? []).map((e) => ({
        path: e.instancePath,
        message: e.message ?? 'validation error',
        keyword: e.keyword,
      })),
    };
  };
}

export const validateInternalAgentCreatedEvent = compile(
  internalAgentCreatedSchema as Record<string, unknown>,
);
export const validateEventCustomReceivedEvent = compile(
  eventCustomReceivedSchema as Record<string, unknown>,
);
export const validateToolCatalogResponse = compile(
  toolCatalogResponseSchema as Record<string, unknown>,
);
export const validateTenantManifestsResponse = compile(
  tenantManifestsResponseSchema as Record<string, unknown>,
);
export const validateCreateInternalAgentRequest = compile(
  createInternalAgentRequestSchema as Record<string, unknown>,
);

// GovernanceEngine validators
export const validateGovernancePreflightRequest = compile(
  governancePreflightRequestSchema as Record<string, unknown>,
);
export const validateGovernancePreflightResponse = compile(
  governancePreflightResponseSchema as Record<string, unknown>,
);
export const validateGovernanceAuthorizeRequest = compile(
  governanceAuthorizeRequestSchema as Record<string, unknown>,
);
export const validateGovernanceAuthorizeResponse = compile(
  governanceAuthorizeResponseSchema as Record<string, unknown>,
);
export const validateGovernanceRecordRequest = compile(
  governanceRecordRequestSchema as Record<string, unknown>,
);
export const validateGovernanceRecordResponse = compile(
  governanceRecordResponseSchema as Record<string, unknown>,
);
export const validateGovernanceListApprovalsRequest = compile(
  governanceListApprovalsRequestSchema as Record<string, unknown>,
);
export const validateGovernanceListApprovalsResponse = compile(
  governanceListApprovalsResponseSchema as Record<string, unknown>,
);

// ConnectorService validators
export const validateConnectorExecuteRequest = compile(
  connectorExecuteRequestSchema as Record<string, unknown>,
);
export const validateConnectorExecuteResponse = compile(
  connectorExecuteResponseSchema as Record<string, unknown>,
);
export const validateConnectorExecuteBatchRequest = compile(
  connectorExecuteBatchRequestSchema as Record<string, unknown>,
);
export const validateConnectorExecuteBatchResponse = compile(
  connectorExecuteBatchResponseSchema as Record<string, unknown>,
);
export const validateConnectorWarmRequest = compile(
  connectorWarmRequestSchema as Record<string, unknown>,
);
export const validateConnectorWarmResponse = compile(
  connectorWarmResponseSchema as Record<string, unknown>,
);
export const validateConnectorGetCredentialsRequest = compile(
  connectorGetCredentialsRequestSchema as Record<string, unknown>,
);
export const validateConnectorGetCredentialsResponse = compile(
  connectorGetCredentialsResponseSchema as Record<string, unknown>,
);
export const validateConnectorGetFunctionalTypesRequest = compile(
  connectorGetFunctionalTypesRequestSchema as Record<string, unknown>,
);
export const validateConnectorGetFunctionalTypesResponse = compile(
  connectorGetFunctionalTypesResponseSchema as Record<string, unknown>,
);
export const validateConnectorGetCapabilitiesRequest = compile(
  connectorGetCapabilitiesRequestSchema as Record<string, unknown>,
);
export const validateConnectorGetCapabilitiesResponse = compile(
  connectorGetCapabilitiesResponseSchema as Record<string, unknown>,
);
export const validateConnectorListToolsRequest = compile(
  connectorListToolsRequestSchema as Record<string, unknown>,
);
export const validateConnectorListToolsResponse = compile(
  connectorListToolsResponseSchema as Record<string, unknown>,
);
export const validateConnectorListTenantConnectorsRequest = compile(
  connectorListTenantConnectorsRequestSchema as Record<string, unknown>,
);
export const validateConnectorListTenantConnectorsResponse = compile(
  connectorListTenantConnectorsResponseSchema as Record<string, unknown>,
);

export * from './new-service-validators.js';
export * from './tolerance.js';
export * from './scenario-runner.js';
export * from './coverage-gate.js';
export * from './sse-fixtures.js';
export * from './cross-service-isolation.js';

export const schemas = {
  internalAgentCreatedEvent: internalAgentCreatedSchema,
  toolCatalogResponse: toolCatalogResponseSchema,
  tenantManifestsResponse: tenantManifestsResponseSchema,
  createInternalAgentRequest: createInternalAgentRequestSchema,
  governancePreflightRequest: governancePreflightRequestSchema,
  governancePreflightResponse: governancePreflightResponseSchema,
  governanceAuthorizeRequest: governanceAuthorizeRequestSchema,
  governanceAuthorizeResponse: governanceAuthorizeResponseSchema,
  governanceRecordRequest: governanceRecordRequestSchema,
  governanceRecordResponse: governanceRecordResponseSchema,
  governanceListApprovalsRequest: governanceListApprovalsRequestSchema,
  governanceListApprovalsResponse: governanceListApprovalsResponseSchema,
  connectorExecuteRequest: connectorExecuteRequestSchema,
  connectorExecuteResponse: connectorExecuteResponseSchema,
  connectorExecuteBatchRequest: connectorExecuteBatchRequestSchema,
  connectorExecuteBatchResponse: connectorExecuteBatchResponseSchema,
  connectorWarmRequest: connectorWarmRequestSchema,
  connectorWarmResponse: connectorWarmResponseSchema,
  connectorGetCredentialsRequest: connectorGetCredentialsRequestSchema,
  connectorGetCredentialsResponse: connectorGetCredentialsResponseSchema,
  connectorGetFunctionalTypesRequest: connectorGetFunctionalTypesRequestSchema,
  connectorGetFunctionalTypesResponse: connectorGetFunctionalTypesResponseSchema,
  connectorGetCapabilitiesRequest: connectorGetCapabilitiesRequestSchema,
  connectorGetCapabilitiesResponse: connectorGetCapabilitiesResponseSchema,
  connectorListToolsRequest: connectorListToolsRequestSchema,
  connectorListToolsResponse: connectorListToolsResponseSchema,
  connectorListTenantConnectorsRequest: connectorListTenantConnectorsRequestSchema,
  connectorListTenantConnectorsResponse: connectorListTenantConnectorsResponseSchema,
};
