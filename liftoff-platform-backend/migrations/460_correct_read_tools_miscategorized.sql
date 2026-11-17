-- Correct data-vendor READ tools that were seeded with a write/outbound
-- sensitivity category.
--
-- capabilityRequiresApproval (handle mint) and the capability executor gate a
-- tool whose classification carries a BLOCKED category (write / destructive /
-- outbound / financialActions / customerCommunication / externalPublishing). A
-- tool that only fetches or looks up data performs none of those actions, so a
-- blocked category on it forces approval on a read — the approval fatigue the
-- read fast-path exists to avoid. The classification must match the side effect.
--
-- telegram_web_fetch_post_comments (tikhub) fetches post comments; every sibling
-- *_fetch_* tool is classified empty. protocol_fees_lookup (strale) reads current
-- fees, not a money movement. Both are read-only GETs in connector-service, so
-- their categories are set empty to match. UPDATEs (no-op if a row is absent);
-- 436 and the strale seed are not edited.

UPDATE tool_classification_cache SET categories = ARRAY[]::TEXT[]
 WHERE tool_name = 'telegram_web_fetch_post_comments' AND integration_type = 'tikhub';

UPDATE tool_classification_cache SET categories = ARRAY[]::TEXT[]
 WHERE tool_name = 'protocol_fees_lookup' AND integration_type = 'strale';
