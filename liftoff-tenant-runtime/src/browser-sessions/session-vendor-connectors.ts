import { withDeadline } from '../infrastructure/deadline';

/** The connector types that can OWN a thread's browser pane.
 *
 *  ONE list, imported everywhere a gate asks "can this agent drive a browser".
 *  It exists because that question was previously spelled
 *  `allowedConnectors.includes('anchor_browser')` in eight separate places —
 *  the system prompt, the MCP tool gateway, the chat turn handler, the test
 *  harness, expose-tools, the session reaper, tenant teardown, and the BYOK
 *  reprobe. Adding a second vendor meant every one of them silently kept
 *  answering for Anchor alone.
 *
 *  The worst of those was the system prompt, which told a Browser Use agent
 *  "there is no live browser pane attached to this agent" and instructed it to
 *  offer scraped text instead. The agent then did exactly that, which read as a
 *  model failing to pick a tool when it was in fact following orders.
 *
 *  Keep in the same preference order as SESSION_VENDOR_PREFERENCE in
 *  session-vendor-proxy.ts.
 *
 *  browserbase was absent from both for a long time, and the reason is worth
 *  keeping: it reported session support while implementing ONE of the ten pane
 *  operations, so listing it would have handed a thread to a browser that
 *  accepted `goto` and did nothing. It implements all ten now. */
export const SESSION_BROWSER_CONNECTOR_TYPES = [
  'anchor_browser', 'browserbase', 'steel', 'browser_use',
] as const;

/** True when the agent is bound to any connector that can drive the pane.
 *  Replaces `allowedConnectors.includes('anchor_browser')` at every gate. */
export function hasSessionBrowserConnector(allowedConnectors: readonly string[]): boolean {
  return allowedConnectors.some(
    (c) => (SESSION_BROWSER_CONNECTOR_TYPES as readonly string[]).includes(c),
  );
}

/** The platform's own key makes the browser a NATIVE-BACKED capability, in
 *  exactly the sense expose-tools uses the term for Perplexity: it exists for
 *  every agent by default and the only gates are the operator kill-switches.
 *  Per-agent binding stops gating it for the same reason binding does not gate
 *  web_research — binding scopes a capability the WORKSPACE brought, and this
 *  one is ours.
 *
 *  BOTH kill-switches are honoured per vendor, because an operator reaches for
 *  whichever one matches the blast radius:
 *    - `web_fetch_vendor_<vendor>` (global sentinel row, defaults ON) is the
 *      estate-wide stop for a vendor incident.
 *    - `web_fetch_vendor_<vendor>_disabled` (the TENANT's own row) is the
 *      single-workspace stop, and it is the one every other vendor path already
 *      respects through isVendorExcludedForTenant. A gate that read only the
 *      global flag would keep handing a browser to the one workspace an
 *      operator had just switched off.
 */
/** The platform vendors that can back a pane, in preference order. Steel
 *  first (usage-billed with auto top-up), Browser Use as the fallback (its
 *  pay-as-you-go credit can run out silently). Each is honoured through
 *  the same two switches; the first whose switches are on and whose key the
 *  platform actually holds backs the pane. */
export type PlatformPaneVendor = 'steel' | 'browser_use';
const PLATFORM_PANE_VENDOR_ORDER: readonly PlatformPaneVendor[] = ['steel', 'browser_use'];

/** Whether the platform holds this vendor's key. Read once per process per
 *  vendor: the secret is mounted at deploy time and does not appear or vanish
 *  between turns, and re-reading Secret Manager on every palette build is a
 *  cost with no information in it. A read that fails is "not configured",
 *  never a thrown pane.
 *
 *  Bounded, and only a real ANSWER is cached. Every palette build awaits this,
 *  and it used to cache the pending promise itself: one Secret Manager read on
 *  a connection left dead by a network reset stalled every later caller in the
 *  process behind it. A read that fails or times out now answers false for the
 *  callers already waiting and is forgotten at once, so the next caller reads
 *  again. A key that is genuinely absent is remembered for a while, as before. */
const platformKeyKnown = new Map<PlatformPaneVendor, Promise<boolean>>();
const PLATFORM_KEY_SECRET: Record<PlatformPaneVendor, 'steel-api-key' | 'browser-use-api-key'> = {
  steel: 'steel-api-key',
  browser_use: 'browser-use-api-key',
};
/** A Secret Manager access is normally tens of milliseconds. */
export const PLATFORM_KEY_READ_DEADLINE_MS = 5_000;
const ABSENT_KEY_MEMO_MS = 5 * 60_000;
async function platformKeyConfigured(vendor: PlatformPaneVendor): Promise<boolean> {
  let known = platformKeyKnown.get(vendor);
  if (!known) {
    const read = (async (): Promise<{ ok: boolean; answered: boolean }> => {
      const { getWebToolSecret } = await import('../integrations/web-fetch/web-tool-secrets');
      try {
        const key = await withDeadline(
          `platform ${vendor} key read`,
          PLATFORM_KEY_READ_DEADLINE_MS,
          () => getWebToolSecret(PLATFORM_KEY_SECRET[vendor]),
        );
        return { ok: key.trim().length > 0, answered: true };
      } catch {
        return { ok: false, answered: false };
      }
    })();
    known = read.then((r) => r.ok);
    platformKeyKnown.set(vendor, known);
    const entry = known;
    void read.then((r) => {
      // Only this read's own entry: a reset or a newer read may have replaced it.
      const forget = () => { if (platformKeyKnown.get(vendor) === entry) platformKeyKnown.delete(vendor); };
      if (!r.answered) forget();
      // An absent key is not forever either: forget it after a while so a key
      // mounted later does not blank the vendor until restart.
      else if (!r.ok) setTimeout(forget, ABSENT_KEY_MEMO_MS).unref?.();
    });
  }
  return known;
}

/** Platform vendors whose key was just refused, and until when they are
 *  skipped. A vendor answers a spend-shaped refusal (the account out of
 *  credit, the key revoked) or an outage on the platform key at the moment a
 *  pane is spawned, and the next platform vendor should take that spawn
 *  rather than the person seeing "no browser" while a funded vendor sits one
 *  rung down. The memo keeps the runtime from paying a refused call on every
 *  spawn in the meantime; it is per process and short, so a topped-up account
 *  comes back on its own. */
const platformVendorRefusedUntil = new Map<PlatformPaneVendor, number>();
const REFUSED_TRANSIENT_MS = 60_000;
const REFUSED_ACCOUNT_MS = 5 * 60_000;

export function markPlatformPaneVendorRefused(vendor: PlatformPaneVendor, retryable: boolean): void {
  platformVendorRefusedUntil.set(vendor, Date.now() + (retryable ? REFUSED_TRANSIENT_MS : REFUSED_ACCOUNT_MS));
}

function platformVendorRefused(vendor: PlatformPaneVendor): boolean {
  const until = platformVendorRefusedUntil.get(vendor);
  return until !== undefined && Date.now() < until;
}

export function isPlatformPaneVendor(vendor: string): vendor is PlatformPaneVendor {
  return (PLATFORM_PANE_VENDOR_ORDER as readonly string[]).includes(vendor);
}

/** Test seam: forget which platform keys were seen and which were refused. */
export function _resetPlatformKeyCache(): void {
  platformKeyKnown.clear();
  platformVendorRefusedUntil.clear();
}

/** The vendor that backs a pane for an agent bound to no browser connector,
 *  or null when no platform vendor is on for this workspace.
 *
 *  Fails CLOSED. A flag lookup that cannot answer must not invent a browser:
 *  the palette would then carry tools whose spawn fails, which is the failure
 *  this whole surface keeps producing.
 *
 *  `prefetched` is for callers that already read the vendor flags for their own
 *  reasons — expose-tools builds a whole palette from them. The flags are a
 *  database read with no cache in front of it, and the palette is rebuilt every
 *  turn, so re-reading them here would double that cost on the hottest path.
 *  Passing them in keeps the answer in one function without paying twice. The
 *  per-tenant exclusion is not prefetchable and does not need to be: it carries
 *  its own 60s cache. */
export async function platformPaneVendor(
  tenantId: string,
  prefetched?: { browser_use: boolean; steel?: boolean },
): Promise<PlatformPaneVendor | null> {
  const { getAllVendorFlags, isVendorExcludedForTenant } =
    await import('../integrations/web-fetch/global-flags');
  try {
    const flags = prefetched && prefetched.steel !== undefined
      ? prefetched
      : await getAllVendorFlags();
    for (const vendor of PLATFORM_PANE_VENDOR_ORDER) {
      const globallyOn = vendor === 'steel' ? flags.steel === true : flags.browser_use;
      if (!globallyOn) continue;
      if (await isVendorExcludedForTenant(tenantId, vendor)) continue;
      if (!(await platformKeyConfigured(vendor))) continue;
      if (platformVendorRefused(vendor)) continue;
      return vendor;
    }
    return null;
  } catch {
    return null;
  }
}

/** True when the platform's own key can back a pane for an agent that is
 *  bound to no browser connector at all: whichever platform vendor is on.
 *
 *  This is the SECOND half of "can this agent drive a browser", and it is
 *  deliberately in the same file as the first. Every gate asks the whole
 *  question — `hasSessionBrowserConnector(...) || await platformPaneBrowserOn(t)`
 *  — because a gate that asks only half of it withholds a browser the platform
 *  is willing to fund, or promises one an operator has switched off. */
export async function platformPaneBrowserOn(
  tenantId: string,
  prefetched?: { browser_use: boolean; steel?: boolean },
): Promise<boolean> {
  return (await platformPaneVendor(tenantId, prefetched)) !== null;
}
