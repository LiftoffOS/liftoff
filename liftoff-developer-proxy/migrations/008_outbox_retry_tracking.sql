-- Add retry tracking to outbox_events for bounded retry on failed deliveries.
-- retry_count is incremented each time a delivery attempt fails (5xx or network error).
-- Rows with retry_count >= 10 are treated as permanently failed and marked published
-- (abandoned) by AuditLogDeliveryWorker with an error log entry.
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS last_error TEXT;
