# Indexed-context retrieval

How an agent answers from data this workspace has **already fetched**, instead of
paying a vendor again to fetch it twice.

## Why it exists

An agent's knowledge of its systems used to be the capability block alone: which
connectors it can reach, and nothing about what is in them. So every task opened
with exploratory calls, and every one of those spent vendor quota — Composio
bills ONE organization-wide meter across every tenant, so exploratory reads are
not free at the org level even when they look free per tenant.

Content already pulled through the tool gateway has been paid for once. Indexing
it makes the second question free.

## The write path

```
agent tool call
  → ToolGatewayService.execute()          (in-process for MCP dispatch,
                                           over HTTP for /api/v1/tool-calls)
  → output guardrails
  → contentIndexer.indexToolResult()      fire-and-forget, never blocks the call
      ├─ CONNECTOR_CONTENT_INDEXING_ENABLED must be 'true'
      ├─ isReadAction(actionType)         get/read/list/fetch/search/find
      ├─ extractTextFromValue()           ≥150 chars or it is dropped (and logged)
      ├─ redactPII()
      ├─ resolveConnectorType()           alias/UUID → connector TYPE
      ├─ chunkText()                      1600 chars, 400 overlap, ≤20 chunks
      ├─ generateEmbeddingsBatch()        purpose: embedding_indexing
      └─ upsert into connector_content    inside withTenantScope (FORCE RLS)
```

`execute()` runs in **two** services — `agent-service` for the in-process MCP
dispatch path and `tool-gateway-service` for `/api/v1/tool-calls`. The flag has
to be set on both or half the dispatch surface silently goes unindexed.

## The read path

`search` assembles three sources and buys **one** retrieval vector for all of
them (`memory/retrieval-vector.ts`): one hypothetical document, one embedding.
Both semantic sources want a vector for the same question, and buying two doubles
the LLM cost of every search for no extra recall.

```
search(query, connectors?)
  ├─ indexed_context   connector_content, BM25 + HNSW fused by RRF   ← free at the vendor
  ├─ memory            memory_retrieve, always
  └─ connector search  only for aliases the model names              ← costs the vendor
```

The indexed source **never throws**. It returns `{items, coverage, note?, ok,
error?}`; `ok:false` is what separates "ran and found nothing" from "never ran",
and a failure degrades the source rather than failing the agent's search.

## Coverage is stated, always

The index holds only what was previously fetched, so an empty result never proves
the data is absent at the source. Every response carries coverage and, when the
index is thin or unavailable, a note saying so in the words the model will repeat
back. This is the single most important property of the feature: the failure mode
being designed against is an agent saying "there is no such customer" when what
happened is "nothing has been indexed yet".

`connectorContentCoverage` filters `expires_at > NOW()` exactly as both search
arms do, so the number it reports can never exceed what a search could return.

## What is NOT covered

Three real boundaries. None is a defect; all of them cap what the source can ever
answer, and all three were established by measurement rather than reading.

| Boundary | Why |
|---|---|
| **Vendor-MCP connectors** (GitHub, Notion, Stripe, …) | The Claude SDK connects to those servers directly with a Bearer token. They never pass through `ToolGatewayService.execute()`, so the indexer never sees their results. Only REST connectors dispatched through the gateway are indexable. |
| **Write actions** | `isReadAction()` admits only get/read/list/fetch/search/find. A write's result is an acknowledgement, not content. |
| **Payloads whose text is encoded** | Mail message bodies arrive base64-encoded at `payload.body.data`. Extraction deliberately refuses to collect them (indexing base64 would be worse than indexing nothing), so `get_message` yields nothing while `read_thread`, whose normalised shape carries prose, indexes fine. |

## Extraction

A string counts only when reached **through** a text-field key — `text`, `body`,
`content`, `description`, `summary`, `notes`, `title`, `subject`, `message`,
`snippet` — while containers are walked wherever they appear, bounded at depth 8
and 100 000 characters.

That combination is load-bearing in both directions. Walking arrays is what makes
the wrapper shapes real endpoints return extractable: `{items:[…]}`,
`{messages:[…]}`, `{results:[…]}`, `{ok:true,messages:[…]}`,
`{data:{items:[…]}}`. Requiring a text-field key is what keeps id lists, label
arrays and base64 blobs out.

An extractor that descends one level and skips arrays can only see text in a
bare top-level array or a flat object, so most realistic connector shapes
extract to `''`.

## A drop is never silent

| Metric | Meaning |
|---|---|
| `connector_content.indexed` | Rows written. Carries `connector`, `connectorType`, `chunks`, `chars`. |
| `connector_content.not_indexed` | A read produced nothing indexable. Carries `reason`, `extractedChars`, and a `shape` hint (top-level key NAMES only — a key name is connector schema, not customer content). |

Both at `info`, because the deployment writes at `info`. The second one exists
because a silent drop is how this component fails unnoticed: extraction returns
`''`, the function returns, and an empty index is indistinguishable from an
idle workspace.

## `connector_type` holds a type

The column is named for a type, and `search` filters on the type it resolves from
the aliases a model names. The indexer therefore resolves alias-or-UUID to the
connector type at write time (manifest repository, cached, falling back to the
raw value so an unresolvable connector is still indexed and still findable
without a filter).

Writing the caller's identifier straight through would make a connector-scoped
search compare `google_mail` against rows holding `google-mail-0105297e` and
match nothing — while reporting coverage 0 beside the empty result. Unfiltered
search is unaffected, which is why it would look healthy.

## Tenancy

`connector_content` is FORCE RLS as of migration 372, with the fail-loud policy
form (`current_setting('app.tenant_id')` with NO second argument, so an unscoped
read RAISES instead of returning zero rows). For a retrieval source the silent
variant is uniquely dangerous: zero rows reads as "this workspace has nothing
indexed", which is the precise falsehood the whole surface exists to avoid.

FORCE rather than plain ENABLE because the application connects as `tenant_app`,
which **owns** the table — without FORCE the policy would not bind the app at
all. (`memories` gets away with ENABLE-only because it is owned by
`cloudsqlsuperuser`, not by the app.)

Consequence: the fleet-wide embedding backfill cannot sweep this table, so
`connector_content` is swept one tenant at a time and refuses a fleet-wide pass
in the caller's terms rather than dying on a 42704 mid-batch. `provider-switch`
lifts FORCE for its cross-tenant re-embed inside the same transaction.

## Cost shape

- One batched embedding call per indexed read, over at most 20 chunks.
- At most 3 concurrent indexing operations (module semaphore).
- Read actions only, so write traffic and high-volume `browser_navigation` never
  reach it.
- Rows carry a 30-day TTL; `POST /api/internal/connector-content/maintenance/expire-connector-content`
  removes expired rows in batches.
- One retrieval vector per `search`, not one per source.

## Related

- ADR-009 — the coverage
  boundary and the FORCE-RLS decision.
- docs/agent-service-flags.md —
  `CONNECTOR_CONTENT_INDEXING_ENABLED` rollout and observability.
- [docs/architecture/memory-system.md](memory-system.md) — the other semantic
  source in `search`.
