// Can a REAL recorded conversation still be rebuilt for another engine?
//
// Certification already asks that of fixtures, and now asks it well: it asserts
// the user turns survive, the codewords with them, and that the target adapter
// accepts the result against the vendor's own schema. `certify-engines` runs all
// of that weekly against the real SDKs in the built image.
//
// None of it touches the WRITER. Every fixture is a canned message list checked
// into this repo; the thing that produces canonical records in production is
// never exercised. That is not a hypothetical gap:
//
//   A recorder that taps adapter OUTPUT events and records no input writes
//   canonical rows that are ASSISTANT-ONLY. A rebuild fires correctly,
//   translates correctly, and hands the next engine the agent's own past
//   answers with none of the questions. Asked what it had been told, the model
//   replies NO CONTEXT — the honest answer to what it received. Every count
//   matches throughout. Fixtures cannot catch it, because a fixture is written
//   by hand and therefore always has the turns somebody remembered to put in it.
//
// So this reads what production actually wrote. It takes recent canonical
// records, checks they are whole conversations rather than half of one, and
// rebuilds each for every other shipped engine — asserting the content survives
// and the target adapter can read the result.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not send turns, mutate an agent's
// provider, or call a model. An earlier design did: plant two codewords across
// two turns, flip the agent to another vendor, ask for the codewords back. That
// is the strongest possible check — it is how an assistant-only record shows
// up — and it is the wrong shape for a job that runs unattended every night,
// because it mutates a live agent's configuration and leaves it mutated if the
// process dies between the flip and the restore.
//
// The trade is worth naming rather than hiding: this catches a record that
// cannot be rebuilt, and it catches an assistant-only record on the first row
// written. It does NOT prove a model can answer from the rebuilt
// conversation. That last step stays a deliberate, attended check.

import { getPoolForService } from '../infrastructure/database';
import { scrubLogger } from '../observability/scrub-logger';
import { repairForReplay } from '../trajectories/repair';
import { canonicalToEngine, inverseMapperShipped } from '../trajectories/inverse';
import type { CanonicalMessage } from '../trajectories/types';
import { RESOLVABLE_EXECUTION_ENGINE_IDS } from '../agent-execution/adapter/types';
import type { ExecutionEngineId } from '../agent-execution/adapter/types';

/** Records to sample per run. Small on purpose: this is a canary, not an audit.
 *  A defect in the writer is systemic — it affects every row, not a rare one —
 *  so a handful of recent records answers the question as well as all of them,
 *  and a nightly job that reads the whole table is a nightly table scan. */
const SAMPLE_SIZE = 20;

/** Engines a record is rebuilt INTO. An engine with no shipped inverse mapper
 *  keeps today's cold start, so asking it to rebuild would fail a check for a
 *  behaviour we deliberately have not built yet — the loop below skips those.
 *
 *  Derived rather than listed, so the two filters cannot disagree about which
 *  engines exist. They did: the written-out list omitted `xai-openai-wire`
 *  entirely, so the one job whose purpose is to notice an unrebuildable record
 *  never asked about the engine every Grok run uses. */
const TARGET_ENGINES: readonly ExecutionEngineId[] = RESOLVABLE_EXECUTION_ENGINE_IDS;

export interface RebuildCanaryFinding {
  scope: 'chat' | 'autonomous';
  key: string;
  sourceEngine: string;
  targetEngine?: string;
  problem: string;
}

export interface RebuildCanaryResult {
  sampled: number;
  rebuildsAttempted: number;
  findings: RebuildCanaryFinding[];
  /** Records holding no user turn at all — the assistant-only defect. Counted
   *  separately because it is a fault in the WRITER, and one occurrence means
   *  every record written since is suspect, not just this one. */
  halfConversations: number;
}

interface SampledRecord {
  scope: 'chat' | 'autonomous';
  key: string;
  agentId: string;
  sourceEngine: string;
  messages: CanonicalMessage[];
}

function asMessages(raw: unknown): CanonicalMessage[] | null {
  if (!Array.isArray(raw)) return null;
  return raw as CanonicalMessage[];
}

/** Recent canonical records from both stores. Ordered newest-first: a writer
 *  regression shows up in what was written most recently, and an old record was
 *  already judged by an earlier run of this job. */
async function sampleRecords(limit: number): Promise<SampledRecord[]> {
  const pool = getPoolForService('scheduled-execution');
  const out: SampledRecord[] = [];

  const chat = await pool.query<{
    thread_id: string; agent_id: string; execution_engine: string | null; canonical_content: unknown;
  }>(
    `SELECT thread_id, agent_id, execution_engine, canonical_content
       FROM chat_sessions
      WHERE canonical_content IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT $1`,
    [limit],
  );
  for (const r of chat.rows) {
    const messages = asMessages(r.canonical_content);
    if (!messages) continue;
    out.push({
      scope: 'chat',
      key: r.thread_id,
      agentId: r.agent_id,
      sourceEngine: r.execution_engine ?? 'unknown',
      messages,
    });
  }

  const auto = await pool.query<{
    trigger_key: string; agent_id: string; execution_engine: string | null; canonical_content: unknown;
  }>(
    `SELECT trigger_key, agent_id, execution_engine, canonical_content
       FROM agent_run_sessions
      WHERE canonical_content IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT $1`,
    [limit],
  );
  for (const r of auto.rows) {
    const messages = asMessages(r.canonical_content);
    if (!messages) continue;
    out.push({
      scope: 'autonomous',
      key: r.trigger_key,
      agentId: r.agent_id,
      sourceEngine: r.execution_engine ?? 'unknown',
      messages,
    });
  }

  return out;
}

export async function runCanonicalRebuildCanary(
  sampleSize = SAMPLE_SIZE,
): Promise<RebuildCanaryResult> {
  // Imported lazily and ONCE. A static import would pull every vendor SDK into
  // this module's graph at require time — the Anthropic SDK ships ESM that the
  // test runner cannot parse — for a job whose whole purpose is to read rows.
  const { constructAdapterForEngine } = await import('../agent-execution/adapter');
  const records = await sampleRecords(sampleSize);
  const findings: RebuildCanaryFinding[] = [];
  let rebuildsAttempted = 0;
  let halfConversations = 0;

  for (const record of records) {
    // THE writer check. A record with no user turn cannot answer anything asked
    // of it, however faithfully it is translated afterwards.
    const userTurns = record.messages.filter((m) => m.role === 'user').length;
    if (userTurns === 0) {
      halfConversations++;
      findings.push({
        scope: record.scope,
        key: record.key,
        sourceEngine: record.sourceEngine,
        problem:
          `canonical record holds ${record.messages.length} messages and NO user turn — `
          + 'half a conversation; a rebuild would hand the next engine the agent\'s own '
          + 'answers with none of the questions',
      });
      // No point rebuilding it: every downstream check would pass on content
      // that is already useless, which is the whole shape of this defect.
      continue;
    }

    const sourceEngine = record.sourceEngine as ExecutionEngineId;
    for (const targetEngine of TARGET_ENGINES) {
      if (targetEngine === sourceEngine) continue;
      if (!inverseMapperShipped(targetEngine)) continue;
      rebuildsAttempted++;

      let rebuilt;
      try {
        const repaired = repairForReplay(record.messages, {
          sourceEngine,
          targetEngine,
          targetSupportsImages: false,
        });
        rebuilt = canonicalToEngine(targetEngine, repaired);
      } catch (err) {
        findings.push({
          scope: record.scope, key: record.key, sourceEngine, targetEngine,
          problem: `repair/inverse threw: ${(err as Error).message}`,
        });
        continue;
      }

      if (!rebuilt || rebuilt.length === 0) {
        findings.push({
          scope: record.scope, key: record.key, sourceEngine, targetEngine,
          problem: 'rebuild produced no messages',
        });
        continue;
      }
      if (!rebuilt.some((m) => m.role === 'user')) {
        findings.push({
          scope: record.scope, key: record.key, sourceEngine, targetEngine,
          problem: 'rebuild dropped every user turn — the record had them, the translation lost them',
        });
        continue;
      }

      // The other side of the seam: can the target engine READ it? This is the
      // check whose absence let `item.content.map is not a function` reach
      // production — the rebuild was correct and the adapter could not consume
      // it. Adapters that replay history as a text preamble implement no probe
      // and are skipped, having no structured shape to get wrong.
      try {
        constructAdapterForEngine(targetEngine).assertCanReplayHistory?.(rebuilt);
      } catch (err) {
        findings.push({
          scope: record.scope, key: record.key, sourceEngine, targetEngine,
          problem: `target engine cannot read the rebuilt history: ${(err as Error).message}`,
        });
      }
    }
  }

  // A canary that found nothing to look at has not established that anything is
  // well. With sessions present and not one canonical record, this would
  // return zero findings and report healthy every night forever. That is the
  // exact shape of the defect the
  // canary exists to catch, reproduced in the canary — a green signal standing
  // in for an absent one.
  //
  // Reported as a finding rather than as a separate flag, so it reaches the same
  // alert. Distinguishing "nothing was written" from "what was written is
  // broken" is the alert text's job; both mean the rebuild path is not covered
  // tonight, and silence is the wrong answer to either.
  if (records.length === 0) {
    findings.push({
      scope: 'chat',
      key: '(none)',
      sourceEngine: 'n/a',
      problem:
        'no canonical record exists to check — the writer has produced nothing, '
        + 'so a provider switch on any conversation here would cold-start. This is '
        + 'an absent signal, not a healthy one.',
    });
  }

  const result: RebuildCanaryResult = {
    sampled: records.length,
    rebuildsAttempted,
    findings,
    halfConversations,
  };

  scrubLogger.info({
    event: 'canonical_rebuild_canary',
    sampled: result.sampled,
    rebuildsAttempted: result.rebuildsAttempted,
    findingCount: result.findings.length,
    halfConversations: result.halfConversations,
    // Named so an alert can fire on the field rather than on a log substring.
    // False on an empty sample too: nothing checked is not the same as nothing
    // wrong, and a health field that cannot tell them apart is decoration.
    healthy: result.findings.length === 0,
    message: 'canonical rebuild canary',
  });

  for (const f of result.findings) {
    scrubLogger.error({
      event: 'canonical_rebuild_canary_finding',
      scope: f.scope,
      sourceEngine: f.sourceEngine,
      targetEngine: f.targetEngine ?? null,
      problem: f.problem,
      message: 'a recorded conversation cannot be rebuilt',
    });
  }

  return result;
}
