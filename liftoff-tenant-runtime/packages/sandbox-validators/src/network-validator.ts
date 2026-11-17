// Network / Egress Validation
// Validates sandbox egress configuration before sandbox creation.

import { ValidationError } from './path-validator';

const DOMAIN_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;

// Domains that must NEVER be in allowedDomains (metadata endpoints, internal services)
const BLOCKED_DOMAINS = new Set([
  'metadata.google.internal',
  '169.254.169.254',
  'metadata.google.com',
]);

export type EgressPolicy = 'block' | 'allow-list' | 'open';

/**
 * Validates the egress configuration for a sandbox.
 * 'open' is the new default for browser-capable sandboxes (no domain restriction).
 * 'allow-list' has no length cap (capped removed for browser parity with agent-infra).
 * 'block' rejects all egress.
 */
export function validateEgressConfig(
  egressPolicy: EgressPolicy,
  allowedDomains?: string[],
): void {
  if (egressPolicy === 'open') {
    return;
  }

  if (egressPolicy === 'block') {
    if (allowedDomains && allowedDomains.length > 0) {
      throw new ValidationError('allowedDomains must be empty when egressPolicy is "block"');
    }
    return;
  }

  // 'allow-list' mode: domains required and validated
  if (!allowedDomains || allowedDomains.length === 0) {
    throw new ValidationError('allowedDomains is required and must be non-empty when egressPolicy is "allow-list"');
  }

  for (const domain of allowedDomains) {
    if (!DOMAIN_PATTERN.test(domain)) {
      throw new ValidationError(`Invalid domain format: "${domain}"`);
    }

    if (BLOCKED_DOMAINS.has(domain.toLowerCase())) {
      throw new ValidationError(`Blocked domain: "${domain}" (cloud metadata endpoint)`);
    }
  }
}
