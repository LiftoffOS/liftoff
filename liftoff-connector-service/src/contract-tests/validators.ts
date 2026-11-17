// Vendored JSON-Schema contract validators for the ConnectorService RPC
// surface. Fixtures in ./fixtures/ are copies of the canonical schemas that
// live in @liftoffos/contract-tests (platform-backend packages/contract-tests).
//
// Why vendor instead of importing the package?
//   Phase 1 runs before the shared packages are published to Artifact
//   Registry. We still want the callee (this service) to assert both its
//   incoming requests AND its outgoing responses match the stable JSON
//   contract. Once the package ships, this directory collapses into a
//   plain import and the fixture copies go away.
//
// Keep these fixtures byte-identical with platform-backend's originals —
// drift on either side should fail BOTH sides' CI, which is the whole
// point of contract testing.
//
// The only ajv available transitively in this service is v6 (draft-07 is
// the default). That is sufficient for our fixtures — no ajv-formats
// needed since we do not rely on uuid/date-time format validation here.

import AjvV6 from 'ajv';

import connectorExecuteRequestSchema from './fixtures/connector-execute.request.schema.json';
import connectorExecuteResponseSchema from './fixtures/connector-execute.response.schema.json';
import connectorExecuteBatchRequestSchema from './fixtures/connector-execute-batch.request.schema.json';
import connectorExecuteBatchResponseSchema from './fixtures/connector-execute-batch.response.schema.json';
import connectorWarmRequestSchema from './fixtures/connector-warm.request.schema.json';
import connectorWarmResponseSchema from './fixtures/connector-warm.response.schema.json';
import connectorGetCredentialsRequestSchema from './fixtures/connector-get-credentials.request.schema.json';
import connectorGetCredentialsResponseSchema from './fixtures/connector-get-credentials.response.schema.json';
import connectorGetFunctionalTypesRequestSchema from './fixtures/connector-get-functional-types.request.schema.json';
import connectorGetFunctionalTypesResponseSchema from './fixtures/connector-get-functional-types.response.schema.json';
import connectorGetCapabilitiesRequestSchema from './fixtures/connector-get-capabilities.request.schema.json';
import connectorGetCapabilitiesResponseSchema from './fixtures/connector-get-capabilities.response.schema.json';
import connectorListToolsRequestSchema from './fixtures/connector-list-tools.request.schema.json';
import connectorListToolsResponseSchema from './fixtures/connector-list-tools.response.schema.json';
import connectorListTenantConnectorsRequestSchema from './fixtures/connector-list-tenant-connectors.request.schema.json';
import connectorListTenantConnectorsResponseSchema from './fixtures/connector-list-tenant-connectors.response.schema.json';

export interface ContractValidationSuccess<T> {
  valid: true;
  data: T;
}

export interface ContractValidationFailure {
  valid: false;
  errors: Array<{ path: string; message: string; keyword: string }>;
}

export type ContractValidationResult<T> =
  | ContractValidationSuccess<T>
  | ContractValidationFailure;

const ajv = new AjvV6({ allErrors: true, schemaId: 'auto' });

function compile<T = unknown>(
  schema: Record<string, unknown>,
): (payload: unknown) => ContractValidationResult<T> {
  const validate = ajv.compile(schema);
  return (payload: unknown): ContractValidationResult<T> => {
    if (validate(payload)) {
      return { valid: true, data: payload as T };
    }
    return {
      valid: false,
      errors: (validate.errors ?? []).map((e) => ({
        path: e.dataPath ?? '',
        message: e.message ?? 'validation error',
        keyword: e.keyword,
      })),
    };
  };
}

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
