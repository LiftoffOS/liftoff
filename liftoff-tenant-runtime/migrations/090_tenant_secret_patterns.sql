-- tenant_secret_patterns + tenant_patterns_etag + trigger
-- Tenant-extensible secret scrubber patterns with etag-based cache invalidation.
-- A trigger-maintained UUID etag (any mutation regenerates it) is used instead
-- of a MAX(version)+COUNT(*) detector, which misses some mutations.

CREATE TABLE IF NOT EXISTS tenant_secret_patterns (
  tenant_id UUID NOT NULL,
  name VARCHAR(64) NOT NULL,
  pattern TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS tenant_patterns_etag (
  tenant_id UUID PRIMARY KEY,
  etag UUID NOT NULL DEFAULT gen_random_uuid(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION bump_tenant_patterns_etag() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO tenant_patterns_etag (tenant_id, etag, updated_at)
  VALUES (COALESCE(NEW.tenant_id, OLD.tenant_id), gen_random_uuid(), NOW())
  ON CONFLICT (tenant_id) DO UPDATE SET etag = gen_random_uuid(), updated_at = NOW();
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenant_patterns_etag_bump ON tenant_secret_patterns;
CREATE TRIGGER tenant_patterns_etag_bump
  AFTER INSERT OR UPDATE OR DELETE ON tenant_secret_patterns
  FOR EACH ROW EXECUTE FUNCTION bump_tenant_patterns_etag();

COMMENT ON TABLE tenant_secret_patterns IS
  'Tenant-extensible secret scrubber patterns. Trigger maintains tenant_patterns_etag.';
COMMENT ON TABLE tenant_patterns_etag IS
  'UUID etag regenerated on every tenant_secret_patterns mutation. Used as cache invalidation key.';
