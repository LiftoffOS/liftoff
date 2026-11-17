-- Distill artifact handles.
--
-- The distilled agent (systemPrompt, userInstructions, instructionsMd, skills)
-- is the highest-value artifact this service produces. Until now the browser
-- was its courier: distill streamed the whole thing to the client, the client
-- parked it in component state, and create/update POSTed it back so the server
-- could persist what it had just generated. That round trip put the artifact on
-- the wire twice per build, made `systemPrompt` client-supplied (so an agent
-- carrying a templateId was not guaranteed to be running that template), and
-- silently lost `skills` / `capabilityTier` / `resultRules`, which the frontend
-- create payload never declared and zod stripped.
--
-- A row here is one distillation result, addressed by an opaque id. Distill
-- writes it and returns only the id; create/update resolve the id back to the
-- artifact server-side. Same invariant `provisioning-helper.ts` already states
-- for the Liftoff Switch path: persist the distill output BEFORE creating the
-- agent.
--
-- This is deliberately NOT `distillation_cache`. That table is keyed by a
-- content fingerprint and is shared by every caller whose normalized input
-- hashes the same, so it cannot address a single request or attribute one. The
-- two coexist: the cache still short-circuits the LLM, and whatever result is
-- served (fresh or cached) gets its own artifact row.
CREATE TABLE distill_artifacts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  output     JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Every read is "this id, for this tenant" — the tenant predicate is what stops
-- a guessed id from resolving across a tenant boundary, so it belongs in the
-- index rather than only in the WHERE clause.
CREATE INDEX distill_artifacts_id_tenant_idx ON distill_artifacts (id, tenant_id);
CREATE INDEX distill_artifacts_expires_at_idx ON distill_artifacts (expires_at);

-- RLS, not a PLATFORM_GLOBAL carve-out. `distillation_cache` sits outside RLS
-- because it is keyed by a content fingerprint and is legitimately shared by
-- whoever hashes the same input. This table is the opposite: a row is one
-- tenant's generated agent, addressed by a handle, and the whole point of the
-- handle is that only its owner can redeem it. The store already scopes every
-- read by tenant_id; this makes the database enforce it rather than trusting
-- the query to keep doing so (INV-PB-001).
ALTER TABLE distill_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE distill_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON distill_artifacts
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
