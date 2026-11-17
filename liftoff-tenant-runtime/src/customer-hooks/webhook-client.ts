// Dormant primitive: HMAC-signed, SSRF-guarded outbound webhook for
// pre/post-tool-use policy decisions. Customer-configurable hooks were
// removed; this module is retained so future internal policy callers
// (e.g. DLP scanners) can re-use the HMAC + SSRF transport without
// rebuilding it. No code path currently invokes WebhookClient.

import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { logger } from '../infrastructure/logging';
import type {
  CustomerHook,
  PreToolUseEventPayload,
  PostToolUseEventPayload,
  PreToolUseDecision,
  PostToolUseDecision,
} from './types';

const ALLOWED_PRE_DECISIONS = new Set<PreToolUseDecision>(['allow', 'deny', 'rewrite', 'escalate_to_review']);
const ALLOWED_POST_DECISIONS = new Set<PostToolUseDecision>(['allow', 'rewrite_result', 'redact_result', 'escalate_to_review']);

export interface WebhookCallResult {
  decision: PreToolUseDecision | null;
  reason?: string;
  updatedInput?: Record<string, unknown>;
  httpStatus: number | null;
  latencyMs: number;
  errorCode: 'timeout' | 'http_5xx' | 'http_4xx' | 'malformed' | 'refused' | 'ssrf_blocked' | null;
}

export interface PostWebhookCallResult {
  decision: PostToolUseDecision | null;
  reason?: string;
  rewrittenOutput?: unknown;
  httpStatus: number | null;
  latencyMs: number;
  errorCode: WebhookCallResult['errorCode'];
}

const DNS_CACHE_TTL_MS = 5 * 60 * 1000;
const dnsCache = new Map<string, { ips: string[]; at: number }>();

async function resolveAndCheck(url: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const host = new URL(url).hostname;
  let entry = dnsCache.get(host);
  if (!entry || Date.now() - entry.at > DNS_CACHE_TTL_MS) {
    try {
      const [a4, a6] = await Promise.allSettled([dns.resolve4(host), dns.resolve6(host)]);
      const ips = [
        ...(a4.status === 'fulfilled' ? a4.value : []),
        ...(a6.status === 'fulfilled' ? a6.value : []),
      ];
      entry = { ips, at: Date.now() };
      dnsCache.set(host, entry);
    } catch {
      return { ok: false, reason: 'dns_lookup_failed' };
    }
  }
  if (entry.ips.length === 0) return { ok: false, reason: 'no_dns_records' };
  for (const ip of entry.ips) {
    if (isPrivateOrSensitive(ip)) return { ok: false, reason: `resolved_to_private_ip:${ip}` };
  }
  return { ok: true };
}

function isPrivateOrSensitive(ip: string): boolean {
  // IPv4
  if (/^10\./.test(ip)) return true;
  if (/^127\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;       // link-local (incl. cloud metadata 169.254.169.254)
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return true;
  if (/^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(ip)) return true;  // CGNAT
  // IPv6
  if (ip === '::1') return true;
  if (/^fe80:/i.test(ip)) return true;            // link-local
  if (/^fc/i.test(ip) || /^fd/i.test(ip)) return true;  // unique local
  return false;
}

export interface WebhookClientOptions {
  /**
   * Override the SSRF resolve-and-check step. Production leaves this undefined
   * (default `resolveAndCheck` is used, which blocks private + loopback IPs).
   * Tests can inject a permissive check to exercise real HTTP transport
   * against an in-process loopback server. NEVER set in production code.
   */
  ssrfCheck?: (url: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

export class WebhookClient {
  private readonly ssrfCheck: (url: string) => Promise<{ ok: true } | { ok: false; reason: string }>;

  /**
   * @param resolveSecret given an hmac_secret_ref, return the secret material.
   *                      Provided by caller so this module doesn't pull in Secret Manager.
   * @param options       optional test seam — see WebhookClientOptions.
   */
  constructor(
    private resolveSecret: (ref: string) => Promise<string>,
    options: WebhookClientOptions = {},
  ) {
    this.ssrfCheck = options.ssrfCheck ?? resolveAndCheck;
  }

  async call(hook: CustomerHook, payload: PreToolUseEventPayload): Promise<WebhookCallResult> {
    return this.dispatch(hook, payload, validatePreResponse, (v) => ({
      decision: v.decision,
      reason: v.reason,
      updatedInput: v.updatedInput,
    }));
  }

  async callPost(hook: CustomerHook, payload: PostToolUseEventPayload): Promise<PostWebhookCallResult> {
    return this.dispatch(hook, payload, validatePostResponse, (v) => ({
      decision: v.decision,
      reason: v.reason,
      rewrittenOutput: v.rewrittenOutput,
    }));
  }

  /**
   * Shared transport for Pre/Post webhook calls. Handles secret resolution,
   * SSRF re-check, signing, timeout/error mapping. Caller supplies the response
   * validator and the projection from validator output to the per-event result
   * shape. Keeps the on-the-wire contract (HMAC, headers, timeout semantics)
   * defined once.
   */
  private async dispatch<TPayload, TValid, TResult extends { decision: TValid extends { decision: infer D } ? D | null : never }>(
    hook: CustomerHook,
    payload: TPayload,
    validate: (obj: unknown) => TValid | null,
    project: (v: TValid) => Omit<TResult, 'httpStatus' | 'latencyMs' | 'errorCode' | 'decision'> & { decision: TValid extends { decision: infer D } ? D : never },
  ): Promise<TResult & { httpStatus: number | null; latencyMs: number; errorCode: WebhookCallResult['errorCode'] }> {
    const startedAt = Date.now();
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(startedAt / 1000).toString();
    const emptyResult = (
      errorCode: WebhookCallResult['errorCode'],
      httpStatus: number | null,
    ) => ({
      decision: null,
      httpStatus,
      latencyMs: Date.now() - startedAt,
      errorCode,
    }) as unknown as TResult & { httpStatus: number | null; latencyMs: number; errorCode: WebhookCallResult['errorCode'] };

    let signature: string;
    try {
      const secret = await this.resolveSecret(hook.hmacSecretRef);
      signature = computeSignature(secret, timestamp, body);
    } catch (err) {
      logger.error({ hookId: hook.id, err }, 'Failed to resolve hook secret');
      return emptyResult('malformed', null);
    }

    const dnsCheck = await this.ssrfCheck(hook.webhookUrl);
    if (dnsCheck.ok === false) {
      logger.warn({ hookId: hook.id, reason: dnsCheck.reason }, 'Hook URL blocked by SSRF check');
      return emptyResult('ssrf_blocked', null);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), hook.timeoutMs);
    try {
      const res = await fetch(hook.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Liftoff-Signature': `t=${timestamp},v1=${signature}`,
          'X-Liftoff-Hook-Id': hook.id,
        },
        body,
        signal: controller.signal,
      });
      const latencyMs = Date.now() - startedAt;
      if (res.status >= 500) return emptyResult('http_5xx', res.status);
      if (res.status >= 400) return emptyResult('http_4xx', res.status);

      let parsed: unknown;
      try { parsed = await res.json(); }
      catch { return emptyResult('malformed', res.status); }

      const valid = validate(parsed);
      if (!valid) return emptyResult('malformed', res.status);

      return {
        ...project(valid),
        httpStatus: res.status,
        latencyMs,
        errorCode: null,
      } as unknown as TResult & { httpStatus: number | null; latencyMs: number; errorCode: WebhookCallResult['errorCode'] };
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        return emptyResult('timeout', null);
      }
      return emptyResult('refused', null);
    } finally {
      clearTimeout(timer);
    }
  }
}

function computeSignature(secret: string, timestamp: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

function validatePreResponse(obj: unknown): {
  decision: PreToolUseDecision;
  reason?: string;
  updatedInput?: Record<string, unknown>;
} | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.decision !== 'string' || !ALLOWED_PRE_DECISIONS.has(o.decision as PreToolUseDecision)) return null;
  if (o.decision === 'rewrite' && (!o.updatedInput || typeof o.updatedInput !== 'object')) return null;
  if (o.reason !== undefined && typeof o.reason !== 'string') return null;
  return {
    decision: o.decision as PreToolUseDecision,
    reason: typeof o.reason === 'string' ? o.reason : undefined,
    updatedInput: o.updatedInput as Record<string, unknown> | undefined,
  };
}

function validatePostResponse(obj: unknown): {
  decision: PostToolUseDecision;
  reason?: string;
  rewrittenOutput?: unknown;
} | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.decision !== 'string' || !ALLOWED_POST_DECISIONS.has(o.decision as PostToolUseDecision)) return null;
  if (o.decision === 'rewrite_result' && o.rewrittenOutput === undefined) return null;
  if (o.reason !== undefined && typeof o.reason !== 'string') return null;
  return {
    decision: o.decision as PostToolUseDecision,
    reason: typeof o.reason === 'string' ? o.reason : undefined,
    rewrittenOutput: o.rewrittenOutput,
  };
}
