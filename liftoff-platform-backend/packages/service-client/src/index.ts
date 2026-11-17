export { verifyServiceAuth } from './verify-service-auth.js';
export type { VerifyServiceAuthOptions } from './verify-service-auth.js';

export { CircuitBreaker } from './circuit-breaker.js';
export type { CircuitBreakerConfig, CircuitStateName } from './circuit-breaker.js';

export { buildOidcAuthHeader } from './oidc-auth.js';

export { redactHeaders, redactUrl } from './redact.js';
export type { RedactionOptions } from './redact.js';

export {
  ServiceClient,
  DEFAULT_REQUEST_TIMEOUT_MS,
  getServiceClientDispatcher,
} from './service-client.js';
export type {
  ServiceClientOptions,
  LogFn,
  LogLevel,
} from './service-client.js';

export {
  validateCrossServiceAuth,
  crossServiceAuthMiddleware,
  buildCrossServiceHeaders,
} from './cross-service-auth.js';
export { CallPolicy, CallPolicyError } from './call-policy.js';
export type {
  CallPolicyOptions,
  CallPolicyMetricEvent,
  CallPolicyMetrics,
  CallInvocation,
} from './call-policy.js';
export type {
  CrossServiceAuthOptions,
  CrossServiceAuthOutcome,
  PerCalleeSecretLookup,
  OidcVerifier,
  OidcPayload,
  OidcTokenFactory,
  BuildCrossServiceHeadersOptions,
} from './cross-service-auth.js';

