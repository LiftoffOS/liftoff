-- What an approval GRANTED, recorded at the moment a person said yes.
--
-- The row already carries `tool_calls_hash`: a fingerprint of the calls as the
-- agent PROPOSED them, verified when the person approves and again at dispatch.
-- Two things it cannot say.
--
-- Which calls will RUN. A reviewer may rewrite a call before approving
-- (edited_tool_inputs, migration 376), and the edited calls are what dispatch
-- sends — never re-hashed, so between the approval and the resume nothing
-- compared what a person approved with what was about to go out.
-- `final_tool_calls_hash` is that fingerprint, over the post-edit calls, and
-- consumption refuses to dispatch calls that do not match it.
--
-- What the yes COVERED. A call asks for a reason — a control on
-- /dashboard/oversight, a destructive marker, the size of the change — and the
-- reasons in force are a closed set the code derives (approval-obligations.ts).
-- The set at approval time is the grant. Consumption recomputes the set under
-- the settings as they are THEN and asks again only about a reason the grant
-- did not cover: a control somebody tightened in between. Without the recorded
-- set, "re-run the gates" on resume re-asks forever, because structured resume
-- exists precisely to recognise the approved call and skip the ordinary gate.
--
-- `obligations_evaluator_version` is the version of the rules that computed
-- the set. A grant recorded under one version is never compared against a set
-- computed under another; it is re-asked, rather than misread.
--
-- `gate_view` is what the gate SAW when it fired: the pending tools as it
-- classified them (bare name, resolved name, connector, side effect, what the
-- classification cache said) and the run facts the reasons depend on (trust
-- level, whether the external-content gate was off, the trigger target, the
-- declared step, the running totals). The obligation set is a pure function of
-- the final calls and this view under the SETTINGS in force, so recording the
-- view at the pause is what lets the set be recomputed at approval and again at
-- consumption. The settings are never snapshotted; they are read live both
-- times, which is the whole point of recomputing.
--
-- All four NULL on rows decided before this migration. A resume that finds
-- them NULL treats the grant as covering nothing it can verify, and asks.

ALTER TABLE hitl_approval_requests
  ADD COLUMN IF NOT EXISTS final_tool_calls_hash TEXT,
  ADD COLUMN IF NOT EXISTS granted_obligations JSONB,
  ADD COLUMN IF NOT EXISTS obligations_evaluator_version INTEGER,
  ADD COLUMN IF NOT EXISTS gate_view JSONB;

COMMENT ON COLUMN hitl_approval_requests.final_tool_calls_hash IS
  'sha256 over the calls that will RUN (pending_tool_calls with edited_tool_inputs applied), written when the approval is granted and verified immediately before dispatch. NULL before migration 409.';
COMMENT ON COLUMN hitl_approval_requests.granted_obligations IS
  'The gate reasons in force for the final calls at approval time, as computed by evaluateApprovalObligations: what the yes covered. Consumption recomputes and re-asks only about a reason not in this set.';
COMMENT ON COLUMN hitl_approval_requests.obligations_evaluator_version IS
  'OBLIGATION_EVALUATOR_VERSION that produced granted_obligations. A different version at consumption means the grant is not comparable and the calls are re-asked.';
COMMENT ON COLUMN hitl_approval_requests.gate_view IS
  'How the gate classified the pending calls when it fired: the tools as it saw them and the run facts the reasons depend on. Written at the pause; read to recompute the obligation set at approval and at consumption. Settings are never snapshotted here.';
