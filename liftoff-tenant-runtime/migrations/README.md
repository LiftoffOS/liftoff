# Migrations

## Naming convention (REQUIRED)

`NNN_short_description.sql` where `NNN` is a zero-padded 3-digit number, monotonically increasing.

A pre-commit / CI check (`scripts/check-migration-collisions.sh`) prevents new collisions.

## Historical collisions (DO NOT REPRODUCE)

The following collision exists in the migration history. It runs in lexicographic order
and is tracked individually in the `pgmigrations` table. **Do not rename it.**

- `023_ai_team_agent_mapping.sql`
- `023_ai_team_agent_mapping_rollback.sql` (badly named — this is a rollback artifact, not a forward migration; the collision check excludes files matching `*_rollback.sql`)

Renaming a migration that has already been applied would make `node-pg-migrate` see
the new name as a new un-run migration on the next deploy and try to re-execute it,
which would fail on duplicate object creation.
