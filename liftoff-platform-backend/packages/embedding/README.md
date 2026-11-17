# @liftoffos/embedding

Multi-provider embedding client for Liftoff platform services. Wraps OpenAI, Google Vertex AI, and Voyage AI behind a single typed API with classified errors, per-provider retry/timeout/chunking, asymmetric-retrieval hints, and a pluggable usage-event callback for cost ledgers.

Consumed by `liftoff-platform-backend` (knowledge + capability embedding) and `liftoff-tenant-runtime` (memory pipeline).

---

## Design

```
EmbeddingClient (singleton)
  ├── providers : Map<EmbeddingProvider, EmbeddingProviderClient>
  ├── default   : resolved via defaultProvider → defaultPreference → first
  ├── onUsage[] : called on every embed (success + failure)
  └── embed(EmbedCall)

EmbeddingProviderClient
  ├── provider          : 'openai' | 'google' | 'voyage' | (string)
  ├── capabilities      : { taskType, maxBatchSize, matryoshka }
  ├── defaultModel
  └── embed(EmbeddingRequest)
```

**Open provider union.** `EmbeddingProvider = 'openai' | 'google' | 'voyage' | (string & {})` — well-known values get autocomplete; consumers can register Cohere/Mistral/Bedrock/Replicate under any string name without editing the package.

**Single-options call shape.** Everything goes on one object:

```ts
await embeddingClient.embed({
  input: ['chunk1', 'chunk2', ...],
  provider: 'google',            // optional; defaults via preference
  model: 'gemini-embedding-001', // optional; provider has a default
  dimensions: 768,               // Matryoshka where supported
  taskType: 'retrieval_document',// 'retrieval_query' on the other side
  context: { tenantId, agentId, purpose, itemId, ... },  // for onUsage
});
```

**Caller-owned persistence.** The package never touches a database. Consumers register an `onUsage` callback that writes the event into their own ledger (`llm_usage_log` in platform-backend, `usage_ledger` in tenant-runtime). Same pattern as `@liftoffos/service-client`'s LLM client.

---

## Quickstart

```ts
import OpenAI from 'openai';
import {
  embeddingClient,
  OpenAIEmbeddingProvider,
  GoogleEmbeddingProvider,
  VoyageEmbeddingProvider,
  type EmbeddingUsageEvent,
} from '@liftoffos/embedding';

// 1. Init once at startup. Only register providers whose credentials are present.
embeddingClient.init({
  providers: {
    ...(process.env.OPENAI_API_KEY && {
      openai: new OpenAIEmbeddingProvider(new OpenAI({ apiKey: process.env.OPENAI_API_KEY })),
    }),
    ...(process.env.GCP_PROJECT_ID && {
      google: new GoogleEmbeddingProvider({
        projectId: process.env.GCP_PROJECT_ID,
        location: process.env.GCP_LOCATION ?? 'us-west1',
      }),
    }),
    ...(process.env.VOYAGE_API_KEY && {
      voyage: new VoyageEmbeddingProvider(process.env.VOYAGE_API_KEY),
    }),
  },
  defaultPreference: ['google', 'voyage', 'openai'],
});

// 2. Wire your ledger.
embeddingClient.onUsage(async (event: EmbeddingUsageEvent) => {
  await myLedger.insert({
    timestamp: event.timestamp,
    provider:  event.provider,
    model:     event.model,
    tokens:    event.inputTokens,
    success:   event.success,
    error:     event.error,
    ...event.context,  // tenantId, agentId, purpose, itemId, ...
  });
});

// 3. Embed.
const r = await embeddingClient.embed({
  input: 'what does the leave policy say?',
  taskType: 'retrieval_query',
  context: { tenantId, agentId, purpose: 'knowledge_query' },
});
// r.embeddings: number[][], r.promptTokens, r.model, r.provider
```

---

## Providers

| Provider | Default model           | Default dim | Max batch | taskType |
|----------|-------------------------|-------------|-----------|----------|
| `openai` | `text-embedding-3-small`| 1536        | 2048      | ignored (symmetric) |
| `google` | `gemini-embedding-001`  | 768         | 250       | `RETRIEVAL_QUERY`/`RETRIEVAL_DOCUMENT` per instance |
| `voyage` | `voyage-4`              | 1024        | 128       | `input_type: 'query'`/`'document'` |

All three accept Matryoshka-style `dimensions` truncation where the model supports it:

- OpenAI: 256–1536 (small) or 256–3072 (large)
- Google `gemini-embedding-001`: 128/256/512/768/1536/3072
- Voyage `voyage-4`: 256/512/1024/2048

`text-embedding-004` (Google) ignores `outputDimensionality` and always returns 768d — set `dimensions: 768` and you're consistent.

### Per-provider behavior

**OpenAI** uses the official SDK, which carries its own retries (default 2) and 10-minute timeout. We add input chunking (>2048 per call → split) and wrap SDK errors into `EmbeddingError` with `kind` derived from `.status`.

**Google Vertex AI** uses raw `fetch` against `:predict` endpoints with GCP service-account auth via `google-auth-library`. We add a 30s timeout (`AbortController`), 2-retry exponential-backoff for 5xx/429 (honoring `Retry-After`), and input chunking at 250.

**Voyage** uses raw `fetch` against `api.voyageai.com`. Same retry/timeout/chunking as Google, with the input limit at 128.

All three return a normalized `EmbeddingResponse`:
```ts
{ embeddings: number[][], promptTokens: number, model: string, provider: EmbeddingProvider }
```

### Per-call transport bounds

`timeoutMs` and `retries` on the call override the provider defaults for that call only, and forward all the way into the transport — a timed-out call is truly **aborted** (`AbortController`), not abandoned, so there is no orphaned request and no billed-but-discarded success. Latency-bounded query paths pass a short deadline with no retries:

```ts
embed({ input: userQuery, taskType: 'retrieval_query', timeoutMs: 2500, retries: 0, context });
```

Omit both to keep the provider defaults (OpenAI: 2 retries / 10-min timeout; Google + Voyage: 2 retries / 30s timeout via `fetchJsonWithRetry`).

### Drift detection

`embeddingClient.getDefaultEmbeddingSpace()` returns `{ provider, model }` for the space a default `embed()` currently produces (or `undefined` before `init()`). Consumers that persist vectors use it to find and re-embed rows whose stored provider/model no longer matches the current default, since vectors from different spaces must never be compared.

---

## Asymmetric retrieval

For knowledge / capability search, query and document should be embedded with different hints. Google and Voyage produce a 3–7 point MTEB lift when used this way:

```ts
// Indexer
embed({ input: docChunks, taskType: 'retrieval_document', ... });

// Search
embed({ input: userQuery,  taskType: 'retrieval_query', ... });
```

OpenAI's `text-embedding-3-*` are symmetric and ignore the hint. Check support before relying on it:

```ts
if (embeddingClient.capabilitiesOf('openai')?.taskType === false) {
  // OpenAI won't use the hint; that's fine, the call still succeeds
}
```

---

## Error classification

All failures throw `EmbeddingError` with a `kind`:

| `kind`        | HTTP class     | Recommended action |
|---------------|----------------|--------------------|
| `transient`   | 5xx, timeout, network | Retried internally; reaching this means retries exhausted — surface and back off |
| `auth`        | 401, 403       | Refresh credentials; do NOT retry blindly |
| `rate_limit`  | 429            | Back off longer; retried internally with `Retry-After` |
| `invalid`     | 4xx (excl. 401/403/429) | Code bug — fix the request |
| `unknown`     | anything else  | Investigate |

```ts
try {
  await embeddingClient.embed({ input, context });
} catch (err) {
  if (err instanceof EmbeddingError && err.kind === 'auth') {
    await rotateCredentials();
  }
  throw err;
}
```

The classification also flows through the `onUsage` callback (`event.success === false`, `event.error` contains the message). Persist `success` + `error` so dashboards can filter failed embeds by class.

---

## Adding a third-party provider

Implement `EmbeddingProviderClient` and register under any string name. The package's `EmbeddingProvider` union is open.

```ts
import type { EmbeddingProviderClient } from '@liftoffos/embedding';

class CohereEmbeddingProvider implements EmbeddingProviderClient {
  readonly provider = 'cohere' as const;
  readonly capabilities = { taskType: true, maxBatchSize: 96, matryoshka: false };
  readonly defaultModel = 'embed-english-v3.0';
  async embed(request) { /* call api.cohere.com/v1/embed */ }
}

embeddingClient.init({
  providers: { cohere: new CohereEmbeddingProvider(/* ... */) },
});
embeddingClient.embed({ input: 'x', provider: 'cohere', ... });
```

Reach `MODEL_PRICING` on the consumer side too — add entries under `'cohere:embed-english-v3.0'` so cost ingestion classifies the rows.

---

## Test ergonomics

The module exports `embeddingClient` as a singleton (matching `@liftoffos/service-client`'s LLM client). For tests that need to reconfigure:

```ts
import { embeddingClient } from '@liftoffos/embedding';
beforeEach(() => embeddingClient.reset());
```

Or instantiate a fresh client per test:

```ts
import { EmbeddingClient } from '@liftoffos/embedding';
const client = new EmbeddingClient();
client.init({ providers: { google: fakeProvider } });
```

`reset()` is intentionally NOT called by `init()` — production should call `init()` exactly once at startup.

---

## What this package does NOT do

- **Pricing / cost computation.** Lives in each consumer's `src/llm/pricing.ts`. Add new model entries there.
- **Tenant entitlements / per-tenant model overrides.** Lives in the entitlements service. Consumers resolve the provider+model from entitlements, then pass them explicitly.
- **Caching.** Each consumer wraps the package with its own cache layer (e.g. tenant-runtime's `embedding_cache` table keyed by `(content_hash, embedding_model)`).
- **Storage / database writes.** The package emits `EmbeddingUsageEvent`; the consumer's `onUsage` callback persists.

These separations keep the package small, testable, and free of business-logic coupling.

---

## See also

- `docs/ARCHITECTURE.md` in this repo — embedding pipeline, knowledge retrieval, find_teammates
- `docs/adr/014-embedding-shared-package.md` — ADR for the shared-package extraction
- `liftoff-platform-backend/src/embedding/init.ts` — production bootstrap
- `liftoff-tenant-runtime/src/memory/embedding.ts` — caching + entitlements wrapper
