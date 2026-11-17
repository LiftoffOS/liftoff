// Platform vendor balance monitor.
//
// The platform-funded data vendors run on the platform's own prepaid accounts,
// and some do not auto-reload — so a capability call fails closed the moment a
// balance runs out, silently, for every workspace at once. This reads each
// PLATFORM-executable vendor that exposes a cleanly-readable balance and emits a
// `vendor_balance` metric plus a WARN below a per-vendor floor, so a low balance
// becomes an alert to top up rather than a wave of failed runs.
//
// The reads go through the SAME guarded executor every capability run uses
// (internal:<vendor>), under a synthetic monitor tenant. A balance read is a
// free account read, so nothing is billed and no real tenant's ledger is touched.
//
// BYO-only vendors are deliberately NOT monitored here — each workspace runs on
// its OWN key, so there is no platform balance to watch: telephony (saperly),
// and person/contact enrichment (pdl, hunterio) after connector-service was
// found to have no internal:<type> executor for them (they are BYO-only in
// vendor-execution's BYO_ONLY_VENDORS). Vendors whose balance is not cleanly
// readable (tikhub float, strale wallet, apify credits) are also omitted until
// each has a confirmed account-read; adding one is a new entry here.
//
// There is currently no platform-executable vendor with a confirmed, cleanly
// readable balance, so this monitors nothing today. The infrastructure stays so
// onboarding one is a single reader added to `monitorVendorBalances`.

import { log } from '../infrastructure/logging';

export interface VendorBalance {
  vendor: string;
  ok: boolean;
  low: boolean;
  detail: Record<string, number> | null;
  error?: string;
}

/** Read every monitored vendor's balance, emit a metric per vendor, and WARN on
 *  any that is low or unreadable. Returns the balances for the caller to surface.
 *  Empty today — see the module note; add a reader per platform-balance vendor. */
export async function monitorVendorBalances(): Promise<VendorBalance[]> {
  const balances: VendorBalance[] = await Promise.all([]);
  for (const b of balances) {
    if (!b.ok) {
      log.warn(
        { metric: 'vendor_balance', vendor: b.vendor, ok: false, error: b.error },
        `vendor balance check failed: ${b.vendor}`,
      );
      continue;
    }
    const payload = { metric: 'vendor_balance', vendor: b.vendor, low: b.low, ...(b.detail ?? {}) };
    if (b.low) {
      log.warn(payload, `${b.vendor} balance LOW — top up (no auto-reload)`);
    } else {
      log.info(payload, `${b.vendor} balance ok`);
    }
  }
  return balances;
}
