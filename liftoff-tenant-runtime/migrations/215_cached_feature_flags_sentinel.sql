-- Seed the global-flag sentinel row in cached_feature_flags. The all-zero UUID
-- is reserved for non-tenant-scoped (global) flags. Idempotent.
INSERT INTO cached_feature_flags (tenant_id, flags, updated_at)
VALUES ('00000000-0000-0000-0000-000000000000', '{}', now())
ON CONFLICT (tenant_id) DO NOTHING;
