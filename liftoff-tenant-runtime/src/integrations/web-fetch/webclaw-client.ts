import { logger } from '../../infrastructure/logging';
import type { CredentialScope } from './credential-scope';
import { getWebToolCredential, type WebToolCredential } from './web-tool-secrets';
import { BYOKVendorError, type VendorErrorCode } from './types';
import { buildByokErrorMessage, markConnectorErrored } from './byok-error-handler';
import { observeVendorResponse } from './credential-pool';
import type {
  WebFetchAdvancedClient, WebFetchAdvancedRequest, InternalWebFetchAdvancedResult,
  WebExtractRequest, InternalWebExtractResult,
  WebResearchRequest, InternalWebResearchResult,
  WebDiffRequest, InternalWebDiffResult,
} from './types';

const WEBCLAW_BASE_URL = 'https://api.webclaw.io';
const WEBCLAW_TIMEOUT_MS = 30_000;
// Pro tier reference cost — informational only since BYOK vendors are
// billed to the tenant directly (see platform-backend Phase 6 bypass).
const USD_PER_CREDIT = 0.000316;

interface WebClawScrapeResponse {
  url: string;
  metadata: { title?: string; word_count?: number };
  markdown?: string;
  text?: string;
}

export class WebClawError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly body?: unknown) {
    super(message); this.name = 'WebClawError';
  }
}

/** A router-bound request: the tenant, and which of its connectors may serve
 *  (credential-scope.ts). The scope is required so the compiler refuses a call
 *  that has not decided it. */
type WithTenant<T> = T & { tenantId: string; credentialScope: CredentialScope };

export class WebClawClient implements WebFetchAdvancedClient {
  readonly vendor = 'webclaw' as const;

  supportsSessions(): boolean { return false; }

  private async credential(tenantId: string, scope: CredentialScope): Promise<WebToolCredential> {
    return getWebToolCredential(tenantId, 'webclaw', scope);
  }

  classifyVendorError(error: unknown): VendorErrorCode | null {
    if (!(error instanceof WebClawError)) return null;
    const status = error.statusCode;
    if (status === 401 || status === 403) return 'invalid_key';
    if (status === 402) return 'insufficient_funds';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'vendor_down';
    return null;
  }

  async fetch(req: WithTenant<WebFetchAdvancedRequest>): Promise<InternalWebFetchAdvancedResult> {
    if (req.sessionId) throw new Error('WebClaw does not support sessions');
    const body = {
      url: req.url,
      formats: ['markdown'],
      only_main_content: true,
      ...(req.waitFor ? { actions: this.mapWaitFor(req.waitFor) } : {}),
    };
    const data = await this.call<WebClawScrapeResponse>('/v1/scrape', body, req);
    if (!data.markdown || data.markdown.length === 0) {
      throw new WebClawError('Empty markdown from WebClaw (likely antibot block)', 200);
    }
    const credits = 1 + (req.waitFor ? 2 : 0);
    return {
      content: data.markdown,
      finalUrl: data.url,
      sessionId: undefined,
      vendor: 'webclaw',
      costMicros: Math.round(credits * USD_PER_CREDIT * 1_000_000),
      jsRendered: !!req.waitFor,
    };
  }

  async extract(req: WithTenant<WebExtractRequest>): Promise<InternalWebExtractResult> {
    const body = { url: req.url, schema: req.schema, prompt: req.prompt };
    const data = await this.call<{ url: string; data: unknown }>(
      '/v1/extract', body, req,
    );
    return {
      data: data.data,
      finalUrl: data.url,
      vendor: 'webclaw',
      costMicros: Math.round(25 * USD_PER_CREDIT * 1_000_000),
      jsRendered: false,
    };
  }

  async research(req: WithTenant<WebResearchRequest>): Promise<InternalWebResearchResult> {
    const body = {
      query: req.question,
      max_sources: req.maxSources ?? 10,
      ...(req.outputSchema ? { schema: req.outputSchema } : {}),
    };
    const data = await this.call<{
      report: string;
      sources: Array<{ url: string; title: string; words?: number }>;
    }>('/v1/research', body, req);
    return {
      answer: data.report,
      sources: data.sources.map(s => ({ url: s.url, title: s.title })),
      vendor: 'webclaw',
      costMicros: Math.round((25 + (req.maxSources ?? 10) * 2) * USD_PER_CREDIT * 1_000_000),
    };
  }

  async diff(req: WithTenant<WebDiffRequest>): Promise<InternalWebDiffResult> {
    const previous = await this.call<{
      url: string; metadata: object; markdown?: string; text?: string;
    }>('/v1/scrape',
       { url: req.urlA, formats: ['markdown', 'text'], only_main_content: true }, req);

    const data = await this.call<{
      status: string;
      text_diff: string;
      metadata_changes: unknown;
      links_added: string[];
      links_removed: string[];
      word_count_delta: number;
    }>('/v1/diff', {
      url: req.urlB,
      previous: {
        url: req.urlA,
        metadata: previous.metadata,
        markdown: previous.markdown ?? '',
        text: previous.text ?? '',
      },
    }, req);
    return {
      status:           data.status,
      textDiff:         data.text_diff,
      metadataChanges:  data.metadata_changes,
      linksAdded:       data.links_added,
      linksRemoved:     data.links_removed,
      wordCountDelta:   data.word_count_delta,
      vendor: 'webclaw',
      costMicros: Math.round(3 * USD_PER_CREDIT * 1_000_000),
    };
  }

  protected async call<T>(path: string, body: unknown, req: { tenantId: string; credentialScope: CredentialScope }): Promise<T> {
    const { tenantId } = req;
    const cred = await this.credential(tenantId, req.credentialScope);
    let res: Response;
    try {
      res = await fetch(`${WEBCLAW_BASE_URL}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cred.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(WEBCLAW_TIMEOUT_MS),
      });
    } catch (e) {
      throw new WebClawError(`Network: ${(e as Error).message}`, 0);
    }
    // Read what the vendor said about its limits, on every response —
    // a header saying "3 calls left" is only ever on the success path, and
    // it is worth knowing before the fourth call is the one that fails.
    // A 429 also sets this key aside so the next request takes the tenant's
    // next key rather than the one that just asked us to stop.
    observeVendorResponse({
      tenantId, vendor: 'webclaw', connectorId: cred.connectorId,
      status: res.status, headers: res.headers,
    });
    if (!res.ok) {
      let err: { error?: string } | undefined;
      try { err = await res.json() as { error?: string }; } catch { /* response body not JSON */ }
      const wcErr = new WebClawError(
        `WebClaw ${res.status}: ${err?.error ?? res.statusText}`,
        res.status, err,
      );
      const classified = this.classifyVendorError(wcErr);
      if (classified === 'insufficient_funds' || classified === 'invalid_key') {
        await markConnectorErrored(
          tenantId, 'webclaw', cred.connectorId, classified, wcErr.message,
        );
        throw new BYOKVendorError(
          classified, 'webclaw', tenantId, cred.connectorId,
          buildByokErrorMessage('webclaw', classified),
        );
      }
      throw wcErr;
    }
    return await res.json() as T;
  }

  private mapWaitFor(w: NonNullable<WebFetchAdvancedRequest['waitFor']>) {
    switch (w.type) {
      case 'selector':    return [{ type: 'wait', selector: w.value }];
      case 'time':        return [{ type: 'wait', ms: w.ms }];
      case 'networkidle': return [{ type: 'wait', condition: 'networkidle' }];
    }
  }
}

// Reference logger to keep import non-empty in environments where it's unused.
void logger;
