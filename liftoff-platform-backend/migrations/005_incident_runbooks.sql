-- Incident Runbooks Tables
-- Per Section 19: SOC 2 and GDPR readiness - incident runbooks

-- Incidents table
CREATE TABLE IF NOT EXISTS incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  severity VARCHAR(10) NOT NULL, -- P1, P2, P3, P4
  type VARCHAR(50) NOT NULL, -- outage, degradation, security, data_loss, compliance, other
  status VARCHAR(50) NOT NULL DEFAULT 'detected', -- detected, acknowledged, investigating, mitigating, resolved, post_mortem
  impacted_services JSONB NOT NULL DEFAULT '[]',
  impacted_tenants JSONB NOT NULL DEFAULT '[]',
  incident_commander VARCHAR(255),
  communications_lead VARCHAR(255),
  technical_lead VARCHAR(255),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  post_mortem_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for incidents
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents(severity);
CREATE INDEX IF NOT EXISTS idx_incidents_detected ON incidents(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_active ON incidents(status, severity) WHERE status NOT IN ('resolved', 'post_mortem');

-- Incident Timeline
CREATE TABLE IF NOT EXISTS incident_timeline (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  author VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL, -- status_change, update, action, communication, escalation
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'
);

-- Index for timeline
CREATE INDEX IF NOT EXISTS idx_incident_timeline_incident ON incident_timeline(incident_id, timestamp ASC);

-- Incident Action Items
CREATE TABLE IF NOT EXISTS incident_action_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  assignee VARCHAR(255) NOT NULL,
  priority VARCHAR(20) NOT NULL, -- high, medium, low
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, in_progress, completed, blocked
  due_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for action items
CREATE INDEX IF NOT EXISTS idx_action_items_incident ON incident_action_items(incident_id);
CREATE INDEX IF NOT EXISTS idx_action_items_assignee ON incident_action_items(assignee, status);

-- Post-Mortems
CREATE TABLE IF NOT EXISTS post_mortems (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES incidents(id),
  root_cause TEXT,
  impact_summary TEXT,
  customer_count INTEGER,
  revenue_impact DECIMAL(12, 2),
  detection_method TEXT,
  time_to_detection_minutes INTEGER,
  what_went_well JSONB NOT NULL DEFAULT '[]',
  what_could_be_improved JSONB NOT NULL DEFAULT '[]',
  lessons_learned TEXT,
  prevention_measures TEXT,
  reviewed_by VARCHAR(255),
  reviewed_at TIMESTAMPTZ,
  status VARCHAR(50) NOT NULL DEFAULT 'draft', -- draft, in_review, completed
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for post-mortems
CREATE INDEX IF NOT EXISTS idx_post_mortems_incident ON post_mortems(incident_id);
CREATE INDEX IF NOT EXISTS idx_post_mortems_status ON post_mortems(status);

-- Update incidents.post_mortem_id when a post-mortem is created
CREATE OR REPLACE FUNCTION link_post_mortem()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE incidents SET post_mortem_id = NEW.id, updated_at = NOW() WHERE id = NEW.incident_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_link_post_mortem
  AFTER INSERT ON post_mortems
  FOR EACH ROW EXECUTE FUNCTION link_post_mortem();

-- Function to auto-update updated_at for incidents
CREATE OR REPLACE FUNCTION update_incidents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_incidents_updated_at
  BEFORE UPDATE ON incidents
  FOR EACH ROW EXECUTE FUNCTION update_incidents_updated_at();

CREATE TRIGGER trigger_post_mortems_updated_at
  BEFORE UPDATE ON post_mortems
  FOR EACH ROW EXECUTE FUNCTION update_incidents_updated_at();
