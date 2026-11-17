-- Retire tenant_resource_usage and tenant_cost_allocations.
--
-- Migration 097 created both for shared-tier cost attribution. Nothing
-- queries either: both sit on src/__tests__/known-unreferenced-tables.ts, and
-- the work they were meant to support is done by cost_attribution_events, which
-- has real writers across src/insights/ and src/cost-attribution/.
--
-- tenant_resource_usage also gets no partition maintenance, so keeping it would
-- leave a table that silently runs past its last partition.
--
-- Before running this, verify that both tables hold zero rows, no foreign key
-- references either, and no view depends on either.

BEGIN;

-- Partitions go with the parent; tenant_resource_usage has three.
DROP TABLE IF EXISTS tenant_resource_usage CASCADE;
DROP TABLE IF EXISTS tenant_cost_allocations CASCADE;

COMMIT;
