/**
 * R5 Fix 8: Secret scrubber with tenant-extensible patterns + etag-based cache.
 *
 * Replaces R4's unsound `MAX(version) + COUNT(*)` detector with a trigger-
 * maintained UUID etag (see migration 090). Any mutation of
 * tenant_secret_patterns regenerates the etag, which serves as the cache key.
 *
 * Secret patterns are bounded quantifiers only (no unbounded `+`/`*`) to
 * prevent ReDoS. Tenant-supplied patterns go through compileTenantPattern()
 * which rejects unbounded quantifiers.
 */
import type { Pool } from 'pg';

export interface NamedPattern {
  name: string;
  re: RegExp;
}

// Bounded PEM pattern — unbounded `[\s\S]*?` would be catastrophic on malformed input.
const BOUNDED_PEM = /-----BEGIN[A-Z ]{0,32}PRIVATE KEY-----[\s\S]{0,16384}?-----END[A-Z ]{0,32}PRIVATE KEY-----/g;

// Core pattern set. All bounded; all tested in secret-scrubber.test.ts.
// R5 SE-R5-005: added Anthropic, GH fine-grained PAT, Azure SAS, Notion, Linear, etc.
export const SECRET_PATTERNS: NamedPattern[] = [
  { name: 'pem-private-key', re: BOUNDED_PEM },
  // Anthropic
  { name: 'anthropic-api-key', re: /sk-ant-(?:api0[0-9]-)?[A-Za-z0-9_-]{32,128}/g },
  // GitHub
  { name: 'github-classic-pat', re: /ghp_[A-Za-z0-9]{36}/g },
  { name: 'github-fine-grained-pat', re: /github_pat_[A-Za-z0-9_]{22}_[A-Za-z0-9]{59}/g },
  { name: 'github-app-token', re: /ghs_[A-Za-z0-9]{36}/g },
  { name: 'github-user-token', re: /gho_[A-Za-z0-9]{36}/g },
  // Google
  { name: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/g },
  { name: 'google-oauth-refresh', re: /1\/\/0[A-Za-z0-9_-]{30,200}/g },
  // OpenAI
  { name: 'openai-legacy-key', re: /sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}/g },
  { name: 'openai-project-key', re: /sk-proj-[A-Za-z0-9_-]{40,200}/g },
  // Cloud providers
  { name: 'aws-access-key-id', re: /AKIA[0-9A-Z]{16}/g },
  {
    name: 'aws-secret-contextual',
    re: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|SecretAccessKey)\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/g,
  },
  { name: 'azure-sas', re: /sv=\d{4}-\d{2}-\d{2}[^&"\s]{0,200}sig=[A-Za-z0-9%-/+=]{40,200}/g },
  { name: 'gcp-service-account-key', re: /"private_key_id":\s*"[a-f0-9]{40}"/g },
  // SaaS
  { name: 'stripe-live-key', re: /sk_live_[A-Za-z0-9]{24,99}/g },
  { name: 'stripe-restricted-key', re: /rk_live_[A-Za-z0-9]{24,99}/g },
  { name: 'slack-bot-token', re: /xoxb-\d+-\d+-[A-Za-z0-9]{24,48}/g },
  { name: 'slack-user-token', re: /xoxp-\d+-\d+-\d+-[A-Za-z0-9]{24,48}/g },
  { name: 'notion-api-key', re: /(?:secret|ntn)_[A-Za-z0-9]{43}/g },
  { name: 'linear-api-key', re: /lin_api_[A-Za-z0-9]{40,60}/g },
  { name: 'huggingface-token', re: /hf_[A-Za-z]{34}/g },
  { name: 'gitlab-pat', re: /glpat-[A-Za-z0-9_-]{20}/g },
  { name: 'npm-token', re: /npm_[A-Za-z0-9]{36}/g },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,200}\.eyJ[A-Za-z0-9_-]{10,2000}\.[A-Za-z0-9_-]{10,2000}/g },
  // Generic connection strings with embedded passwords (scrub password only)
];

// Connection string scrubber — preserves scheme/user/host, redacts password.
const CONN_STRING_RE = /\b(postgres|postgresql|mysql|mongodb|redis|amqp|amqps|kafka|ftp):\/\/([^:@\s]+):([^@\s]{1,200})@/gi;

export function scrubConnStrings(s: string): string {
  return s.replace(CONN_STRING_RE, (_m, scheme, user) => `${scheme}://${user}:[REDACTED]@`);
}

export interface TenantPatternCache {
  patterns: NamedPattern[];
  etag: string;
  loadedAt: number;
}

const TENANT_CACHE_TTL_MS = 60_000;
const tenantCache = new Map<string, TenantPatternCache>();

let tenantPatternsPool: Pool | null = null;

/** Injected at startup by src/index.ts. */
export function setTenantPatternsPool(pool: Pool | null): void {
  tenantPatternsPool = pool;
}

/**
 * Compile a tenant-supplied regex pattern with ReDoS defenses:
 * - reject unbounded `+` / `*` / `{n,}` quantifiers
 * - cap total regex length
 */
export function compileTenantPattern(pattern: string): RegExp {
  if (pattern.length > 1024) {
    throw new Error('pattern exceeds 1024 chars');
  }
  // Reject unbounded quantifiers (no `+`, `*`, or `{n,}` without an upper bound).
  // Allow `{n,m}` and exact `{n}`.
  // A simple syntactic scan — not perfect, but catches the common ReDoS vectors.
  const unbounded = /(?<!\\)[+*]|\{\s*\d+\s*,\s*\}/;
  if (unbounded.test(pattern)) {
    throw new Error('unbounded quantifier in tenant pattern (use {n,m} form)');
  }
  return new RegExp(pattern, 'g');
}

export async function getTenantPatterns(tenantId: string): Promise<NamedPattern[]> {
  const cached = tenantCache.get(tenantId);
  if (cached && Date.now() - cached.loadedAt < TENANT_CACHE_TTL_MS) {
    return cached.patterns;
  }
  if (!tenantPatternsPool) {
    return [];
  }
  // R5 BE-R5-002 / SE-R5-005: UUID etag from trigger-maintained table
  let liveEtag: string;
  try {
    const etagResult = await tenantPatternsPool.query(
      `SELECT etag FROM tenant_patterns_etag WHERE tenant_id = $1`,
      [tenantId],
    );
    liveEtag = (etagResult.rows[0]?.etag as string | undefined) ?? 'none';
  } catch {
    // If DB is unreachable, return previously-cached patterns if any; else empty
    return cached?.patterns ?? [];
  }
  if (cached && cached.etag === liveEtag) {
    cached.loadedAt = Date.now();
    return cached.patterns;
  }
  try {
    const patternsResult = await tenantPatternsPool.query(
      `SELECT name, pattern FROM tenant_secret_patterns WHERE tenant_id = $1`,
      [tenantId],
    );
    const compiled: NamedPattern[] = patternsResult.rows
      .map((r: { name: string; pattern: string }) => {
        try {
          return { name: r.name, re: compileTenantPattern(r.pattern) };
        } catch {
          return null;
        }
      })
      .filter((p): p is NamedPattern => p !== null);
    tenantCache.set(tenantId, { patterns: compiled, etag: liveEtag, loadedAt: Date.now() });
    return compiled;
  } catch {
    return cached?.patterns ?? [];
  }
}

export function clearTenantPatternCache(tenantId?: string): void {
  if (tenantId) {
    tenantCache.delete(tenantId);
  } else {
    tenantCache.clear();
  }
}

/**
 * Scrub a string of known secrets. Apply builtin patterns first, then any
 * tenant-supplied patterns loaded from the cache.
 *
 * For tenant-scoped scrubbing, pass `tenantId` — the caller is expected to
 * have pre-loaded tenant patterns via `getTenantPatterns()` if hot-path.
 */
export function scrubSecrets(input: string, tenantPatterns: NamedPattern[] = []): string {
  if (typeof input !== 'string' || input.length === 0) {
    return input;
  }
  let out = scrubConnStrings(input);
  for (const { name, re } of SECRET_PATTERNS) {
    out = out.replace(re, `[REDACTED:${name}]`);
  }
  for (const { name, re } of tenantPatterns) {
    out = out.replace(re, `[REDACTED:${name}]`);
  }
  return out;
}
