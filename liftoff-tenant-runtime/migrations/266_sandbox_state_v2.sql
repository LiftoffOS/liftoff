-- Sandbox parity v2: extend sandbox_state with capabilities, JWT secret envelope, image tag.
-- Also widen the template CHECK constraint to cover the new templates introduced
-- by sandbox-parity-aio. Without this, INSERTs with template='aio-sandbox' or
-- template='sandbox-sidecar' fail the original migration-083 constraint.

ALTER TABLE sandbox_state
  ADD COLUMN IF NOT EXISTS capabilities text[] NOT NULL DEFAULT ARRAY['shell','file','browser','vscode'],
  ADD COLUMN IF NOT EXISTS jwt_secret_encrypted bytea,
  ADD COLUMN IF NOT EXISTS image_tag text;

-- Find the existing CHECK constraint by its column definition (it has an
-- auto-generated name like sandbox_state_template_check) and replace.
DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'sandbox_state'::regclass
     AND contype  = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%template%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE sandbox_state DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE sandbox_state
  ADD CONSTRAINT sandbox_state_template_check
  CHECK (template IN ('general-shell', 'code-development', 'data-analysis', 'sandbox-sidecar', 'aio-sandbox'));
