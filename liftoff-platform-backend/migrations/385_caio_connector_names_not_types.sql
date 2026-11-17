-- Migration 385: the Chief AI Officer stops printing connector types at people.
--
-- Left alone, the CAIO can close a planning conversation with:
--
--   "Confirmed: WebClaw is a supported connector but not yet connected. Gmail
--    (google_mail), Google Sheets, and Zoho CRM (zoho) are all active."
--
-- `google_mail` and `zoho` are the catalog's internal type slugs. They are how
-- the platform addresses a connector in a tool argument, and they are on the
-- screen of somebody who did not ask for one, next to the display name that
-- says the same thing in English.
--
-- The model was not inventing this. connectors__list_available returns BOTH
-- identifiers side by side for every entry:
--
--   { type: 'google_mail', name: 'Gmail', category, connected, connectionStatus }
--
-- and nothing has ever said which of the two the person is allowed to see. The
-- type is genuinely load-bearing everywhere else in this prompt: template
-- matching compares `connectorType` against that list, and `spec.connectors`
-- carries types into workforce_plan__draft. So the prompt trades in slugs
-- throughout, and then hopes none of them reach the reply.
--
-- The prompt already gets this exactly right one section away, for the org
-- chart: "`nodes[].id` is yours to choose and is never shown". Liftoff's own
-- prompt gets it right for teams: "Team ids belong in the tool call and nowhere
-- else. When you speak about a team, use its name." The connector catalog is
-- the same shape of hazard and had no such rule, so this adds it, in the
-- connector section where the types are handed over.
--
-- The Confidentiality section's "Never expose raw database identifiers,
-- internal field names, internal tool names, or model names" did not cover it,
-- and is not being changed. A connector type does not read as a database
-- identifier: it reads as the connector's name, because it is the name this
-- prompt uses for it fourteen lines earlier. A general rule cannot fix an
-- ambiguity that a specific instruction creates, which is why the rule goes
-- next to the instruction.
--
-- Not fixed by dropping `type` from the tool's output: the CAIO needs it to
-- match template requirements and to fill spec.connectors. The tool's
-- description gains the same distinction in the same change (workforce-service,
-- connectors-list-available.ts) so the rule is stated at both ends.
--
-- Targeted replace() against one exact anchor, the same shape as 384, so
-- nothing applied after it can be silently reverted. replace() on a
-- non-matching anchor is a no-op that still reports one row updated, so the
-- verification block asserts both halves: the new text is present, and it is
-- present exactly once.
--
-- RLS: internal_agents is FORCE row-level-security and system agents carry
-- tenant_id IS NULL, so no tenant-scoped policy reaches this row. Migrations
-- run as liftoff_app, which owns the table, so dropping FORCE for the length of
-- this transaction is the owner's equivalent of the admin pool's BYPASSRLS.
-- ALTER TABLE holds ACCESS EXCLUSIVE until COMMIT, so no other session observes
-- the table unforced. Required by scripts/ci-fences/system-agent-rls-fence.sh.
--
-- Does not touch the AGENT_VOICE_BLOCK section, so
-- scripts/__tests__/caio-prompt-voice-sync.test.ts stays pointed at 359.

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

UPDATE internal_agents
SET system_prompt = replace(
      system_prompt,
      -- The last bullet of the Connector guidance section. The new rule goes
      -- immediately above it, inside the section that hands over the types.
      $ANCHOR$- All data objects within a connector are granted by default. Users can fine-tune access on each AI team's settings page if needed.$ANCHOR$,
      $NEW$- Every connector in the catalog comes back with two identifiers: a `type` such as `google_mail` or `zoho`, and a display name such as "Gmail" or "Zoho CRM". The type belongs in tool arguments and in `spec.connectors`, and nowhere else. When you write to the person, use the display name on its own. Never put a type in a sentence, in a plan summary, or in parentheses beside the display name: "Gmail (google_mail)" hands somebody an internal identifier they did not ask for and cannot use.
- All data objects within a connector are granted by default. Users can fine-tune access on each AI team's settings page if needed.$NEW$
    ),
    updated_at = NOW()
WHERE system_role = 'caio'
  AND is_system = TRUE;

-- Verified while FORCE is still off, so the check reads the row it just wrote.
--
-- replace() on a string that does not match is a silent no-op that leaves the
-- UPDATE reporting a row count of 1, so "it ran" proves nothing. The
-- single-occurrence counts assert that the new rule landed AND that a second
-- application did not duplicate the anchor it was inserted above.
DO $verify$
DECLARE
  rule_count integer;
  anchor_count integer;
BEGIN
  SELECT (length(system_prompt) - length(replace(system_prompt, 'The type belongs in tool arguments', '')))
         / length('The type belongs in tool arguments'),
         (length(system_prompt) - length(replace(system_prompt, '- All data objects within a connector are granted by default.', '')))
         / length('- All data objects within a connector are granted by default.')
    INTO rule_count, anchor_count
  FROM internal_agents
  WHERE system_role = 'caio' AND is_system = TRUE;

  IF rule_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 385: expected exactly one connector-naming rule, found %', rule_count;
  END IF;

  IF anchor_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 385: expected the anchor bullet exactly once, found %', anchor_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM internal_agents
    WHERE system_role = 'caio'
      AND is_system = TRUE
      AND system_prompt LIKE '%When you write to the person, use the display name on its own%'
      AND system_prompt LIKE '%hands somebody an internal identifier they did not ask for%'
      -- The section it was inserted into survived.
      AND system_prompt LIKE '%## Connector guidance%'
      -- 384's rules are still there, above it.
      AND system_prompt LIKE '%treat its answer as the ONLY authority%'
  ) THEN
    RAISE EXCEPTION 'migration 385: CAIO system_prompt was not updated as expected';
  END IF;
END
$verify$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
