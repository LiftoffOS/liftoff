// Client for the in-boundary deepeval-evaluator service (Python/DeepEval).
//
// The TS harness cannot import DeepEval (Python), so the SEMANTIC metrics
// (TaskCompletion → goal, GEval → conformance) run in the deepeval-evaluator
// Cloud Run service and are called over HTTP here. When DEEPEVAL_SERVICE_URL is
// unset or the call fails, this returns null and the caller falls back to the
// native Vertex judge — so the harness works with OR without DeepEval deployed.
//
// One request per run computes BOTH dimensions; the result is memoized per run
// key so goal.ts and conformance.ts share a single HTTP call.

import { GoogleAuth } from 'google-auth-library';
import { logger as log } from '../../../infrastructure/logging';
import type { ReconstructedRun } from '../../reconstruct/trace-model';
import { loadDesignedToolset } from '../../toolset';
import { collectToolUses, finalAssistantText, objective } from '../trajectory-util';
import type { JudgeResult } from './llm-judge';

// The evaluator is a PRIVATE (IAM-gated) Cloud Run service, so calls need a
// Google OIDC ID token whose audience is the service URL (the SA running this
// job holds run.invoker). Cached per audience; refreshed automatically.
const auth = new GoogleAuth();
async function authHeaders(url: string): Promise<Record<string, string>> {
  if (process.env.DEEPEVAL_SERVICE_TOKEN) {
    return { authorization: `Bearer ${process.env.DEEPEVAL_SERVICE_TOKEN}` };
  }
  try {
    const audience = new URL(url).origin;
    const client = await auth.getIdTokenClient(audience);
    return (await client.getRequestHeaders()) as Record<string, string>;
  } catch (err) {
    log.warn({ message: 'deepeval-client: could not mint ID token (will call unauthenticated)', err: (err as Error).message });
    return {};
  }
}

export interface DeepEvalScores {
  goal?: JudgeResult;
  conformance?: JudgeResult;
}

interface ServiceDimension {
  score?: number;
  success?: boolean;
  reason?: string;
  error?: string;
}
interface ServiceResponse {
  taskCompletion?: ServiceDimension;
  conformance?: ServiceDimension;
  toolCorrectness?: ServiceDimension;
}

const memo = new Map<string, Promise<DeepEvalScores | null>>();

export function clearDeepEvalMemo(): void {
  memo.clear();
}

/** Score a run via the deepeval-evaluator service. Returns null when the
 *  service is not configured or the call fails (caller falls back to native). */
export async function evaluateViaDeepEval(run: ReconstructedRun): Promise<DeepEvalScores | null> {
  const url = process.env.DEEPEVAL_SERVICE_URL;
  if (!url) return null;
  const cached = memo.get(run.ref.key);
  if (cached) return cached;
  const p = call(url, run).catch((err) => {
    log.warn({ message: 'deepeval-client: call failed, falling back to native judge', key: run.ref.key, err: (err as Error).message });
    return null;
  });
  memo.set(run.ref.key, p);
  return p;
}

async function call(url: string, run: ReconstructedRun): Promise<DeepEvalScores | null> {
  // Lazy-load the catalog reconstruction: it pulls the heavy tool-gateway graph,
  // which we only want when actually scoring a user-created run.
  let catalog: string[] | undefined;
  if (run.ref.agentKind === 'user-created') {
    const { reconstructUserDesignedCatalog } = await import('../../reconstruct/user-catalog');
    catalog = (await reconstructUserDesignedCatalog(run.ref)) ?? undefined;
  }
  const designed = loadDesignedToolset(run, catalog);
  const expectedTools = designed.tools ? [...designed.tools] : [];

  const payload = {
    input: objective(run.trajectory),
    actualOutput: finalAssistantText(run.trajectory),
    toolsCalled: collectToolUses(run.trajectory).map((u) => u.name),
    expectedTools,
    spec: run.spec.text,
    dimensions: ['task_completion', 'conformance'],
  };

  const res = await fetch(`${url.replace(/\/$/, '')}/evaluate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(await authHeaders(url)),
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    log.warn({ message: 'deepeval-client: non-200', status: res.status, key: run.ref.key });
    return null;
  }
  const body = (await res.json()) as ServiceResponse;
  return { goal: toJudge(body.taskCompletion), conformance: toJudge(body.conformance) };
}

function toJudge(d: ServiceDimension | undefined): JudgeResult | undefined {
  if (!d || d.error) return undefined;
  const score = clamp01(d.score ?? (d.success ? 1 : 0));
  return { score, pass: d.success ?? score >= 0.7, reasoning: d.reason ?? '' };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
