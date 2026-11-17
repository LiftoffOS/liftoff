-- DEFAULT partition for developer_proxy_usage_log.
--
-- Every partition on this table was written by hand into a migration, and when
-- the list runs out Postgres raises 23514 on insert rather than inventing one.
-- Every writer in this estate catches and logs that, so the request still
-- succeeds and the rows are simply lost — which is how workforce_audit_log lost
-- days of writes before anyone noticed.
--
-- A DEFAULT partition turns that from silent loss into rows parked somewhere
-- recoverable. It is a net, not a mechanism: scheduled maintenance still has to
-- create each month ahead of time, because once the default holds a row for
-- month M, creating M's partition fails until those rows are moved out. In
-- normal operation nothing ever lands here, and anything that does is the
-- signal that maintenance has been broken for a long time.

BEGIN;

CREATE TABLE IF NOT EXISTS developer_proxy_usage_log_default PARTITION OF developer_proxy_usage_log DEFAULT;

COMMIT;
