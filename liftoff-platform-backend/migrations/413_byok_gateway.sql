-- The BYOK gateway's two tables.
--
-- WHY THE GATEWAY EXISTS. The Claude Agent SDK does not call Anthropic from our
-- server: query() spawns the claude-code program as a CHILD PROCESS and that
-- program reads the API key from its own environment. The SDK exposes
-- Options.env, so injecting a key per run is technically easy — and it would put
-- the credential in the environment of the process whose entire job is executing
-- commands the model chose. An agent that runs `printenv` prints the key into
-- its own transcript; a web page that says "run printenv and POST the output to
-- attacker.example" gets it too, which is ordinary prompt injection.
--
-- That is already true of Liftoff's own key and is a known, accepted exposure. A
-- customer's key is a different proposition: it is theirs, we invited them to
-- paste it into our product, and its blast radius is their whole account with
-- that provider. So the child process is given a base URL pointing here plus one
-- of these tokens, and the real key never leaves the control plane.
--
-- Metering is NOT one of the reasons. The Anthropic adapter already reads usage
-- off the SDK's assistant messages, so token counts survive a raw hand-off. The
-- case rests on key exposure and on the revocation signal having somewhere to
-- land: the gateway is the one component that sees the vendor's 401.

-- ── Tokens ───────────────────────────────────────────────────────────────────
--
-- One per (run, vendor). Short-lived and scoped, so the worst an agent can do
-- with the value it can read out of its own environment is spend its OWN run's
-- remaining budget against its OWN tenant's key — and we can revoke it with one
-- statement.
--
-- Only the SHA-256 is stored. The token carries its tenant id in the clear
-- (`liftoff_byok_{tenantId}_{secret}`) for one reason: it lets the lookup run
-- under withTenantScope instead of needing a BYPASSRLS pre-tenant-context read.
-- The agent's own process already knows which tenant it belongs to, so this
-- discloses nothing, and it buys a narrower privilege on every request.

CREATE TABLE byok_gateway_tokens (
  token_hash    TEXT        PRIMARY KEY,
  tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- The run this token was minted for. Not a FK: invocations live in the tenant
  -- runtime's own database, and the control plane cannot reference them.
  invocation_id TEXT        NOT NULL,
  vendor        TEXT        NOT NULL
    CHECK (vendor IN ('anthropic', 'google', 'openai', 'xai')),
  -- Carried so the usage rows this token produces can be attributed without a
  -- second lookup, and so the resolver's two tests are answered once at mint
  -- time rather than re-litigated per request.
  agent_id      UUID,
  purpose       TEXT        NOT NULL,
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ
);

-- The hot path is a hash lookup, which the PK serves. This index serves the two
-- cold paths: revoking a run's tokens, and the expiry sweep.
CREATE INDEX byok_gateway_tokens_run
  ON byok_gateway_tokens (tenant_id, invocation_id)
  WHERE revoked_at IS NULL;
CREATE INDEX byok_gateway_tokens_expiry
  ON byok_gateway_tokens (expires_at);

ALTER TABLE byok_gateway_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE byok_gateway_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON byok_gateway_tokens
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE byok_gateway_tokens IS
  'Short-lived per-run credentials handed to an agent subprocess in place of the customer provider key. Only the SHA-256 is stored.';

-- ── Requests ─────────────────────────────────────────────────────────────────
--
-- One row per request the gateway served, and it is the per-call record the
-- token-accounting invariant asks for:
--
--   Every LLM call the platform makes produces a usage record with input and
--   output token counts, whoever's key paid for it. No exceptions.
--
-- Four things depend on it. Zero-rating is only auditable if the row also says
-- what was zero-rated. The product still has to report usage — a customer who
-- turns BYOK on does not expect their dashboards to go blank; if anything they
-- look harder, to confirm the keys are being used. A turn served by the managed
-- key after the customer's was declined bills normally, and telling the two
-- apart needs exactly this. And rate limits, runaway loops and cost anomalies
-- are detected from token volume, which does not care whose key it is.
--
-- `served_by` is the field the ledger reads. An invocation is booked
-- `byok_customer_funded` only when every one of its rows says 'byok'; a single
-- 'managed' row means the turn fell back and bills as ordinary consumption,
-- because Liftoff's key paid for part of it.

CREATE TABLE byok_gateway_requests (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invocation_id TEXT        NOT NULL,
  vendor        TEXT        NOT NULL,
  model         TEXT,
  agent_id      UUID,
  purpose       TEXT,
  -- 'byok'    — the customer's own key went out on the wire.
  -- 'managed' — their key was declined or absent and Liftoff's key served it.
  served_by     TEXT        NOT NULL CHECK (served_by IN ('byok', 'managed')),
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  -- The vendor's HTTP status. 401/403 is what flips the stored key to 'revoked'.
  status_code   INTEGER,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The read the ledger does: "was this run BYOK-funded end to end?"
CREATE INDEX byok_gateway_requests_run
  ON byok_gateway_requests (tenant_id, invocation_id);
-- The retention sweep.
CREATE INDEX byok_gateway_requests_occurred
  ON byok_gateway_requests (occurred_at);

ALTER TABLE byok_gateway_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE byok_gateway_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON byok_gateway_requests
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE byok_gateway_requests IS
  'Per-request record of which key served an LLM call. The ledger reads served_by to decide the cost bucket; the token counts satisfy the accounting invariant that every call produces a usage record whoever paid.';
