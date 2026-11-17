// Research Scheduler Service
// Per implementation plan Phase 5.1: Monthly autonomous research for learning agents
// Ported from colab-prototype's workers/research-scheduler.ts

import { v4 as uuidv4 } from 'uuid';
import { logger } from '../infrastructure/logging';
import { getPool } from '../infrastructure/database';
import { agentExecutionService } from '../agent-execution/service';
import { invocationsService } from '../invocations/service';

// Research prompts per agent type
// Research prompts for scheduled self-education runs. These use INTERNAL
// tools only (memory_retrieve, corpus_search, research_save_finding).
// Web search is NOT available during scheduled research -- it's controlled
// separately via the web_search connector integration on a per-agent basis.
const RESEARCH_PROMPTS: Record<string, string> = {
  'hr-agent': `You are conducting a periodic self-education review to stay current on HR best practices.

Your objectives:
1. Retrieve your prior research findings using memory_retrieve to check what you already know
2. Search the organisation's knowledge base using corpus_search for recent internal documents
3. Identify gaps in your knowledge based on what you find
4. Save any new insights or updated findings using research_save_finding

Focus on actionable insights that could improve HR operations.`,

  'cai': `You are conducting a periodic self-education review to stay current on customer service capabilities.

Your objectives:
1. Retrieve your prior research findings using memory_retrieve
2. Search the knowledge base using corpus_search for recent internal materials
3. Identify gaps or outdated knowledge based on what you find
4. Save updated insights using research_save_finding

Focus on practical improvements to customer experience.`,

  'default': `You are conducting a periodic self-education review to stay current and improve your capabilities.

Your objectives:
1. Retrieve your prior research findings using memory_retrieve to check what you already know
2. Search the knowledge base using corpus_search for recent internal documents
3. Identify gaps in your knowledge based on what you find
4. Save any new insights or updated findings using research_save_finding

Focus on actionable insights relevant to your role.`,
};

// Phase 6: The scheduler used to tick every 30 days and fire every
// research-enabled agent on each tick. That architecture locked every
// tenant into the same monthly cadence and ignored `exec_config` overrides.
//
// The new model:
//   - The scheduler ticks at a fine-grained cadence (default 24h) so it
//     can notice when a fast-cadence agent becomes due without waiting a
//     full month.
//   - `runResearchJobs` then gates each agent individually against
//     `agents.exec_config.research_interval_days` (default 30). Agents
//     whose interval has not elapsed since their last research thread
//     are skipped without cost.
//
// RESEARCH_SCHEDULER_TICK_MS env var lets CI, tests, and ops tune the
// tick without a code change.
const DEFAULT_SCHEDULER_TICK_MS = 24 * 60 * 60 * 1000; // 24 hours

export function getSchedulerTickMs(): number {
  const raw = process.env.RESEARCH_SCHEDULER_TICK_MS;
  if (!raw) return DEFAULT_SCHEDULER_TICK_MS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SCHEDULER_TICK_MS;
  }
  return parsed;
}

// Per-agent research interval (days), read from exec_config with a 30-day
// default. Negative, zero, or malformed values fall back to the default
// so callers cannot accidentally disable research by setting an invalid
// override.
export const DEFAULT_RESEARCH_INTERVAL_DAYS = 30;

export function getAgentResearchIntervalDays(
  execConfig: Record<string, unknown> | null | undefined,
): number {
  if (!execConfig) return DEFAULT_RESEARCH_INTERVAL_DAYS;
  const raw = (execConfig as { research_interval_days?: unknown })
    .research_interval_days;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_RESEARCH_INTERVAL_DAYS;
  }
  return raw;
}

// Get research prompt for agent type
function getResearchPrompt(agentType: string): string {
  return RESEARCH_PROMPTS[agentType] || RESEARCH_PROMPTS['default'];
}

// Run research job for a specific agent
async function runResearchJobForAgent(
  tenantId: string,
  agentId: string,
  agentType: string
): Promise<void> {
  const jobId = `research-${uuidv4().slice(0, 8)}`;

  logger.info('Starting research job for agent', {
    job_id: jobId,
    tenant_id: tenantId,
    agent_id: agentId,
    agent_type: agentType,
  });

  try {
    // Create thread for research
    const thread = await invocationsService.createThread({
      tenantId,
      agentId,
      initiatedByType: 'scheduler',
      title: `Monthly Research - ${new Date().toISOString().split('T')[0]}`,
    });

    // Pure UUIDs — workflows.id and workflow_tasks.id are UUID columns and
    // escalation-helper INSERTs against both on the escalation path. Any
    // prefix breaks the parser with `invalid input syntax for type uuid`.
    const workflowId = uuidv4();
    const taskId = uuidv4();

    // Get research prompt
    const objective = getResearchPrompt(agentType);

    // Execute research task
    const result = await agentExecutionService.executeTask({
      tenantId,
      agentId,
      workflowId,
      taskId,
      objective,
      threadId: thread.id,
      triggeredBy: 'cron',
    });

    // Update thread status
    await invocationsService.updateThreadStatus(
      thread.id,
      tenantId,
      result.success ? 'completed' : 'failed'
    );

    logger.info('Research job completed for agent', {
      job_id: jobId,
      tenant_id: tenantId,
      agent_id: agentId,
      success: result.success,
      tool_calls: result.toolCallsExecuted,
    });
  } catch (error) {
    logger.error('Research job failed for agent', {
      job_id: jobId,
      tenant_id: tenantId,
      agent_id: agentId,
      error: (error as Error).message,
    });
  }
}

// Check whether an agent is due for a research run.
//
// Phase 6: returns true when no prior research thread exists, or when
// the most recent research thread is older than `intervalDays` days.
// Exported so tests can exercise the gating logic without the full
// scheduler cycle.
export async function isAgentDueForResearch(
  tenantId: string,
  agentId: string,
  intervalDays: number,
  deps: {
    queryLatestResearchThread: (
      tenantId: string,
      agentId: string,
    ) => Promise<{ created_at: Date } | null>;
    now?: () => Date;
  },
): Promise<boolean> {
  const latest = await deps.queryLatestResearchThread(tenantId, agentId);
  if (!latest) {
    return true;
  }
  const now = (deps.now ?? (() => new Date()))();
  const elapsedMs = now.getTime() - new Date(latest.created_at).getTime();
  const intervalMs = intervalDays * 24 * 60 * 60 * 1000;
  return elapsedMs >= intervalMs;
}

// Default implementation of the latest-research-thread lookup. Queries
// `threads` for the most recent scheduler-initiated row whose title
// starts with "Monthly Research" — the prefix written by
// runResearchJobForAgent when creating the thread above.
async function queryLatestResearchThread(
  tenantId: string,
  agentId: string,
): Promise<{ created_at: Date } | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT created_at
     FROM threads
     WHERE tenant_id = $1
       AND agent_id = $2
       AND initiated_by_type = 'scheduler'
       AND title LIKE 'Monthly Research%'
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId, agentId],
  );
  return result.rows[0] ?? null;
}

// Run research jobs for all active research-enabled agents.
//
// Phase 6: This used to fire every agent on every tick. It now gates
// each agent on `exec_config.research_interval_days` (default 30) by
// comparing against the latest scheduler-initiated thread. The overall
// scheduler tick runs daily (see startResearchScheduler), so an agent
// configured for a 7-day interval will get their research run the first
// tick after the seventh day.
export async function runResearchJobs(): Promise<void> {
  const pool = getPool();

  logger.info('Starting research jobs tick');

  try {
    // Find all active agents with research enabled
    const result = await pool.query(`
      SELECT a.id, a.tenant_id, a.agent_type, a.name, a.exec_config
      FROM agents a
      WHERE a.lifecycle = 'ACTIVE'
        AND (a.exec_config->>'research_enabled')::boolean = true
      ORDER BY a.tenant_id, a.id
    `);

    const agents = result.rows;
    logger.info('Found research-enabled agents', { count: agents.length });

    let processed = 0;
    let skipped = 0;
    for (const agent of agents) {
      try {
        const intervalDays = getAgentResearchIntervalDays(agent.exec_config);
        const due = await isAgentDueForResearch(
          agent.tenant_id,
          agent.id,
          intervalDays,
          { queryLatestResearchThread },
        );

        if (!due) {
          logger.info('Skipping research for agent — interval not yet elapsed', {
            tenant_id: agent.tenant_id,
            agent_id: agent.id,
            interval_days: intervalDays,
          });
          skipped += 1;
          continue;
        }

        await runResearchJobForAgent(
          agent.tenant_id,
          agent.id,
          agent.agent_type || 'default',
        );
        processed += 1;

        // Small delay between agents to avoid overloading
        await new Promise((resolve) => setTimeout(resolve, 5000));
      } catch (error) {
        logger.error('Failed to run research for agent', {
          agent_id: agent.id,
          tenant_id: agent.tenant_id,
          error: (error as Error).message,
        });
        // Continue with other agents
      }
    }

    logger.info('Research jobs tick completed', {
      total: agents.length,
      processed,
      skipped,
    });
  } catch (error) {
    logger.error('Failed to run research jobs', {
      error: (error as Error).message,
    });
  }
}

// Start the research scheduler.
//
// Phase 6: ticks at getSchedulerTickMs() (default 24h) and per-agent
// gating inside runResearchJobs enforces the `research_interval_days`
// from each agent's exec_config. Also runs once on startup (after a
// short delay) so fresh deployments don't wait a full tick for the
// first run.
export function startResearchScheduler(log: typeof logger): void {
  const tickMs = getSchedulerTickMs();
  log.info('Starting research scheduler', {
    tick_ms: tickMs,
    tick_hours: tickMs / (60 * 60 * 1000),
    per_agent_default_days: DEFAULT_RESEARCH_INTERVAL_DAYS,
  });

  // Run initial research on startup (with delay)
  setTimeout(async () => {
    log.info('Running initial research jobs tick on startup');
    await runResearchJobs();
  }, 60000); // 1 minute delay on startup

  // Schedule recurring ticks
  setInterval(async () => {
    log.info('Running scheduled research jobs tick');
    await runResearchJobs();
  }, tickMs);

  log.info('Research scheduler started');
}

// Export for testing
export { getResearchPrompt, RESEARCH_PROMPTS };
