CREATE TABLE insights_chat_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  account_id UUID NOT NULL,
  title VARCHAR(500),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Admin/owner listing (all tenant threads)
CREATE INDEX idx_insights_threads_tenant ON insights_chat_threads(tenant_id, updated_at DESC)
  WHERE deleted_at IS NULL;
-- Member/viewer listing (own threads only)
CREATE INDEX idx_insights_threads_account ON insights_chat_threads(tenant_id, account_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE insights_chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES insights_chat_threads(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  visualization_blocks JSONB,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_insights_messages_thread ON insights_chat_messages(thread_id, created_at ASC);

-- Rate limiting events for insights chat
CREATE TABLE insights_rate_limit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  account_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_insights_rate_limit_tenant ON insights_rate_limit_events(tenant_id, created_at DESC);
CREATE INDEX idx_insights_rate_limit_account ON insights_rate_limit_events(account_id, created_at DESC);
