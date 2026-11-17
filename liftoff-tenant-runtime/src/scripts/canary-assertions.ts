// WS-10.2 — canary assertion runner.
//
// Polls the canary's most recent invocation and asserts (a) outcome was
// success, (b) no tool call returned success:false, (c) no "Standard tool …
// executed" stub-fallback string appears in any tool result.
//
// It really does poll now. It used to issue exactly one request despite this
// comment, which made the result a race: a canary whose turn had not yet been
// written read `outcome=null` and reported a failure indistinguishable from a
// genuinely broken run. Every distinct canary defect this year surfaced as the
// same opaque `outcome=null`, because that is what a single early read returns
// whatever the underlying cause.
//
// A missing invocation and an unfinished one are both "not yet" until the
// deadline, and only then a failure — and the failure now says which of the two
// it was.

import { scrubLogger } from '../observability/scrub-logger';

interface CanaryInvocation {
  outcome: string | null;
  tool_calls: Array<{
    name: string;
    result?: { success?: boolean; error?: string };
  }>;
}

// The canary runs a real Anthropic turn, so the wait is bounded by model
// latency rather than by anything this script controls.
const POLL_TIMEOUT_MS = Number(process.env.CANARY_POLL_TIMEOUT_MS ?? 180_000);
const POLL_INTERVAL_MS = Number(process.env.CANARY_POLL_INTERVAL_MS ?? 5_000);

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** An invocation row exists and has reached a terminal state. */
function isTerminal(inv: CanaryInvocation | null): inv is CanaryInvocation {
  if (!inv) return false;
  if (inv.outcome === null || inv.outcome === undefined) return false;
  return inv.outcome !== 'running' && inv.outcome !== 'pending';
}

/**
 * One read. `null` means "nothing to assert on yet" — either no invocation row
 * exists (404) or the row is still running. Anything else is a real transport
 * or server fault and throws, because retrying past a 500 just buries it.
 */
async function readInvocation(url: string): Promise<CanaryInvocation | null> {
  const resp = await fetch(`${url}/canary/latest-invocation`, {
    headers: { Authorization: `Bearer ${process.env.CANARY_API_TOKEN ?? ''}` },
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`canary fetch failed: HTTP ${resp.status}`);
  const inv = (await resp.json()) as CanaryInvocation;
  return isTerminal(inv) ? inv : null;
}

async function fetchMostRecentCanaryInvocation(): Promise<CanaryInvocation> {
  // Wired to the actual canary invocations API when the canary tenant is
  // provisioned. Returns a synthetic empty success when the env-var
  // CANARY_API_URL is unset (local dev).
  const url = process.env.CANARY_API_URL;
  if (!url) return { outcome: 'success', tool_calls: [] };

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const inv = await readInvocation(url);
    if (inv) return inv;
    if (Date.now() >= deadline) {
      throw new Error(
        `Canary produced no completed invocation within ${Math.round(POLL_TIMEOUT_MS / 1000)}s ` +
          `(${attempts} polls). The turn was never recorded or never finished — check the canary ` +
          `service logs for the trigger response, not this script.`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function main() {
  const inv = await fetchMostRecentCanaryInvocation();
  const failures: string[] = [];
  if (inv.outcome !== 'success') failures.push(`outcome=${inv.outcome}`);
  for (const tc of inv.tool_calls) {
    if (!tc.result?.success) failures.push(`${tc.name}: ${tc.result?.error ?? 'no error string'}`);
    if (JSON.stringify(tc.result ?? {}).includes('Standard tool')) {
      failures.push(`${tc.name}: STUB FALLBACK FIRED`);
    }
  }
  if (failures.length > 0) {
    scrubLogger.error({
      event: 'canary_run_outcome',
      canary_tenant_id: process.env.CANARY_TENANT_ID ?? NIL_UUID,
      outcome: 'error',
      failed_tools: failures,
    });
    throw new Error(`Canary failed: ${failures.join('; ')}`);
  }
  scrubLogger.info({
    event: 'canary_run_outcome',
    canary_tenant_id: process.env.CANARY_TENANT_ID ?? NIL_UUID,
    outcome: 'success',
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
