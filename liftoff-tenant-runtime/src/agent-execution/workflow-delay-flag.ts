// Workflow delay steps feature flag.
//
// Default: ON. Set WORKFLOW_DELAY_STEPS_ENABLED=off explicitly to disable
// (rollback path). When ON, workflow agents may emit step.type='delay' and
// the executor suspends/resumes via agent_scheduled_invocations.
export function isWorkflowDelayStepsEnabled(): boolean {
  return (process.env.WORKFLOW_DELAY_STEPS_ENABLED ?? 'on').toLowerCase() !== 'off';
}
