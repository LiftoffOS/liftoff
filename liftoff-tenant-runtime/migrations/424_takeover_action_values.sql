-- 424: the takeover record carries what was entered, except protected data.
--
-- 418 recorded a takeover as the pages and controls the person used and
-- never a form value. That made the record a sketch: an AI team asked to
-- mirror the person's workflow needs the search term, the filter, the record
-- name. The rule now: a value entered into a control is part of the work and
-- is recorded unless the control is classified as authentication, payment,
-- high-risk identity or file input. The row keeps the omission CLASS in
-- value_disposition, so the Chief AI Officer knows a step happened without
-- receiving its value, and input_type stays the real HTML type rather than
-- being overloaded to say "credential".
--
-- value and detail are bounded before insert (2,000 and 400 characters) and
-- every descriptive field has passed the safe URL projection and the browser
-- text sanitizer; the *_truncated and *_protected_data_omitted flags say
-- what that pass changed, so a reader never presents a cut or redacted
-- string as exact. detail carries a bounded non-textual interaction (a key
-- chord, a scroll direction and position, the source control of a drag,
-- element-relative click coordinates) and never entered text.
--
-- Existing change and enter rows recorded before values were carried become
-- legacy_unavailable: their value was never observed, and an absent value
-- must not look like a deliberate empty entry. Every other older action is
-- none, which is what it always was.
--
-- The kind CHECK admits the non-textual interactions the five-kind recorder
-- missed (key, scroll, drag, contextmenu, hover), and the hold gap-reason
-- CHECK admits frame_unavailable: a page or frame the person used that the
-- recorder could not attach to now marks the hold rather than leaving a
-- segment the record presents as complete. 418's comments promised no form
-- value and are updated here by fix-forward only.

ALTER TABLE browser_takeover_actions
  ADD COLUMN value                          TEXT,
  ADD COLUMN value_disposition              TEXT NOT NULL DEFAULT 'none'
    CHECK (value_disposition IN (
      'none', 'recorded', 'authentication_omitted', 'payment_omitted',
      'sensitive_identity_omitted', 'file_omitted', 'sensitive_text_omitted',
      'legacy_unavailable'
    )),
  ADD COLUMN detail                         TEXT,
  ADD COLUMN url_truncated                  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN name_truncated                 BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN value_truncated                BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN detail_truncated               BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN url_protected_data_omitted     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN name_protected_data_omitted    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN detail_protected_data_omitted  BOOLEAN NOT NULL DEFAULT FALSE;

-- The five-kind CHECK from 418 becomes the ten-kind one.
ALTER TABLE browser_takeover_actions DROP CONSTRAINT browser_takeover_actions_kind_check;
ALTER TABLE browser_takeover_actions
  ADD CONSTRAINT browser_takeover_actions_kind_check
  CHECK (kind IN ('navigate', 'click', 'submit', 'change', 'enter', 'key', 'scroll', 'drag', 'contextmenu', 'hover'));

-- A value-bearing action recorded before this migration never observed its
-- value: that is a capture gap for the reader, not an empty entry.
ALTER TABLE browser_takeover_actions NO FORCE ROW LEVEL SECURITY;
UPDATE browser_takeover_actions
   SET value_disposition = 'legacy_unavailable'
 WHERE kind IN ('change', 'enter');
ALTER TABLE browser_takeover_actions FORCE ROW LEVEL SECURITY;

-- The hold gap-reason CHECK from 418 admits frame_unavailable.
ALTER TABLE browser_takeover_holds DROP CONSTRAINT browser_takeover_holds_gap_reason_check;
ALTER TABLE browser_takeover_holds
  ADD CONSTRAINT browser_takeover_holds_gap_reason_check
  CHECK (gap_reason IN ('lost_owner', 'cap', 'disabled', 'never_attached', 'frame_unavailable'));

-- Millisecond precision on the page cursor's column, as browser_activity has
-- from the start: the (started_at, id) cursor of ListTakeoverActivity travels
-- through a JavaScript Date, and a microsecond value that does not round-trip
-- exactly could skip a hold between pages. Existing values round to the
-- millisecond, which changes no ordering the reader can see.
ALTER TABLE browser_takeover_holds ALTER COLUMN started_at TYPE TIMESTAMPTZ(3);

COMMENT ON TABLE browser_takeover_actions IS
  'What the person did while driving: a bounded description of the page and control, and since 424 the value they entered unless the control was classified as authentication, payment, high-risk identity or file input (value_disposition keeps the omitted class). A page-authored label or path can still echo content; readers treat these as observed, untrusted data. 500 per hold, enforced by the writer.';
COMMENT ON TABLE browser_takeover_holds IS
  'One takeover of a thread''s browser by a person: opened on none -> taken_over, ended by release, absent-driver sweep, gate expiry or session close. Capture ownership (owner, generation, lease) decides which process records; capture_gap records a KNOWN interruption of observation only, including a page or frame that could not be attached (frame_unavailable).';
COMMENT ON COLUMN browser_takeover_actions.value IS
  'The entered value when value_disposition is recorded: an input or textarea value, a select''s chosen option texts, checked/unchecked, or a contenteditable control''s bounded text. Bounded to 2,000 characters before insert.';
COMMENT ON COLUMN browser_takeover_actions.value_disposition IS
  'How the entered value was handled: none, recorded, authentication_omitted, payment_omitted, sensitive_identity_omitted, file_omitted, sensitive_text_omitted, or legacy_unavailable for a change/enter row from before 424.';
COMMENT ON COLUMN browser_takeover_actions.detail IS
  'A bounded non-textual interaction: a key chord, a scroll direction and position, the source control of a drag, element-relative click coordinates. Never entered text. Bounded to 400 characters before insert.';
