// BYOK error handler — central path that the six strict-policy clients
// invoke when their vendor responds with a classified `insufficient_funds`
// or `invalid_key`. Two responsibilities:
//
//   1. Flip the connector row to status='error' with the right error_code
//      via the MarkConnectorError RPC, so the next session's expose-tools
//      filter omits the vendor's tools from the LLM palette.
//
//   2. Build the labeled-block `BYOK_ERROR` envelope that wraps a user-
//      ready `USER_MESSAGE:` body. The strict clients throw this as the
//      message of a `BYOKVendorError`; the agent's system prompt instructs
//      the LLM to relay the `USER_MESSAGE:` text verbatim.

import { getConnectorServiceClient } from '../../connectors/connector-service-client';
import { invalidateWebToolCredentialCache, type WebToolVendor } from './web-tool-secrets';
import { markCredentialCooling } from './credential-pool';
import { logger } from '../../infrastructure/logging';

type ClassifiedCode = 'insufficient_funds' | 'invalid_key';

const ERROR_CODE_OF: Record<ClassifiedCode, string> = {
  insufficient_funds: 'byok_insufficient_funds',
  invalid_key:        'byok_invalid_key',
};

interface VendorCopy {
  /** Title-cased vendor name as the USER_MESSAGE subject. */
  displayName: string;
  /** Vendor console name shown in the markdown link text. */
  consoleName: string;
  /** Vendor console URL the user should visit. */
  consoleUrl: string;
}

// User-facing copy. Pattern is locked (see plan §5.2):
//   "Your `<displayName>` account is out of credit. Please add credit to your
//    account in [`<consoleName>`](`<consoleUrl>`)."   (insufficient_funds)
//   "Your `<displayName>` account is unavailable. Please check your account
//    in [`<consoleName>`](`<consoleUrl>`)."           (invalid_key)
//
// Sentence case, period-terminated. No "agent" anywhere. No emoji, no
// apology framing. Subject is always "Your `<Vendor>` account".
//
// Console URLs verified against current vendor documentation:
//   - Firecrawl:      docs.firecrawl.dev → "Get your API key" links to /app/api-keys
//   - Anchor Browser: anchorbrowser.io marketing page → "Sign in" → signin.anchorbrowser.io
//   - Browserbase:    documented /settings page within www.browserbase.com
//   - Tavily:         app.tavily.com (locked per plan §5.2)
//   - Exa:            dashboard.exa.ai/billing (locked per plan §5.2)
//   - WebClaw:        webclaw.io (no dedicated console subdomain documented;
//                                 sign-in is reached from the marketing homepage)
const VENDOR_COPY: Record<WebToolVendor, VendorCopy> = {
  firecrawl:      { displayName: 'Firecrawl',      consoleName: 'Firecrawl Dashboard',      consoleUrl: 'https://www.firecrawl.dev/app/api-keys' },
  anchor_browser: { displayName: 'Anchor Browser', consoleName: 'Anchor Browser Dashboard', consoleUrl: 'https://signin.anchorbrowser.io' },
  browserbase:    { displayName: 'Browserbase',    consoleName: 'Browserbase Dashboard',    consoleUrl: 'https://www.browserbase.com/settings' },
  tavily:         { displayName: 'Tavily',         consoleName: 'Tavily Dashboard',         consoleUrl: 'https://app.tavily.com' },
  exa:            { displayName: 'Exa',            consoleName: 'Exa Dashboard',            consoleUrl: 'https://dashboard.exa.ai/billing' },
  webclaw:        { displayName: 'WebClaw',        consoleName: 'WebClaw',                  consoleUrl: 'https://webclaw.io' },
  browser_use:    { displayName: 'Browser Use',    consoleName: 'Browser Use Dashboard',    consoleUrl: 'https://cloud.browser-use.com/billing' },
  steel:          { displayName: 'Steel',          consoleName: 'Steel Dashboard',          consoleUrl: 'https://app.steel.dev/settings/billing' },
  onepassword:    { displayName: '1Password',      consoleName: '1Password Developer Tools', consoleUrl: 'https://my.1password.com/developer-tools/infrastructure-secrets/serviceaccount' },
};

/** Build the labeled-block envelope the strict clients embed in
 *  `BYOKVendorError.message`. The agent's system prompt instructs the LLM
 *  to relay the `USER_MESSAGE:` body verbatim — keep the format stable.
 *
 *  Field semantics:
 *    `vendor:` — the machine-readable connector type (e.g. `anchor_browser`).
 *                Stable across UI renames; matches the connectors.type column.
 *    `code:`   — the error_code value (matches connectors.error_code).
 *    `USER_MESSAGE:` — the human-readable string the LLM relays verbatim.
 *                      Contains the vendor display name + markdown link. */
export function buildByokErrorMessage(
  vendor: WebToolVendor,
  classified: ClassifiedCode,
): string {
  const copy = VENDOR_COPY[vendor];
  const state = classified === 'insufficient_funds' ? 'is out of credit' : 'is unavailable';
  const verb  = classified === 'insufficient_funds' ? 'add credit to'    : 'check';
  const userMessage =
    `Your ${copy.displayName} account ${state}. ` +
    `Please ${verb} your account in [${copy.consoleName}](${copy.consoleUrl}).`;
  return [
    'BYOK_ERROR',
    `vendor: ${vendor}`,
    `code: ${ERROR_CODE_OF[classified]}`,
    '',
    'USER_MESSAGE:',
    userMessage,
  ].join('\n');
}

/** Flip the connector row to status='error' with the right error_code and
 *  invalidate the resolver cache so the next call doesn't see a stale
 *  "connected" snapshot. Best-effort: log + swallow on RPC failure (the
 *  cache invalidation still fires). */
export async function markConnectorErrored(
  tenantId: string,
  vendor: WebToolVendor,
  connectorId: string,
  classified: ClassifiedCode,
  reason: string,
): Promise<void> {
  const errorCode = ERROR_CODE_OF[classified];
  // Set THIS key aside before anything else, so the next request in this
  // process reaches for the tenant's other key immediately rather than waiting
  // on the RPC below and the cache TTL behind it. A tenant with two accounts
  // connected should not lose a single call to a key that has already said it
  // is spent.
  markCredentialCooling({
    tenantId,
    vendor,
    connectorId,
    reason: classified === 'insufficient_funds' ? 'exhausted' : 'invalid_key',
  });
  try {
    await getConnectorServiceClient().markConnectorError({
      tenantContext: { tenantId },
      connectorId,
      errorCode,
      reason,
    });
  } catch (err) {
    logger.warn(
      { tenantId, vendor, connectorId, errorCode, err: (err as Error).message },
      'markConnectorError RPC failed; resolver cache still invalidated',
    );
  }
  invalidateWebToolCredentialCache(tenantId, vendor);
}
