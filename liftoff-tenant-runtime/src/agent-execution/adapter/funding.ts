// Which adapter executes, once it is known WHO is paying.
//
// Its own module rather than part of the adapter barrel, for a reason worth
// keeping: a great many suites mock `./adapter` to hand the service a fake
// adapter, and every export added to that barrel is one more thing each of
// those mocks has to declare or fail on. Selection-by-funding is not part of
// the adapter surface those tests are stubbing.

import type { VendorSdkAdapter } from './types';

/**
 * The adapter that actually executes, once it is known WHO is paying.
 *
 * Adapter selection is otherwise a pure function of the resolved provider, and
 * for every vendor but one that is the whole story. Grok was the exception: it
 * used to resolve to `openrouter` whoever funded it, and only the credential
 * decided whether the call went to Liftoff's OpenRouter account or direct to
 * the customer's xAI account. Two different endpoints, two different model
 * namespaces, one resolved provider.
 *
 * So this is applied AFTER the BYOK session opens and before the adapter is
 * used. Managed runs — every run without a re-routing credential — get the
 * adapter they were built with, unchanged.
 *
 * A RUN THAT ALREADY RESOLVED TO xAI IS ALSO UNCHANGED. Grok is its own
 * provider now, so a current configuration resolves to `xai` whoever pays and
 * the adapter it was built with already dials api.x.ai — on whichever ENGINE
 * that provider runs. Swapping it for the wire adapter here would silently
 * change the engine (the invocation records the one the provider resolved to,
 * and the hybrid loop's resume guard holds the run to it) and would mean the
 * customer's key could only ever fund Grok on the wire, whatever the provider's
 * engine is. The re-route is left for the one case it was written for: a
 * configuration from before the move whose provider is still a gateway family.
 */
export function adapterForFunding(
  base: VendorSdkAdapter,
  credential: { vendor: string; rerouteToVendorApi: boolean } | null | undefined,
  /** The provider the run resolved to and `base` was built for. */
  resolvedProvider?: string,
): VendorSdkAdapter {
  // Say which way this went, always.
  //
  // This fork decides WHICH VENDOR a run dials, and without this line its
  // outcome is invisible: a run that should have gone to api.x.ai on the
  // customer's key and instead went to OpenRouter looks, from the other logs,
  // exactly like one that was never eligible. One line answers that question —
  // the same reasoning as the BYOK decision logging — which is why this is INFO
  // rather than debug.
  const { logger } = require('../../infrastructure/logging') as typeof import('../../infrastructure/logging');
  logger.info(
    {
      baseAdapter: (base as { kind?: string }).kind ?? 'unknown',
      resolvedProvider: resolvedProvider ?? null,
      credentialVendor: credential?.vendor ?? null,
      rerouteToVendorApi: credential?.rerouteToVendorApi ?? false,
    },
    'adapter selected for this run\'s funding',
  );
  if (!credential?.rerouteToVendorApi) return base;
  // Already where the re-route would send it. The adapter resolved for `xai`
  // reads the credential itself (`input.byok`) on every engine that serves it.
  if (credential.vendor === 'xai' && resolvedProvider === 'xai') return base;
  if (credential.vendor === 'xai') {
    const { createXaiAdapter } = require('./xai') as typeof import('./xai');
    return createXaiAdapter();
  }
  // A re-route was asked for and no adapter serves it. Staying on `base` would
  // send the call to the resolved provider on OUR account while the control
  // plane believes the customer is funding it, so the usage row would say
  // byok_customer_funded for a call Liftoff paid for.
  throw new Error(`no adapter serves a re-routed ${credential.vendor} credential`);
}
