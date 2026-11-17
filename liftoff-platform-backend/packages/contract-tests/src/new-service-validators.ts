// Validators for the four Phase 0a services. Each service owns one
// $defs bundle in fixtures/; individual validators reference the bundle
// via $ref so that the bundle stays single-source-of-truth.
//
// Coverage gate: every RPC in the proto surface (see scripts/
// contract-coverage-gate.ts) must appear below or CI fails.

import Ajv, { type ValidateFunction, type SchemaObject } from 'ajv';
import addFormats from 'ajv-formats';

import billingSchema from '../fixtures/billing-service.schema.json';
import developerProxySchema from '../fixtures/developer-proxy-service.schema.json';
import workforceSchema from '../fixtures/workforce-service.schema.json';
import outboxEnvelopeSchema from '../fixtures/outbox-envelope.schema.json';

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

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

ajv.addSchema(billingSchema as SchemaObject);
ajv.addSchema(developerProxySchema as SchemaObject);
ajv.addSchema(workforceSchema as SchemaObject);
ajv.addSchema(outboxEnvelopeSchema as SchemaObject);

function refValidator<T>(
  schemaId: string,
  defName: string,
): (payload: unknown) => ContractValidationResult<T> {
  const ref = `${schemaId}#/$defs/${defName}`;
  let validate: ValidateFunction | null = null;
  return (payload: unknown): ContractValidationResult<T> => {
    if (!validate) {
      const compiled = ajv.getSchema(ref) ?? ajv.compile({ $ref: ref });
      validate = compiled;
    }
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

// ── Billing ───────────────────────────────────────────────────────────
const BILLING_ID = 'https://example.com/contracts/billing-service.schema.json';

export const validateBillingGetSubscriptionRequest = refValidator(BILLING_ID, 'GetSubscriptionRequest');
export const validateBillingGetSubscriptionResponse = refValidator(BILLING_ID, 'GetSubscriptionResponse');
export const validateBillingReportUsageRequest = refValidator(BILLING_ID, 'ReportUsageRequest');
export const validateBillingReportUsageResponse = refValidator(BILLING_ID, 'ReportUsageResponse');
export const validateBillingReconcileMetersRequest = refValidator(BILLING_ID, 'ReconcileMetersRequest');
export const validateBillingReconcileMetersResponse = refValidator(BILLING_ID, 'ReconcileMetersResponse');
export const validateBillingListInvoicesRequest = refValidator(BILLING_ID, 'ListInvoicesRequest');
export const validateBillingListInvoicesResponse = refValidator(BILLING_ID, 'ListInvoicesResponse');
export const validateBillingCreateCheckoutSessionRequest = refValidator(BILLING_ID, 'CreateCheckoutSessionRequest');
export const validateBillingCreateCheckoutSessionResponse = refValidator(BILLING_ID, 'CreateCheckoutSessionResponse');
export const validateBillingReplayEventsRequest = refValidator(BILLING_ID, 'ReplayEventsRequest');
export const validateBillingReplayEventsResponse = refValidator(BILLING_ID, 'ReplayEventsResponse');
export const validateBillingExportTenantDataRequest = refValidator(BILLING_ID, 'ExportTenantDataRequest');
export const validateBillingExportTenantDataResponse = refValidator(BILLING_ID, 'ExportTenantDataResponse');
export const validateBillingDeleteTenantUserDataRequest = refValidator(BILLING_ID, 'DeleteTenantUserDataRequest');
export const validateBillingDeleteTenantUserDataResponse = refValidator(BILLING_ID, 'DeleteTenantUserDataResponse');
export const validateBillingEventEnvelope = refValidator(BILLING_ID, 'EventEnvelope');

// ── Developer Proxy ───────────────────────────────────────────────────
const DEVELOPER_PROXY_ID = 'https://example.com/contracts/developer-proxy-service.schema.json';

export const validateDeveloperProxyCreateCredentialRequest = refValidator(DEVELOPER_PROXY_ID, 'CreateCredentialRequest');
export const validateDeveloperProxyCreateCredentialResponse = refValidator(DEVELOPER_PROXY_ID, 'CreateCredentialResponse');
export const validateDeveloperProxyListCredentialsRequest = refValidator(DEVELOPER_PROXY_ID, 'ListCredentialsRequest');
export const validateDeveloperProxyListCredentialsResponse = refValidator(DEVELOPER_PROXY_ID, 'ListCredentialsResponse');
export const validateDeveloperProxyRevokeCredentialRequest = refValidator(DEVELOPER_PROXY_ID, 'RevokeCredentialRequest');
export const validateDeveloperProxyRevokeCredentialResponse = refValidator(DEVELOPER_PROXY_ID, 'RevokeCredentialResponse');
export const validateDeveloperProxyGetUsageRequest = refValidator(DEVELOPER_PROXY_ID, 'GetUsageRequest');
export const validateDeveloperProxyGetUsageResponse = refValidator(DEVELOPER_PROXY_ID, 'GetUsageResponse');
export const validateDeveloperProxyInitiatePkceSetupRequest = refValidator(DEVELOPER_PROXY_ID, 'InitiatePkceSetupRequest');
export const validateDeveloperProxyInitiatePkceSetupResponse = refValidator(DEVELOPER_PROXY_ID, 'InitiatePkceSetupResponse');
export const validateDeveloperProxyCompletePkceSetupRequest = refValidator(DEVELOPER_PROXY_ID, 'CompletePkceSetupRequest');
export const validateDeveloperProxyCompletePkceSetupResponse = refValidator(DEVELOPER_PROXY_ID, 'CompletePkceSetupResponse');
export const validateDeveloperProxyExportTenantDataRequest = refValidator(DEVELOPER_PROXY_ID, 'ExportTenantDataRequest');
export const validateDeveloperProxyExportTenantDataResponse = refValidator(DEVELOPER_PROXY_ID, 'ExportTenantDataResponse');
export const validateDeveloperProxyDeleteTenantUserDataRequest = refValidator(DEVELOPER_PROXY_ID, 'DeleteTenantUserDataRequest');
export const validateDeveloperProxyDeleteTenantUserDataResponse = refValidator(DEVELOPER_PROXY_ID, 'DeleteTenantUserDataResponse');

// ── Workforce ────────────────────────────────────────────────────────
const WORKFORCE_ID = 'https://example.com/contracts/workforce-service.schema.json';

export const validateWorkforceDraftPlanRequest = refValidator(WORKFORCE_ID, 'DraftPlanRequest');
export const validateWorkforceDraftPlanResponse = refValidator(WORKFORCE_ID, 'DraftPlanResponse');
export const validateWorkforceCommitPlanRequest = refValidator(WORKFORCE_ID, 'CommitPlanRequest');
export const validateWorkforceCommitPlanResponse = refValidator(WORKFORCE_ID, 'CommitPlanResponse');
export const validateWorkforceGetPlanRequest = refValidator(WORKFORCE_ID, 'GetPlanRequest');
export const validateWorkforceGetPlanResponse = refValidator(WORKFORCE_ID, 'GetPlanResponse');
export const validateWorkforceListPlansRequest = refValidator(WORKFORCE_ID, 'ListPlansRequest');
export const validateWorkforceListPlansResponse = refValidator(WORKFORCE_ID, 'ListPlansResponse');
export const validateWorkforceResumeStuckPlanRequest = refValidator(WORKFORCE_ID, 'ResumeStuckPlanRequest');
export const validateWorkforceResumeStuckPlanResponse = refValidator(WORKFORCE_ID, 'ResumeStuckPlanResponse');
export const validateWorkforceGetCAIOToolDefinitionsRequest = refValidator(WORKFORCE_ID, 'GetCAIOToolDefinitionsRequest');
export const validateWorkforceGetCAIOToolDefinitionsResponse = refValidator(WORKFORCE_ID, 'GetCAIOToolDefinitionsResponse');
export const validateWorkforceDraftPlanSseEvent = refValidator(WORKFORCE_ID, 'DraftPlanSseEvent');
export const validateWorkforceExportTenantDataRequest = refValidator(WORKFORCE_ID, 'ExportTenantDataRequest');
export const validateWorkforceExportTenantDataResponse = refValidator(WORKFORCE_ID, 'ExportTenantDataResponse');
export const validateWorkforceDeleteTenantUserDataRequest = refValidator(WORKFORCE_ID, 'DeleteTenantUserDataRequest');
export const validateWorkforceDeleteTenantUserDataResponse = refValidator(WORKFORCE_ID, 'DeleteTenantUserDataResponse');
export const validateWorkforceEventEnvelope = refValidator(WORKFORCE_ID, 'EventEnvelope');

// ── Shared outbox envelope ────────────────────────────────────────────
// Root schema has no $defs — compile directly.
const outboxEnvelopeValidate = ajv.compile(outboxEnvelopeSchema as SchemaObject);

export function validateOutboxEnvelope(payload: unknown): ContractValidationResult<unknown> {
  if (outboxEnvelopeValidate(payload)) {
    return { valid: true, data: payload };
  }
  return {
    valid: false,
    errors: (outboxEnvelopeValidate.errors ?? []).map((e) => ({
      path: e.instancePath,
      message: e.message ?? 'validation error',
      keyword: e.keyword,
    })),
  };
}

export const newServiceSchemas = {
  billingService: billingSchema,
  developerProxyService: developerProxySchema,
  workforceService: workforceSchema,
  outboxEnvelope: outboxEnvelopeSchema,
};
