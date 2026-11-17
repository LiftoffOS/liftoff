-- Both statements must run atomically. The migration runner wraps each file in BEGIN/COMMIT
-- automatically. If running manually, wrap explicitly: BEGIN; ... COMMIT;
-- If the INSERT fails after the UPDATE, there are zero active ou_pricing rows and billing breaks.

-- Expire current pricing rows
UPDATE ou_pricing SET effective_until = NOW() WHERE effective_until IS NULL;

-- Insert new rates at 100x denomination
-- standard = post-pay metered rate ($0.03125/OU); pre-pay plan allocation rate is $0.025/OU
-- (applied at subscription activation via monthly_allocation_usd, not via ou_pricing at spend time)
INSERT INTO ou_pricing (tier, price_per_ou, changed_by, change_reason) VALUES
  ('standard',   0.03125, 'system', '100x OU rescale; post-pay rate set above plan allocation rate to drive pre-pay adoption'),
  ('enterprise', 0.020,   'system', '100x OU denomination rescale — 1 OU = $0.01 platform cost');
