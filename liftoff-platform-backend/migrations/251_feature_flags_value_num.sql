ALTER TABLE feature_flags ADD COLUMN value_num NUMERIC;
COMMENT ON COLUMN feature_flags.value_num IS 'Optional numeric value alongside enabled boolean. Used for tunable thresholds (e.g. concurrency caps, rate limits). NULL when the flag is purely boolean.';
