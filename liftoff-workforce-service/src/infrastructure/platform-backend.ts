// One POST to platform-backend, service-authed, for every caller here.
//
// This was a private function inside `workforce-plans/tools/capability.ts`,
// which was the right place while the capability tools were its only caller.
// The parking seam is a second caller and it is not a tool — it sits inside
// the platform-agent loop, above the tools — so the call itself is promoted
// here rather than copied. A second copy is how the audience, the timeout and
// the degraded-read posture come to differ between two callers of one service.
//
// TWO SHAPES, because the two callers want different halves of the answer. A
// tool wants the model-facing string and nothing else; the parking seam wants
// the whole body, because what comes back is a rewritten result. Both go
// through the same request, so the auth, the audience and the failure reading
// cannot differ between them.

import { loadConfig } from './config.js';
import { getServiceAuthHeaders } from './service-auth.js';

/** A response, or the reason there is not one. `status` is 0 for a request
 *  that never got an answer (a timeout, a refused connection): it is a
 *  different fact from a 413, and a caller deciding what to tell a model
 *  should be able to tell them apart. */
export type PbResponse =
  | { ok: true; json: Record<string, unknown> }
  | { ok: false; status: number; detail: string };

/**
 * POST to a platform-backend route and return the whole body.
 *
 * Throws only what `fetch` throws — a transport failure or an abort. A NON-2XX
 * is not a throw: it comes back as `{ ok: false, status }`, which is what lets
 * a caller distinguish "too large" from "not configured" from "the service is
 * down" and answer each of them truthfully.
 */
export async function pbPostJson(
  path: string,
  body: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<PbResponse> {
  const pbUrl = loadConfig().PLATFORM_BACKEND_URL.replace(/\/$/, '');
  const headers = await getServiceAuthHeaders(pbUrl, loadConfig().WORKFORCE_SERVICE_TOKEN);
  const res = await fetch(`${pbUrl}${path}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, status: res.status, detail: detail.slice(0, 300) };
  }
  return { ok: true, json: (await res.json()) as Record<string, unknown> };
}

/** The model-facing half: the `result` string a capability route answers with,
 *  or a degraded read STATED in the payload (never thrown), the same posture
 *  connectors__list_available takes. */
export async function pbPost(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await pbPostJson(path, body);
  if (!res.ok) {
    return { error: `the capability service returned HTTP ${res.status}`, detail: res.detail };
  }
  return { result: (res.json as { result?: string }).result ?? '' };
}
