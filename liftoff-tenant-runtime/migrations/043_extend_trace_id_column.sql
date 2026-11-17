-- Extend trace_id column from varchar(64) to varchar(128)
-- The composite trace format exec-{workflowId}-{taskId}-{shortId} exceeds 64 chars
ALTER TABLE actions ALTER COLUMN trace_id TYPE varchar(128);
