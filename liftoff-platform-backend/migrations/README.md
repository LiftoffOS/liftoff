# Migrations

## Naming convention (REQUIRED)

`NNN_short_description.sql` where `NNN` is a zero-padded 3-digit number, monotonically increasing.

A pre-commit / CI check (`scripts/check-migration-collisions.sh`) prevents new collisions.

## Historical collisions (DO NOT REPRODUCE)

The following collisions exist in the applied migration history. They run in lexicographic order
and are tracked individually in the `pgmigrations` table. **Do not rename them.**

- `059_payroll_contact_fields.sql`
- `059_seed_default_model_config.sql`
- `074_fix_external_agent_refs.sql`
- `074_insights_chat.sql`

Renaming a migration that has already been applied would make `node-pg-migrate` see
the new name as a new un-run migration on the next deploy and try to re-execute it,
which would fail on duplicate object creation.

The CI check (`scripts/check-migration-collisions.sh`) is configured to ignore these
specific historical collisions but will fail on any new ones.
