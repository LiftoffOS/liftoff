// Cloud Scheduler job naming convention.
//
// Deliberately its own module with no imports: `cloud-scheduler.ts` constructs a
// `CloudSchedulerClient` at module load, so importing that file just to build a
// string would drag the GCP SDK into every consumer's boot path (and into unit
// tests that have no business talking to Cloud Scheduler).
//
// NOTE the id space: `agentId` is the RUNTIME `agents.id`, so a job name is not
// derivable from anything the Platform Backend UI shows (which displays
// `internal_agents.id`). `/internal/agents/resolve` returns the job name for
// exactly this reason. See INV-TR-010.

export function getJobName(tenantId: string, agentId: string, suffix = ''): string {
  return `liftoffos-agent-${tenantId}-${agentId}${suffix}`;
}
