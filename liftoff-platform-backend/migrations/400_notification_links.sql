-- Migration 400: opaque notification links.
--
-- Notification event links currently resolve to
--   /dashboard/teams/chat?agentId=<uuid>&thread=<uuid>
-- which puts tenant-internal identifiers in the address bar, in browser
-- history, in referrer headers, and in the body of every email we send. The app
-- already rejected that shape once, for sharing: SharePage.tsx forwards through
-- an opaque id and states the rule outright — "Internal agent/thread ids stay
-- out of the address bar and browser history: the share URL is the only public
-- artifact." This table is that mechanism applied to notifications.
--
-- Modelled on chat_share_links (migration 293), including RLS, with one
-- difference: share links are canonical per (tenant, thread), but a
-- notification can point at the review queue, which is not a thread. Hence
-- `destination`, and a composite arbiter rather than a thread alone.
--
-- The dedupe index is load-bearing, not tidiness. thread_id and record_id are
-- both nullable, and under SQL's default NULL semantics every row would be
-- distinct, so the find-or-create in the notification path would mint a brand
-- new link on every single send instead of reusing one.
--
-- Expressed as COALESCE over a unique index rather than the PG15
-- `UNIQUE NULLS NOT DISTINCT`, which says the same thing more directly but
-- carries a version floor. The Terraform config provisions Cloud SQL as
-- POSTGRES_15, so that form would deploy there, but the pre-push migration gate replays every
-- migration against a local Postgres 14 and would reject it. A migration that
-- only applies on some supported Postgres versions is not worth the nicer syntax.
--
-- The sentinels are unambiguous: thread_id::text is always a UUID string and
-- record_id is always an escalation id, so neither can legitimately be ''.
--
-- `agent_id` is denormalised for the same reason migration 293 gives: threads
-- carry no agent column (migration 105), and the resolving client needs it to
-- open the right conversation.
--
-- No expiry column. The destination is access-checked at resolve time against
-- live tenant membership, so an old link stops working the moment somebody
-- leaves rather than on a timer, and a notification from last month should
-- still open its thread for somebody who is still a member.

CREATE TABLE notification_links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  destination TEXT NOT NULL CHECK (destination IN ('review', 'chat')),
  agent_id    UUID REFERENCES internal_agents(id),
  thread_id   UUID REFERENCES agent_chat_threads(id) ON DELETE CASCADE,
  record_id   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The find-or-create arbiter. ON CONFLICT infers this index by repeating the
-- expressions verbatim, so the two must stay in step.
CREATE UNIQUE INDEX notification_links_destination_key
  ON notification_links (
    tenant_id,
    destination,
    COALESCE(thread_id::text, ''),
    COALESCE(record_id, '')
  );

ALTER TABLE notification_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_links
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
