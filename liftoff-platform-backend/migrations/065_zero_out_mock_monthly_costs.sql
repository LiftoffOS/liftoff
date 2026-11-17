-- Migration: Zero out stale mock monthly_cost values on existing internal agents.
-- Real cost is now computed on read from tenant runtime invocation data.
-- Old rows had random $299-$499 mock values seeded at creation time.

UPDATE internal_agents SET monthly_cost = 0 WHERE monthly_cost > 0;
