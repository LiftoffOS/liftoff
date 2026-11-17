-- 1. Schema changes.
ALTER TABLE web_sessions
  ADD COLUMN closed_reason     TEXT NULL,
  ADD COLUMN owner_account_id  UUID NULL;  -- Liftoff accounts.id. Informational
                                            -- for new feature rows; nullable for
                                            -- back-compat with pre-feature
                                            -- (web_task) rows that don't have an
                                            -- owner.

-- 2. Cleanup pre-existing duplicates BEFORE adding the partial unique index.
WITH dups AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id, thread_id
           ORDER BY created_at DESC
         ) AS rn
  FROM web_sessions
  WHERE closed_at IS NULL AND thread_id IS NOT NULL AND vendor = 'anchor'
)
UPDATE web_sessions
   SET closed_at = NOW(),
       closed_reason = 'migration_cleanup'
 WHERE id IN (SELECT id FROM dups WHERE rn > 1);

-- 3. Enforce one live anchor session per thread.
CREATE UNIQUE INDEX web_sessions_one_active_per_thread
  ON web_sessions (tenant_id, thread_id)
  WHERE closed_at IS NULL AND vendor = 'anchor';
