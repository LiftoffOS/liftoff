-- Invocations and Threads
-- Invocations & Threads

-- Threads table with partitioning [FIX: DE-005]
CREATE TABLE threads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- [FIX: BE-001] Add FK constraint
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    initiated_by_user TEXT,
    initiated_by_type TEXT DEFAULT 'human' CHECK (initiated_by_type IN ('human', 'agent', 'system')),
    title TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'archived')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Messages table
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- [FIX: BE-001] Add FK constraint
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
    content TEXT NOT NULL,
    tool_calls JSONB,
    -- [FIX: DE-009] NOT NULL for consistent aggregations
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Invocations table
CREATE TABLE invocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- [FIX: BE-001] Add FK constraint
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    thread_id UUID REFERENCES threads(id) ON DELETE SET NULL,
    triggered_by TEXT NOT NULL CHECK (triggered_by IN ('human', 'agent', 'cron', 'event')),
    trigger_ref TEXT,
    model_id TEXT,
    -- [FIX: DE-009] NOT NULL for consistent aggregations
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    -- [FIX: DE-008] Persist cost at invocation time
    cost_usd NUMERIC(10, 6),
    input_price_per_million NUMERIC(10, 4),
    output_price_per_million NUMERIC(10, 4),
    tool_calls JSONB DEFAULT '[]',
    outcome TEXT CHECK (outcome IN ('success', 'error', 'escalated')),
    error_message TEXT,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

-- [FIX: BE-002] Indexes on FK columns
CREATE INDEX idx_threads_tenant ON threads(tenant_id);
CREATE INDEX idx_threads_agent ON threads(agent_id);
CREATE INDEX idx_threads_tenant_agent ON threads(tenant_id, agent_id);
CREATE INDEX idx_threads_status ON threads(tenant_id, status) WHERE status = 'open';
CREATE INDEX idx_messages_tenant ON messages(tenant_id);
CREATE INDEX idx_messages_thread ON messages(thread_id, created_at);
CREATE INDEX idx_invocations_tenant ON invocations(tenant_id);
CREATE INDEX idx_invocations_agent ON invocations(agent_id);
CREATE INDEX idx_invocations_thread ON invocations(thread_id);
CREATE INDEX idx_invocations_tenant_started ON invocations(tenant_id, started_at DESC);
CREATE INDEX idx_invocations_outcome ON invocations(tenant_id, outcome);

-- Auto-update triggers
CREATE TRIGGER update_threads_updated_at
    BEFORE UPDATE ON threads
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE threads IS 'Conversation threads between users and agents.';
COMMENT ON TABLE messages IS 'Individual messages within a thread.';
COMMENT ON TABLE invocations IS 'Records of agent invocations with cost tracking and outcome.';
COMMENT ON COLUMN invocations.cost_usd IS 'Total cost in USD calculated at completion time (for historical accuracy).';
COMMENT ON COLUMN invocations.triggered_by IS 'human=user initiated, agent=delegation, cron=scheduled, event=webhook';
