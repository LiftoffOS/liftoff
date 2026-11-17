// Limits on authored workflow-step content — the single source of truth.
//
// Four layers used to disagree about how long a step description could be, and
// the layer that governed agent behaviour was the one nobody could see:
//
//   generator (distill tool schema)   500 on tool_call, unbounded on the rest
//   distill validation               500
//   persisted (create + update zod)  1000  ← rejected the team, a bare 400
//   runtime step prompt              512, shrinking long strings to ~200
//
// The consequence was a dead zone: a description of 513-1000 characters saved
// cleanly and was then silently cut to roughly 200 characters on every run. For
// an `llm_reason` step the description IS the prompt the agent executes, so
// those agents were running on a quarter of their instruction with nothing
// logged and nothing visible.
//
// The field is an instruction, not a label. Display labels come from
// `workflowVisualizationSteps` ({id, label}, "max 5 words"), generated
// separately in workflow-visualization-steps-service.ts, which never reads this
// field — and the dashboard never renders it. So this is sized for the one job
// it has: carrying what a step must accomplish.
//
// The bound is deliberately generous. Its purpose is to stop abuse, not to
// enforce style: comparable authored fields allow 50,000 (userInstructions) and
// 16,384 (toolInputTemplate), and no reference agent framework caps authored
// instruction text at all — agno's Step.description has no limit, while
// hermes-agent, deer-flow, omnigent and openclaw bound only tool output,
// external content or terminal display. Brevity is asked for in the generator
// prompt, which is where style belongs; a hard limit can only fail opaquely at
// save time, long after the writing decision was made.
//
// Every layer must agree with this value. workflow-step-limits.contract.test.ts
// enforces that, because three of tonight's defects were a contract agreed in
// one place and violated in another.
export const WORKFLOW_STEP_DESCRIPTION_MAX = 10_000;
