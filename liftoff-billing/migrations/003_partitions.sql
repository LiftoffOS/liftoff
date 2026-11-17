-- migrations/003_partitions.sql
-- Provision +18 months of monthly partitions for
-- billing_audit_log. Daily Cloud Scheduler job catches gaps between
-- deploys; this migration is the baseline.
--
-- Naming: billing_audit_log_y{YYYY}_m{MM}
--
-- NOTE: regenerate this file on every release to keep the +18-month
-- baseline current; a CI check (`validate-partition-baseline.sh`) fails
-- if the next 3 months are missing.

BEGIN;

-- Macro-expand monthly partitions for 2026-04 through 2027-09 (18 months).
-- Example; update via the partitions script on each release.

CREATE TABLE billing_audit_log_y2026_m04 PARTITION OF billing_audit_log
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE billing_audit_log_y2026_m05 PARTITION OF billing_audit_log
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE billing_audit_log_y2026_m06 PARTITION OF billing_audit_log
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE billing_audit_log_y2026_m07 PARTITION OF billing_audit_log
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE billing_audit_log_y2026_m08 PARTITION OF billing_audit_log
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE billing_audit_log_y2026_m09 PARTITION OF billing_audit_log
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE billing_audit_log_y2026_m10 PARTITION OF billing_audit_log
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE billing_audit_log_y2026_m11 PARTITION OF billing_audit_log
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE billing_audit_log_y2026_m12 PARTITION OF billing_audit_log
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE billing_audit_log_y2027_m01 PARTITION OF billing_audit_log
  FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE billing_audit_log_y2027_m02 PARTITION OF billing_audit_log
  FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE billing_audit_log_y2027_m03 PARTITION OF billing_audit_log
  FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE billing_audit_log_y2027_m04 PARTITION OF billing_audit_log
  FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE billing_audit_log_y2027_m05 PARTITION OF billing_audit_log
  FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE billing_audit_log_y2027_m06 PARTITION OF billing_audit_log
  FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE billing_audit_log_y2027_m07 PARTITION OF billing_audit_log
  FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE billing_audit_log_y2027_m08 PARTITION OF billing_audit_log
  FOR VALUES FROM ('2027-08-01') TO ('2027-09-01');
CREATE TABLE billing_audit_log_y2027_m09 PARTITION OF billing_audit_log
  FOR VALUES FROM ('2027-09-01') TO ('2027-10-01');

COMMIT;
