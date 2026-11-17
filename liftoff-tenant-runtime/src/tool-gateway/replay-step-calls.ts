// The dispatch-side half of the step replay ledger, for a call the MODEL issues.
//
// WHY THIS SEAM EXISTS ALONGSIDE THE OTHER TWO.
//
// Three different things dispatch a step's work, and a replay wired to one of
// them holds on some runs and not others:
//
//   1. the model, inside a step's own turn, through this tool list;
//   2. `executeToolStep`, for an authored `tool_call` step;
//   3. `dispatchRecoveryDecision`, for the advisor's corrective calls.
//
// This is (1), and the case that reaches it is a RESUME. Every HITL pause site in
// the workflow loop writes `resumeAfterStepId: currentStepId` — "re-dispatch the
// gated step on approve" — so a step whose model created a document and then hit
// a gate on a later call runs its turn again, whole, in another process. The
// ledger rides the pause payload for exactly that (step-replay-ledger.ts), and
// this is what reads it.
//
// WHY THE TOOL LIST AND NOT `mcp-bridge`. This wraps the list the in-process
// McpServer is built from, which is the one place every tool on every engine
// passes through. `observe-result-size.ts` sits at the same seam for the same
// reason, and its own headline records what happens otherwise: wired into
// `mcp-bridge`, a guarantee covers the OpenAI / Gemini loops and misses the
// ~99% of production that is Anthropic, which bypasses that bridge by
// construction.
//
// It also covers both routes a connector tool takes out of its handler: the
// gateway `execute` path and the Composio self-dispatch path are inside the same
// registered handler, so neither can opt out.
//
// OUTSIDE THE BOUND, NOT INSIDE IT. Applied so this runs FIRST and
// `observeAndBoundToolResults` never sees a replayed result. The recorded result
// is handed back exactly as the record holds it — already framed and bounded when
// it was first returned — and re-bounding it would charge the same characters to
// the turn budget a second time and could cut a result that was whole when the
// model first read it.

import { logger } from '../infrastructure/logging';
import type { StepReplayLookup } from '../agent-execution/step-replay-ledger';

interface ReplayableTool {
  name: string;
  handler: (args: never, extra: never) => Promise<unknown>;
}

/**
 * Answer a call this step has already completed with the result that call
 * returned, instead of dispatching it again.
 *
 * Nothing is fabricated: a hit returns the recorded result and nothing else
 * changes. A miss dispatches. See `step-replay-ledger.ts` for why the key is the
 * exact call and why a ledger exists only for a step that already ran.
 */
export function replayRecordedStepCalls<T extends ReplayableTool>(
  tools: T[],
  replay: StepReplayLookup,
  ctx: { tenantId: string; agentId: string; invocationId?: string },
): T[] {
  return tools.map((t) => ({
    ...t,
    handler: async (args: never, extra: never) => {
      const hit = replay.lookupByToolName(t.name, args);
      if (!hit) return t.handler(args, extra);
      logger.info({
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        invocationId: ctx.invocationId,
        stepId: replay.stepId,
        toolName: t.name,
        recordedAs: hit.name,
      }, 'a re-dispatched step repeated a call it had already completed; answered with that call\'s own result rather than sending it again');
      return hit.result;
    },
  }));
}
