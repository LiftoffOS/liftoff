-- 432: pointing without taking over.
--
-- A person watching the browser can point at something in the live view
-- without taking the wheel: the runtime resolves the point to the control
-- under it and records it as a hold of kind 'point', zero-length, started
-- and ended in the same instant with end_reason 'released' and the capture
-- columns null, carrying exactly one action of kind 'point'. The record then
-- reads "the person pointed at link "Sports"" in its place in time, the
-- conversation gets a status row and a turn for it, and the assistant treats
-- the pointed-at control as the thing the person means.
--
-- kind defaults to 'takeover', which is what every existing hold is. The
-- ten-kind action CHECK from 424 becomes the eleven-kind one.

ALTER TABLE browser_takeover_holds
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'takeover'
    CHECK (kind IN ('takeover', 'point'));

ALTER TABLE browser_takeover_actions DROP CONSTRAINT browser_takeover_actions_kind_check;
ALTER TABLE browser_takeover_actions
  ADD CONSTRAINT browser_takeover_actions_kind_check
  CHECK (kind IN ('navigate', 'click', 'submit', 'change', 'enter', 'key', 'scroll', 'drag', 'contextmenu', 'hover', 'point'));

COMMENT ON COLUMN browser_takeover_holds.kind IS
  '''takeover'' for a hold the person drove; ''point'' for a zero-length hold recording one control the person pointed at without taking over.';
