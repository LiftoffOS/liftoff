-- Dead Letter Queue Tables
-- Per Section 7: DLQ for failed tasks after retry exhaustion

-- DLQ Messages
CREATE TABLE dlq_messages (
    id VARCHAR(255) PRIMARY KEY,
    original_topic VARCHAR(255) NOT NULL,
    original_message_id VARCHAR(255) NOT NULL,
    tenant_id UUID NOT NULL,
    workflow_id UUID,
    task_id UUID,
    payload JSONB NOT NULL,
    error TEXT NOT NULL,
    delivery_attempt INTEGER NOT NULL,
    max_delivery_attempts INTEGER NOT NULL,
    first_received_at TIMESTAMP WITH TIME ZONE NOT NULL,
    failed_at TIMESTAMP WITH TIME ZONE NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    resolution VARCHAR(50),
    resolution_details TEXT,
    resolved_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for status queries
CREATE INDEX idx_dlq_messages_status ON dlq_messages(status);
CREATE INDEX idx_dlq_messages_tenant ON dlq_messages(tenant_id);
CREATE INDEX idx_dlq_messages_topic ON dlq_messages(original_topic);
CREATE INDEX idx_dlq_messages_workflow ON dlq_messages(workflow_id) WHERE workflow_id IS NOT NULL;

-- DLQ Escalations (for messages requiring manual review)
CREATE TABLE dlq_escalations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dlq_message_id VARCHAR(255) NOT NULL REFERENCES dlq_messages(id),
    tenant_id UUID NOT NULL,
    workflow_id UUID,
    task_id UUID,
    original_topic VARCHAR(255) NOT NULL,
    error TEXT NOT NULL,
    reason TEXT NOT NULL,
    assigned_to UUID,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    resolved_at TIMESTAMP WITH TIME ZONE,
    resolution TEXT,
    resolved_by UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for escalation queries
CREATE INDEX idx_dlq_escalations_status ON dlq_escalations(status);
CREATE INDEX idx_dlq_escalations_tenant ON dlq_escalations(tenant_id);
CREATE INDEX idx_dlq_escalations_assigned ON dlq_escalations(assigned_to) WHERE assigned_to IS NOT NULL;

-- Add retry_count and last_error to workflow_tasks if not exists
ALTER TABLE workflow_tasks ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;
ALTER TABLE workflow_tasks ADD COLUMN IF NOT EXISTS last_error TEXT;
