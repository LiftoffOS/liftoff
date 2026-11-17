-- View for validation summary by design partner
-- Split from 007_production_validation.sql to ensure tables exist before view creation

CREATE OR REPLACE VIEW design_partner_validation_summary AS
SELECT
  dp.id as partner_id,
  dp.name as partner_name,
  dp.tenant_id,
  dp.status as partner_status,
  COUNT(pv.id) as total_validations,
  COUNT(pv.id) FILTER (WHERE pv.status = 'passed') as passed_validations,
  MAX(pv.completed_at) FILTER (WHERE pv.status = 'passed') as last_passed_at,
  AVG((pv.summary->>'overallScore')::numeric) FILTER (WHERE pv.status IN ('passed', 'failed')) as avg_score
FROM design_partners dp
LEFT JOIN production_validations pv ON dp.id = pv.design_partner_id
GROUP BY dp.id, dp.name, dp.tenant_id, dp.status;
