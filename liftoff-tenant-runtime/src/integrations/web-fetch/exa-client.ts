// Exa vendor client. Implements the WebFetchAdvancedClient contract for
// fetch + research. extract() is intentionally NOT implemented — Exa's
// /answer supports outputSchema for ANSWER-shape JSON, not page-content
// extraction, so it cannot satisfy our schema-guided extract(url, schema)
// contract. router.ts:extract() chain omits 'exa' (same as 'perplexity').
//
// Cost model — EXACT capture from response (Perplexity precedent):
//   - Every Exa response includes costDollars.total (float, USD). We read
//     it directly into costMicros = round(total * 1_000_000). NEVER
//     approximated, NEVER constant-derived.
//   - Missing costDollars.total is a hard contract break — throw
//     ExaError(MISSING_COST_STATUS) so the OU ledger is never silently
//     under-billed. Router classifies 422 as healthy non-transient.

import { logger } from '../../infrastructure/logging';
import type { CredentialScope } from './credential-scope';
import { getWebToolCredential, getWebToolSecret, VendorNotConnected } from './web-tool-secrets';
import { BYOKVendorError, type VendorErrorCode, type WebToolFunding } from './types';
import { buildByokErrorMessage, markConnectorErrored } from './byok-error-handler';
import { observeVendorResponse } from './credential-pool';
import type {
  WebFetchAdvancedClient,
  WebFetchAdvancedRequest, InternalWebFetchAdvancedResult,
  WebResearchRequest, InternalWebResearchResult,
} from './types';

const EXA_BASE_URL = 'https://api.exa.ai';
const EXA_TIMEOUT_MS = 30_000;

const MISSING_COST_STATUS = 422;
const MAX_RESULTS_CEILING = 25;

interface ExaCostDollars {
  total: number;
}

interface ExaContentsResult {
  url: string;
  title?: string;
  text: string;
  author?: string;
  publishedDate?: string | null;
}

interface ExaContentsResponse {
  results: ExaContentsResult[];
  costDollars: ExaCostDollars;
  requestId: string;
}

interface ExaAnswerCitation {
  url: string;
  title?: string;
  text?: string;
  publishedDate?: string | null;
  author?: string | null;
}

interface ExaAnswerResponse {
  answer: string;
  citations: ExaAnswerCitation[];
  costDollars: ExaCostDollars;
  requestId: string;
}

interface ExaErrorBody {
  requestId?: string;
  error?: string;
  tag?: string;
}

export class ExaError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly body?: unknown) {
    super(message); this.name = 'ExaError';
  }
}

function exactCostMicros(costDollars: ExaCostDollars | undefined, context: string): number {
  const total = costDollars?.total;
  if (typeof total !== 'number') {
    throw new ExaError(
      `Exa response missing costDollars.total (${context}) — cannot bill OU ledger without exact cost`,
      MISSING_COST_STATUS,
    );
  }
  if (total < 0) {
    throw new ExaError(
      `Exa reported negative costDollars.total=${total} (${context}) — refusing to bill OU ledger`,
      MISSING_COST_STATUS,
    );
  }
  return Math.round(total * 1_000_000);
}

/** A router-bound request: the tenant, and which of its connectors may serve
 *  (credential-scope.ts). The scope is required so the compiler refuses a call
 *  that has not decided it. */
type WithTenant<T> = T & { tenantId: string; credentialScope: CredentialScope };

export class ExaClient implements WebFetchAdvancedClient {
  readonly vendor = 'exa' as const;

  supportsSessions(): boolean { return false; }

  /** Whose account pays for this call, decided in exactly one place.
   *
   *  A team bound to the workspace's own exa connector uses that key and
   *  is billed by the vendor directly. A team bound to nothing gets the
   *  platform's pay-as-you-go key, and the call is metered against its
   *  Operating Units at the vendor's real charge (funding 'platform'). The
   *  connector id is the carrier: a tenant credential has one, the platform
   *  key does not, and null is the whole signal. A COOLING tenant key is
   *  deliberately NOT failed over to the platform key (VendorConnectorErrored
   *  propagates); only "no connector at all" falls back. */
  private async credential(tenantId: string, scope: CredentialScope): Promise<{ apiKey: string; connectorId: string | null }> {
    try {
      const cred = await getWebToolCredential(tenantId, 'exa', scope);
      return { apiKey: cred.apiKey, connectorId: cred.connectorId };
    } catch (err) {
      if (!(err instanceof VendorNotConnected)) throw err;
    }
    // A platform key that cannot be read is the vendor being out, not a
    // caller mistake: typed as a 503 so the router parks the rung for the
    // health window instead of spending an attempt on it every call.
    try {
      return { apiKey: await getWebToolSecret('exa-api-key'), connectorId: null };
    } catch (err) {
      throw new ExaError(`exa platform key unavailable: ${(err as Error).message}`, 503);
    }
  }

  classifyVendorError(error: unknown): VendorErrorCode | null {
    if (!(error instanceof ExaError)) return null;
    const status = error.statusCode;
    if (status === 401 || status === 403) return 'invalid_key';
    if (status === 402) return 'insufficient_funds';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'vendor_down';
    return null;
  }

  async fetch(req: WithTenant<WebFetchAdvancedRequest>): Promise<InternalWebFetchAdvancedResult> {
    if (req.sessionId)        throw new ExaError('Exa does not support sessions', 400);
    if (req.vendorProfileId)  throw new ExaError('Exa does not support vendor profiles (no session)', 400);
    if (req.vendorIdentityId) throw new ExaError('Exa does not support vendor identities (no session)', 400);

    const { data, funding } = await this.call<ExaContentsResponse>('/contents', {
      urls: [req.url],
      text: true,
    }, req);
    const hit = data.results[0];
    const content = hit?.text ?? '';
    if (content.length === 0) {
      throw new ExaError('Empty content from Exa /contents (likely antibot block or unsupported URL)', 200);
    }
    return {
      content,
      finalUrl: hit?.url ?? req.url,
      sessionId: undefined,
      vendor: 'exa',
      costMicros: exactCostMicros(data.costDollars, 'contents'),
      jsRendered: false,
      ...(funding ? { funding } : {}),
    };
  }

  async research(req: WithTenant<WebResearchRequest>): Promise<InternalWebResearchResult> {
    const max = Math.min(req.maxSources ?? 10, MAX_RESULTS_CEILING);
    const { data, funding } = await this.call<ExaAnswerResponse>('/answer', {
      query: req.question,
      text: true,
    }, req);
    const trimmedCitations = data.citations.slice(0, max);
    const sources = trimmedCitations.map(c => ({
      url: c.url,
      title: c.title ?? c.url,
      snippet: (c.text ?? '').slice(0, 500),
    }));
    return {
      answer: data.answer,
      sources,
      vendor: 'exa',
      costMicros: exactCostMicros(data.costDollars, 'answer'),
      ...(funding ? { funding } : {}),
    };
  }

  protected async call<T>(path: string, body: unknown, req: { tenantId: string; credentialScope: CredentialScope }): Promise<{ data: T; funding?: WebToolFunding }> {
    const { tenantId } = req;
    const cred = await this.credential(tenantId, req.credentialScope);
    let res: Response;
    try {
      res = await fetch(`${EXA_BASE_URL}${path}`, {
        method: 'POST',
        headers: {
          'x-api-key':   cred.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(EXA_TIMEOUT_MS),
      });
    } catch (e) {
      throw new ExaError(`Network: ${(e as Error).message}`, 0);
    }
    // Read what the vendor said about its limits, on every response —
    // a header saying "3 calls left" is only ever on the success path, and
    // it is worth knowing before the fourth call is the one that fails.
    // A 429 also sets this key aside so the next request takes the tenant's
    // next key rather than the one that just asked us to stop.
    // The pool's bookkeeping is per connector row; the platform key has none.
    if (cred.connectorId !== null) {
      observeVendorResponse({
        tenantId, vendor: 'exa', connectorId: cred.connectorId,
        status: res.status, headers: res.headers,
      });
    }
    if (!res.ok) {
      let err: ExaErrorBody | undefined;
      try { err = await res.json() as ExaErrorBody; } catch { /* response body not JSON */ }
      const eErr = new ExaError(
        `Exa ${res.status}: ${err?.error ?? res.statusText}${err?.tag ? ` [${err.tag}]` : ''}`,
        res.status, err,
      );
      const classified = this.classifyVendorError(eErr);
      // On the platform key an exhausted or refused account is our funding
      // matter, not the workspace's: it leaves as the vendor's own error and
      // the chain moves to the next rung.
      if (cred.connectorId !== null && (classified === 'insufficient_funds' || classified === 'invalid_key')) {
        await markConnectorErrored(
          tenantId, 'exa', cred.connectorId, classified, eErr.message,
        );
        throw new BYOKVendorError(
          classified, 'exa', tenantId, cred.connectorId,
          buildByokErrorMessage('exa', classified),
        );
      }
      throw eErr;
    }
    return { data: await res.json() as T, ...(cred.connectorId === null ? { funding: 'platform' as const } : {}) };
  }
}

// Reference logger to keep import non-empty in environments where it's unused.
void logger;
