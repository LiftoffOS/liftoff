// Connector Content Indexer
//
// Fire-and-forget from tool-gateway after the guardrail loop.
// Indexes read-action results into the connector_content table so they
// are available for hybrid BM25+HNSW retrieval.
//
// Failures NEVER propagate — log at WARN level only.

import crypto from 'crypto';
import { logger } from '../infrastructure/logging';
import { generateEmbeddingsBatch } from '../memory/embedding';
import { withTenantScope } from '../infrastructure/database';
import { connectorManifestRepository } from '../connectors/manifest-repository';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IndexInput {
  tenantId: string;
  agentId: string;
  connector: string;       // e.g. "slack"
  actionType: string;
  idempotencyKey: string;
  data: unknown;           // result.data from tool call
}

// ---------------------------------------------------------------------------
// Semaphore — limit max concurrent indexing calls to 3
// ---------------------------------------------------------------------------

let activeCount = 0;
const MAX_CONCURRENT = 3;
const queue: Array<() => void> = [];

function acquireSemaphore(): Promise<void> {
  return new Promise(resolve => {
    if (activeCount < MAX_CONCURRENT) {
      activeCount++;
      resolve();
    } else {
      queue.push(() => {
        activeCount++;
        resolve();
      });
    }
  });
}

function releaseSemaphore(): void {
  const next = queue.shift();
  if (next) {
    next();
  } else {
    activeCount--;
  }
}

// ---------------------------------------------------------------------------
// isReadAction heuristic
// ---------------------------------------------------------------------------

function isReadAction(actionType: string): boolean {
  const lower = actionType.toLowerCase();
  return (
    lower.startsWith('get') ||
    lower.startsWith('read') ||
    lower.startsWith('list') ||
    lower.startsWith('fetch') ||
    lower.startsWith('search') ||
    lower.startsWith('find')
  );
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

const TEXT_FIELDS = new Set([
  'text', 'body', 'content', 'description', 'summary',
  'notes', 'title', 'subject', 'message', 'snippet',
]);

/** How deep to walk a payload looking for text. A connector response nests a
 *  few levels at most — `{data:{items:[{body:...}]}}` is four — and the cap
 *  keeps a pathological or cyclic-looking payload from turning extraction into
 *  an unbounded walk. */
const MAX_WALK_DEPTH = 8;

/** Ceiling on extracted text. `chunkText` caps the chunks that get embedded,
 *  but without this a large list response would build the whole string first. */
const MAX_EXTRACTED_CHARS = 100_000;

/**
 * Pull the human-readable text out of a connector result.
 *
 * Walks arrays wherever they appear, which the previous version did not: it
 * descended one level of nesting and explicitly skipped arrays, so it could
 * only see text in a bare top-level array or on a flat object. Every wrapper
 * shape a REST list/search endpoint actually returns — `{messages:[...]}`,
 * `{items:[...]}`, `{results:[...]}`, `{data:{items:[...]}}` — hides its text
 * one array below a key that is not itself a text field, and every one of them
 * extracted to '' and was dropped before reaching the database.
 *
 * A string counts only when it was reached THROUGH a text-field key (or is the
 * whole result). That is what keeps id lists, label arrays and base64 blobs —
 * `payload.body.data` on a raw mail message — out of the index while still
 * finding the prose beside them.
 */
function extractTextFromValue(value: unknown): string {
  const parts: string[] = [];
  let total = 0;

  const push = (s: string): void => {
    const trimmed = s.trim();
    if (!trimmed) return;
    parts.push(trimmed);
    total += trimmed.length;
  };

  const walk = (node: unknown, depth: number, viaTextField: boolean): void => {
    if (total >= MAX_EXTRACTED_CHARS || depth > MAX_WALK_DEPTH) return;

    if (typeof node === 'string') {
      if (viaTextField) push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1, viaTextField);
      return;
    }
    if (node === null || typeof node !== 'object') return;

    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (total >= MAX_EXTRACTED_CHARS) return;
      if (TEXT_FIELDS.has(key.toLowerCase())) {
        // Usually a string; connectors also wrap it (`{body:{data:...}}`), so
        // a container under a text key is walked rather than ignored.
        walk(child, depth + 1, true);
      } else if (child !== null && typeof child === 'object') {
        walk(child, depth + 1, false);
      }
    }
  };

  // The root counts as text: a connector that returns a bare string returns
  // its content, and that is what the old version did too.
  walk(value, 0, true);
  return parts.join(' ');
}

/** Top-level keys of a result, for the drop diagnostic. Names only — a key
 *  name is connector schema, not customer content. */
function shapeHint(value: unknown): string {
  if (Array.isArray(value)) {
    const first = value[0];
    return first !== null && typeof first === 'object' && !Array.isArray(first)
      ? `array<{${Object.keys(first as object).slice(0, 8).join(',')}}>`
      : `array<${typeof first}>`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as object).slice(0, 8).join(',')}}`;
  }
  return typeof value;
}

// ---------------------------------------------------------------------------
// PII redaction
// ---------------------------------------------------------------------------

const PII_PATTERNS: Array<[RegExp, string]> = [
  [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]'],
  [/(\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s][0-9]{3}[-.\s][0-9]{4}/g, '[REDACTED_PHONE]'],
  [/\d{3}-\d{2}-\d{4}/g, '[REDACTED_SSN]'],
  [/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_KEY]'],
  [/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, 'Bearer [REDACTED]'],
];

function redactPII(text: string): string {
  let redacted = text;
  for (const [pattern, replacement] of PII_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

// ---------------------------------------------------------------------------
// Entity ID extraction
// ---------------------------------------------------------------------------

const ID_FIELDS_BEFORE_SYS = ['id', '_id'];
const ID_FIELDS_AFTER_SYS = [
  'nodeId', 'key', 'gid', 'ts',
  'message_ts', 'card_id', 'item_id', 'objectId', 'recordId',
];

function extractEntityId(data: unknown): string | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;

  for (const field of ID_FIELDS_BEFORE_SYS) {
    if (field in obj && obj[field] !== undefined && obj[field] !== null) {
      return String(obj[field]);
    }
  }

  // sys.id (Contentful pattern) — checked 3rd per extraction order
  if ('sys' in obj && obj['sys'] !== null && typeof obj['sys'] === 'object') {
    const sys = obj['sys'] as Record<string, unknown>;
    if ('id' in sys) return String(sys['id']);
  }

  for (const field of ID_FIELDS_AFTER_SYS) {
    if (field in obj && obj[field] !== undefined && obj[field] !== null) {
      return String(obj[field]);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

const CHUNK_CHARS = 1600;    // ~400 tokens
const OVERLAP_CHARS = 400;   // ~100 tokens
const MAX_CHUNKS = 20;
const MIN_CHUNK_CHARS = 150;

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length && chunks.length < MAX_CHUNKS) {
    const end = Math.min(start + CHUNK_CHARS, text.length);
    const chunk = text.slice(start, end);

    if (chunk.length < MIN_CHUNK_CHARS) break;
    chunks.push(chunk);

    // Last chunk — no need to continue
    if (end >= text.length) break;

    start = end - OVERLAP_CHARS;
  }

  return chunks;
}


/**
 * The connector TYPE for a dispatch, whatever the caller called it by.
 *
 * `connector_content.connector_type` is named for a type but was written
 * straight from `input.connector`, which is an ALIAS on the in-process MCP path
 * (`connector: manifest.alias`) and a connector UUID over `/api/v1/tool-calls`.
 * The `search` tool resolves the aliases a model names to `m.connectorType` and
 * filters on that, so a connector-scoped search matched ZERO rows however much
 * the workspace had indexed — and reported coverage 0 beside the empty result,
 * which is the confident false negative this source exists to prevent.
 *
 * Resolved at WRITE time so the column finally holds what its name promises.
 * Falls back to the raw value: an unresolvable connector should still be
 * indexed and findable without a filter, rather than dropped.
 */
const typeCache = new Map<string, string>();

async function resolveConnectorType(tenantId: string, connector: string): Promise<string> {
  const key = `${tenantId}:${connector}`;
  const hit = typeCache.get(key);
  if (hit) return hit;

  let resolved = connector;
  try {
    const byAlias = await connectorManifestRepository.getManifestByAlias(tenantId, connector);
    if (byAlias?.connectorType) {
      resolved = byAlias.connectorType;
    } else if (UUID_RE.test(connector)) {
      const byId = await connectorManifestRepository.getById(tenantId, connector);
      if (byId?.connectorType) resolved = byId.connectorType;
    }
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId, connector },
      'content-indexer: connector type lookup failed; storing the raw identifier',
    );
  }

  typeCache.set(key, resolved);
  return resolved;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Core indexer
// ---------------------------------------------------------------------------

async function doIndex(input: IndexInput): Promise<void> {
  // Extract text
  const rawText = extractTextFromValue(input.data);
  if (rawText.length < MIN_CHUNK_CHARS) {
    // A drop is the failure mode that hid this component for its whole life:
    // extraction returned '' for most connector shapes, the function returned
    // here, and nothing anywhere said so. An empty index then looks exactly
    // like a workspace that has fetched nothing. Log it with the SHAPE (key
    // names only) so the next mismatch is one query away, not an archaeology
    // project.
    logger.info(
      {
        metric: 'connector_content.not_indexed',
        reason: rawText.length === 0 ? 'no_text_extracted' : 'below_min_length',
        tenant_id: input.tenantId,
        connector: input.connector,
        actionType: input.actionType,
        extractedChars: rawText.length,
        minChars: MIN_CHUNK_CHARS,
        shape: shapeHint(input.data),
      },
      'connector content not indexed',
    );
    return;
  }

  // Redact PII
  const redactedText = redactPII(rawText);

  // The connector TYPE, so the column matches its name and the search's filter.
  const connectorType = await resolveConnectorType(input.tenantId, input.connector);

  // Entity ID
  const rawId = extractEntityId(input.data);
  const entityId = rawId
    ? `${connectorType}:${rawId}`
    : `${connectorType}:${crypto.createHash('sha256').update(redactedText).digest('hex').slice(0, 32)}`;

  // Entity type — best-effort from data shape
  const entityType = (input.data !== null && typeof input.data === 'object' && !Array.isArray(input.data))
    ? (String((input.data as Record<string, unknown>).type ?? (input.data as Record<string, unknown>).kind ?? input.actionType))
    : input.actionType;

  // Chunk
  const chunks = chunkText(redactedText);
  if (chunks.length === 0) return;

  // Batch-embed all chunks
  const embeddings = await generateEmbeddingsBatch(chunks, {
    tenantId: input.tenantId,
    agentId: input.agentId,
    purpose: 'embedding_indexing',
    taskType: 'retrieval_document',
  });

  const contentHash = crypto.createHash('sha256').update(redactedText).digest('hex');

  // Tenant-scoped: `connector_content` holds customer business content and is
  // FORCE RLS (migration 372). A raw pool here raises 42704 on the policy and
  // the fire-and-forget catch would swallow it, which is the same silence this
  // component already spent its life in.
  await withTenantScope(input.tenantId, async (client) => {
    for (let i = 0; i < chunks.length; i++) {
      await client.query(
        `INSERT INTO connector_content
           (tenant_id, connector_type, entity_id, entity_type, agent_id,
            chunk_index, content, content_hash, embedding,
            expires_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                 NOW() + INTERVAL '30 days', NOW())
         ON CONFLICT (tenant_id, connector_type, entity_id, chunk_index)
         DO UPDATE SET
           content = EXCLUDED.content,
           content_hash = EXCLUDED.content_hash,
           embedding = EXCLUDED.embedding,
           expires_at = NOW() + INTERVAL '30 days',
           updated_at = NOW()`,
        [
          input.tenantId,
          connectorType,
          entityId,
          entityType,
          input.agentId,
          i,
          chunks[i],
          contentHash,
          JSON.stringify(embeddings[i]),
        ],
      );
    }
  });

  logger.info(
    {
      metric: 'connector_content.indexed',
      tenant_id: input.tenantId,
      connector: input.connector,
      connectorType,
      actionType: input.actionType,
      entityType,
      chunks: chunks.length,
      chars: redactedText.length,
    },
    'connector content indexed',
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const contentIndexer = {
  async indexToolResult(input: IndexInput): Promise<void> {
    // Kill switch
    if (process.env.CONNECTOR_CONTENT_INDEXING_ENABLED !== 'true') return;

    // Only index reads
    if (!isReadAction(input.actionType)) return;

    await acquireSemaphore();
    try {
      await doIndex(input);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, tenantId: input.tenantId, connector: input.connector },
        'content-indexer: indexing error',
      );
    } finally {
      releaseSemaphore();
    }
  },
};
