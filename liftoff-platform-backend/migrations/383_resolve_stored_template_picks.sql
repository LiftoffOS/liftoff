-- Resolve template placeholders already stored on hired agents.
--
-- Until now `applyTemplatePicks` ran only on the way into the distillation
-- prompt, so `internal_agents.responsibilities` and `additional_context` kept
-- the raw `{{pick:...}}`. Two consequences, and the second is the one that
-- loses data:
--
--   - The edit screen showed a person our own placeholder syntax in the very
--     field it was inviting them to rewrite.
--   - Picks are persisted nowhere else, so a redistill had nothing to resolve
--     them from and substituted the generic fallback. An agent told to post to
--     "#deal-room" quietly began saying "your deal channel" — no error, a
--     well-formed prompt, and the destination gone.
--
-- What this can and cannot restore: it resolves each placeholder to its own
-- template's fallback phrase, which is the same string the gallery showed
-- before the hire. It CANNOT restore a destination someone actually chose,
-- because that was never stored — that is the defect, and the code fix
-- (resolving at the point of storage) is what stops it recurring. An agent that
-- named a channel keeps it in the system prompt distillation already produced.
--
-- Keyed on (template_id, object id) rather than object id alone: `alert-channel`
-- is `your legal channel` in one template and `your deal channel` in another,
-- so a single global mapping would put the wrong noun in half the catalog.
--
-- RLS, following migrations 360 and 382: internal_agents is FORCE
-- row-level-security and migrations run as liftoff_app, which has no BYPASSRLS,
-- so the tenant policy's current_setting('app.current_tenant_id') aborts with no
-- GUC set. This writes across tenants, so dropping FORCE for the transaction is
-- the owner's equivalent of the admin pool's BYPASSRLS; ALTER TABLE holds ACCESS
-- EXCLUSIVE until COMMIT.

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your finance channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your finance channel')
WHERE template_id = 'accounts-payable-specialist'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your finance channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your finance channel')
WHERE template_id = 'accounts-receivable-specialist'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:revenue-channel}}', 'your revenue channel'),
  additional_context = replace(additional_context, '{{pick:revenue-channel}}', 'your revenue channel')
WHERE template_id = 'billing-operations-specialist'
  AND (responsibilities LIKE '%{{pick:revenue-channel}}%' OR additional_context LIKE '%{{pick:revenue-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your deal channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your deal channel')
WHERE template_id = 'change-of-control-analyst'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:engineering-channel}}', 'your engineering channel'),
  additional_context = replace(additional_context, '{{pick:engineering-channel}}', 'your engineering channel')
WHERE template_id = 'code-reviewer'
  AND (responsibilities LIKE '%{{pick:engineering-channel}}%' OR additional_context LIKE '%{{pick:engineering-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your legal channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your legal channel')
WHERE template_id = 'commercial-agreement-analyst'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your legal channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your legal channel')
WHERE template_id = 'commercial-lease-analyst'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:positioning-source}}', 'your positioning document'),
  additional_context = replace(additional_context, '{{pick:positioning-source}}', 'your positioning document')
WHERE template_id = 'competitive-intelligence-analyst'
  AND (responsibilities LIKE '%{{pick:positioning-source}}%' OR additional_context LIKE '%{{pick:positioning-source}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:working-folder}}', 'your working folder'),
  additional_context = replace(additional_context, '{{pick:working-folder}}', 'your working folder')
WHERE template_id = 'competitive-intelligence-analyst'
  AND (responsibilities LIKE '%{{pick:working-folder}}%' OR additional_context LIKE '%{{pick:working-folder}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:positioning-source}}', 'your positioning document'),
  additional_context = replace(additional_context, '{{pick:positioning-source}}', 'your positioning document')
WHERE template_id = 'competitor-comparison-writer'
  AND (responsibilities LIKE '%{{pick:positioning-source}}%' OR additional_context LIKE '%{{pick:positioning-source}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:working-folder}}', 'your working folder'),
  additional_context = replace(additional_context, '{{pick:working-folder}}', 'your working folder')
WHERE template_id = 'competitor-comparison-writer'
  AND (responsibilities LIKE '%{{pick:working-folder}}%' OR additional_context LIKE '%{{pick:working-folder}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:working-folder}}', 'your content library'),
  additional_context = replace(additional_context, '{{pick:working-folder}}', 'your content library')
WHERE template_id = 'content-repurposing-specialist'
  AND (responsibilities LIKE '%{{pick:working-folder}}%' OR additional_context LIKE '%{{pick:working-folder}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:clause-library}}', 'your standard clause library'),
  additional_context = replace(additional_context, '{{pick:clause-library}}', 'your standard clause library')
WHERE template_id = 'contract-specialist'
  AND (responsibilities LIKE '%{{pick:clause-library}}%' OR additional_context LIKE '%{{pick:clause-library}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:working-folder}}', 'your working folder'),
  additional_context = replace(additional_context, '{{pick:working-folder}}', 'your working folder')
WHERE template_id = 'contract-specialist'
  AND (responsibilities LIKE '%{{pick:working-folder}}%' OR additional_context LIKE '%{{pick:working-folder}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your deal channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your deal channel')
WHERE template_id = 'cp-checklist-analyst'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your legal channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your legal channel')
WHERE template_id = 'credit-agreement-analyst'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your legal channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your legal channel')
WHERE template_id = 'credit-agreement-memo-writer'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your sales operations channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your sales operations channel')
WHERE template_id = 'crm-operations-specialist'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your account team channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your account team channel')
WHERE template_id = 'customer-escalation-manager'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:account-channel}}', 'your account team channel'),
  additional_context = replace(additional_context, '{{pick:account-channel}}', 'your account team channel')
WHERE template_id = 'customer-success-manager'
  AND (responsibilities LIKE '%{{pick:account-channel}}%' OR additional_context LIKE '%{{pick:account-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your support channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your support channel')
WHERE template_id = 'customer-support-representative'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:knowledge-base}}', 'your knowledge base'),
  additional_context = replace(additional_context, '{{pick:knowledge-base}}', 'your knowledge base')
WHERE template_id = 'customer-support-representative'
  AND (responsibilities LIKE '%{{pick:knowledge-base}}%' OR additional_context LIKE '%{{pick:knowledge-base}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your legal channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your legal channel')
WHERE template_id = 'e-discovery-analyst'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your marketing channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your marketing channel')
WHERE template_id = 'email-campaign-analyst'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:hr-channel}}', 'your HR channel'),
  additional_context = replace(additional_context, '{{pick:hr-channel}}', 'your HR channel')
WHERE template_id = 'employee-onboarding-specialist'
  AND (responsibilities LIKE '%{{pick:hr-channel}}%' OR additional_context LIKE '%{{pick:hr-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:onboarding-template}}', 'your onboarding page template'),
  additional_context = replace(additional_context, '{{pick:onboarding-template}}', 'your onboarding page template')
WHERE template_id = 'employee-onboarding-specialist'
  AND (responsibilities LIKE '%{{pick:onboarding-template}}%' OR additional_context LIKE '%{{pick:onboarding-template}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your HR channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your HR channel')
WHERE template_id = 'employment-agreement-analyst'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:brand-template}}', 'your branded template deck'),
  additional_context = replace(additional_context, '{{pick:brand-template}}', 'your branded template deck')
WHERE template_id = 'executive-presentation-specialist'
  AND (responsibilities LIKE '%{{pick:brand-template}}%' OR additional_context LIKE '%{{pick:brand-template}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:policy-library}}', 'your policy library'),
  additional_context = replace(additional_context, '{{pick:policy-library}}', 'your policy library')
WHERE template_id = 'hr-policy-specialist'
  AND (responsibilities LIKE '%{{pick:policy-library}}%' OR additional_context LIKE '%{{pick:policy-library}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your sales channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your sales channel')
WHERE template_id = 'inbound-lead-qualifier'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:response-sheet}}', 'your form''s response sheet'),
  additional_context = replace(additional_context, '{{pick:response-sheet}}', 'your form''s response sheet')
WHERE template_id = 'inbound-lead-qualifier'
  AND (responsibilities LIKE '%{{pick:response-sheet}}%' OR additional_context LIKE '%{{pick:response-sheet}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:incident-channel}}', 'your incident channel'),
  additional_context = replace(additional_context, '{{pick:incident-channel}}', 'your incident channel')
WHERE template_id = 'incident-manager'
  AND (responsibilities LIKE '%{{pick:incident-channel}}%' OR additional_context LIKE '%{{pick:incident-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:incident-channel}}', 'your incident channel'),
  additional_context = replace(additional_context, '{{pick:incident-channel}}', 'your incident channel')
WHERE template_id = 'incident-triage-specialist'
  AND (responsibilities LIKE '%{{pick:incident-channel}}%' OR additional_context LIKE '%{{pick:incident-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your sales channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your sales channel')
WHERE template_id = 'lead-enrichment-scoring-specialist'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your legal channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your legal channel')
WHERE template_id = 'limited-partnership-agreement-analyst'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your legal channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your legal channel')
WHERE template_id = 'nda-analyst'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:ops-channel}}', 'your ops channel'),
  additional_context = replace(additional_context, '{{pick:ops-channel}}', 'your ops channel')
WHERE template_id = 'order-fulfillment-coordinator'
  AND (responsibilities LIKE '%{{pick:ops-channel}}%' OR additional_context LIKE '%{{pick:ops-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:engineering-channel}}', 'your engineering channel'),
  additional_context = replace(additional_context, '{{pick:engineering-channel}}', 'your engineering channel')
WHERE template_id = 'performance-engineer'
  AND (responsibilities LIKE '%{{pick:engineering-channel}}%' OR additional_context LIKE '%{{pick:engineering-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:hr-channel}}', 'your HR channel'),
  additional_context = replace(additional_context, '{{pick:hr-channel}}', 'your HR channel')
WHERE template_id = 'performance-review-coordinator'
  AND (responsibilities LIKE '%{{pick:hr-channel}}%' OR additional_context LIKE '%{{pick:hr-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:review-template}}', 'your review template'),
  additional_context = replace(additional_context, '{{pick:review-template}}', 'your review template')
WHERE template_id = 'performance-review-coordinator'
  AND (responsibilities LIKE '%{{pick:review-template}}%' OR additional_context LIKE '%{{pick:review-template}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:working-folder}}', 'your product working folder'),
  additional_context = replace(additional_context, '{{pick:working-folder}}', 'your product working folder')
WHERE template_id = 'product-operations-manager'
  AND (responsibilities LIKE '%{{pick:working-folder}}%' OR additional_context LIKE '%{{pick:working-folder}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your sales channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your sales channel')
WHERE template_id = 'prospect-research-analyst'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:offer-template}}', 'your approved offer letter template'),
  additional_context = replace(additional_context, '{{pick:offer-template}}', 'your approved offer letter template')
WHERE template_id = 'recruiting-coordinator'
  AND (responsibilities LIKE '%{{pick:offer-template}}%' OR additional_context LIKE '%{{pick:offer-template}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:recruiting-channel}}', 'your recruiting channel'),
  additional_context = replace(additional_context, '{{pick:recruiting-channel}}', 'your recruiting channel')
WHERE template_id = 'recruiting-coordinator'
  AND (responsibilities LIKE '%{{pick:recruiting-channel}}%' OR additional_context LIKE '%{{pick:recruiting-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:recruiting-channel}}', 'your recruiting channel'),
  additional_context = replace(additional_context, '{{pick:recruiting-channel}}', 'your recruiting channel')
WHERE template_id = 'recruiting-operations-analyst'
  AND (responsibilities LIKE '%{{pick:recruiting-channel}}%' OR additional_context LIKE '%{{pick:recruiting-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:release-channel}}', 'your engineering channel'),
  additional_context = replace(additional_context, '{{pick:release-channel}}', 'your engineering channel')
WHERE template_id = 'release-manager'
  AND (responsibilities LIKE '%{{pick:release-channel}}%' OR additional_context LIKE '%{{pick:release-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your revenue operations channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your revenue operations channel')
WHERE template_id = 'revenue-operations-analyst'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your sales channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your sales channel')
WHERE template_id = 'sales-development-representative'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:coaching-channel}}', 'your sales coaching channel'),
  additional_context = replace(additional_context, '{{pick:coaching-channel}}', 'your sales coaching channel')
WHERE template_id = 'sales-enablement-coach'
  AND (responsibilities LIKE '%{{pick:coaching-channel}}%' OR additional_context LIKE '%{{pick:coaching-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:recap-channel}}', 'your deal channel'),
  additional_context = replace(additional_context, '{{pick:recap-channel}}', 'your deal channel')
WHERE template_id = 'sales-meeting-coordinator'
  AND (responsibilities LIKE '%{{pick:recap-channel}}%' OR additional_context LIKE '%{{pick:recap-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:deals-channel}}', 'your deals channel'),
  additional_context = replace(additional_context, '{{pick:deals-channel}}', 'your deals channel')
WHERE template_id = 'sales-quote-coordinator'
  AND (responsibilities LIKE '%{{pick:deals-channel}}%' OR additional_context LIKE '%{{pick:deals-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:proposal-template}}', 'your proposal template'),
  additional_context = replace(additional_context, '{{pick:proposal-template}}', 'your proposal template')
WHERE template_id = 'sales-quote-coordinator'
  AND (responsibilities LIKE '%{{pick:proposal-template}}%' OR additional_context LIKE '%{{pick:proposal-template}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:engineering-channel}}', 'your engineering channel'),
  additional_context = replace(additional_context, '{{pick:engineering-channel}}', 'your engineering channel')
WHERE template_id = 'security-engineer'
  AND (responsibilities LIKE '%{{pick:engineering-channel}}%' OR additional_context LIKE '%{{pick:engineering-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your legal channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your legal channel')
WHERE template_id = 'shareholder-agreement-analyst'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your legal channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your legal channel')
WHERE template_id = 'shareholder-agreement-memo-writer'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your sales channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your sales channel')
WHERE template_id = 'social-intent-lead-finder'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:watchlist}}', 'your watchlist document'),
  additional_context = replace(additional_context, '{{pick:watchlist}}', 'your watchlist document')
WHERE template_id = 'social-intent-lead-finder'
  AND (responsibilities LIKE '%{{pick:watchlist}}%' OR additional_context LIKE '%{{pick:watchlist}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:engineering-channel}}', 'your engineering channel'),
  additional_context = replace(additional_context, '{{pick:engineering-channel}}', 'your engineering channel')
WHERE template_id = 'software-engineer'
  AND (responsibilities LIKE '%{{pick:engineering-channel}}%' OR additional_context LIKE '%{{pick:engineering-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:engineering-channel}}', 'your engineering channel'),
  additional_context = replace(additional_context, '{{pick:engineering-channel}}', 'your engineering channel')
WHERE template_id = 'software-quality-analyst'
  AND (responsibilities LIKE '%{{pick:engineering-channel}}%' OR additional_context LIKE '%{{pick:engineering-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your deal channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your deal channel')
WHERE template_id = 'spa-analyst'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:team-channel}}', 'your team channel'),
  additional_context = replace(additional_context, '{{pick:team-channel}}', 'your team channel')
WHERE template_id = 'sprint-retrospective-lead'
  AND (responsibilities LIKE '%{{pick:team-channel}}%' OR additional_context LIKE '%{{pick:team-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your legal channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your legal channel')
WHERE template_id = 'supply-agreement-analyst'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:alert-channel}}', 'your support channel'),
  additional_context = replace(additional_context, '{{pick:alert-channel}}', 'your support channel')
WHERE template_id = 'support-operations-analyst'
  AND (responsibilities LIKE '%{{pick:alert-channel}}%' OR additional_context LIKE '%{{pick:alert-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:working-folder}}', 'your knowledge base'),
  additional_context = replace(additional_context, '{{pick:working-folder}}', 'your knowledge base')
WHERE template_id = 'support-operations-analyst'
  AND (responsibilities LIKE '%{{pick:working-folder}}%' OR additional_context LIKE '%{{pick:working-folder}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:digest-channel}}', 'your support channel'),
  additional_context = replace(additional_context, '{{pick:digest-channel}}', 'your support channel')
WHERE template_id = 'support-queue-reporter'
  AND (responsibilities LIKE '%{{pick:digest-channel}}%' OR additional_context LIKE '%{{pick:digest-channel}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:docs-location}}', 'your documentation workspace'),
  additional_context = replace(additional_context, '{{pick:docs-location}}', 'your documentation workspace')
WHERE template_id = 'technical-writer'
  AND (responsibilities LIKE '%{{pick:docs-location}}%' OR additional_context LIKE '%{{pick:docs-location}}%');

UPDATE internal_agents SET
  responsibilities   = replace(responsibilities,   '{{pick:engineering-channel}}', 'your engineering channel'),
  additional_context = replace(additional_context, '{{pick:engineering-channel}}', 'your engineering channel')
WHERE template_id = 'technical-writer'
  AND (responsibilities LIKE '%{{pick:engineering-channel}}%' OR additional_context LIKE '%{{pick:engineering-channel}}%');

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
