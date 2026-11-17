// One agent layer over CDP, so every browser vendor can be told what to do in
// words rather than in selectors.
//
// Anchor ships its own in-session agent and keeps using it: that path already
// works and this file must never touch it. The other three vendors do not have
// one on the session the pane is showing:
//
//   Browser Use  a Browser Session (/browsers) gives cdpUrl and a live view and
//                NO agent. Its agent lives on API-V4 runs, which get their own
//                browser, so a task there acts on a browser the person is not
//                watching. Their own docs are explicit: "No V4 run endpoint
//                directly accepts a cdpUrl parameter or exposes one for a run's
//                session."
//   Browserbase  ships Stagehand as the way to do this.
//   Steel        the platform's browser; the same page over CDP.
//
// So the vendor-neutral answer is the library Browserbase already built for it,
// pointed at whatever cdpUrl the session vendor handed us. It runs the
// library's agent, not a single act: a task handed to a browser is a job of
// several steps, and a scheduled run has nobody beside it to take the steps
// one at a time. With the Jev loop (jev-loop/) this is the handoff tail.
//
// THE MODEL AND THE CREDENTIAL FOLLOW THE RUN. The loop used to hard-code one
// Anthropic model and open an Anthropic BYOK session for every run, so a
// Google or OpenAI selection would have been served with an Anthropic
// credential. Now `runStagehandTask` resolves the run's ModelSelection at tier
// `medium` (the same resolution `complete` performs), opens the BYOK session
// for THAT provider, falls back to that provider's own managed secret, and
// builds the AI SDK model with the provider's own factory — never through
// Stagehand's `modelName` string, whose factory throws for xai and
// xai. Google is Vertex in this estate (a service account
// exchanged for a short-lived token with a project and location), so
// `@ai-sdk/google` — an API key against the Generative AI endpoint — is the
// wrong package; Google is `unavailable` here until the Vertex factory is
// implemented and its test passes. A non-Anthropic selection is never sent
// with an Anthropic credential.
//
// EVERY MODEL REQUEST PRODUCES A USAGE RECORD (INV-PB-013). The AI SDK model
// handed to Stagehand's AISdkClient is wrapped with middleware whose
// `wrapGenerate` records each request with that request's reported usage and
// posts it, awaited, to the control plane's POST /api/internal/usage/record
// before `doGenerate` returns the response to the SDK — on the managed path
// only; on the BYOK path the gateway already records per request, and
// recording again would double count. Stagehand's agent handler calls the AI
// SDK's `generateText` with no `maxRetries`, so the SDK's default of two
// retries applies ABOVE the model and cannot be switched off from our side;
// the recorded unit is therefore the model call: the middleware runs inside
// `doGenerate`, once per provider request the SDK makes, retries included,
// each with its own callId — and the wrapped model's own transport is
// single-attempt (a fetch that rejects on a retryable status rather than
// retrying it), so the only retries that exist are the SDK's and each is a
// recorded row. A post that fails after its retries stops the task with
// reason `usage_unrecorded` rather than continuing unaccounted.
//
// VERSION: pinned to 2.x deliberately. From 3.x Stagehand needs its own browser
// EXTENSION, and has exactly two ways to install one — `Extensions.loadUnpacked`
// from a local path, or Browserbase's own extension-upload API. Neither exists
// for a remote CDP browser at another vendor, and 4.0.2 fails on connect with
// "File path cannot be resolved". 2.x drives the page over plain CDP and works
// anywhere. Read that before bumping the major.

import { randomUUID } from 'crypto';
import { wrapLanguageModel, type LanguageModelV1, type LanguageModelV1Middleware } from 'ai';
import { getManagedSecret } from '../../infrastructure/secret-store';
import { openByokSession } from '../../byok/session';
import { logger } from '../../infrastructure/logging';
import { taskStopMessage } from './task-stop-message';
import { llmClient } from '../../llm/client';
import type { LLMProvider, ModelSelection } from '../../llm/types';
import { resolveInternalAgentId } from '../../agent-lifecycle/resolve-runtime-agent-id';
import { getPlatformCallbackClient } from '../../platform-callback/client';
import { projectStagehandTrail, type BrowserTaskStep, type BrowserTaskTrail } from './step-policy';

/** A task is work, not a request, and it runs while somebody watches the pane
 *  or a scheduled run waits on it. Bounded so a stuck agent cannot hold the
 *  turn open indefinitely. The Jev loop shares this clock (browser-task.ts). */
export const STAGEHAND_TIMEOUT_MS = 180_000;

/** Page actions one task may take. A task is "open this page, fill these
 *  fields, submit, read the result": a handful of steps, with room for a
 *  cookie banner and a retry. Not a budget for browsing. */
const STAGEHAND_MAX_STEPS = 20;

/** Actions kept in the result, from the end. The caller feeds the result to
 *  a model, which needs the outcome and how it was reached, not a transcript.
 *  Built from the SAME safe projection as the trail: no raw `reasoning`, no
 *  raw `action` phrase, so a value the policy omitted from the record cannot
 *  reach the model's result bytes either. */
const RESULT_ACTIONS = 8;

/** The task's shared wall clock: the Jev loop and the Stagehand tail run on
 *  one deadline. */
export interface TaskClock {
  deadlineAt: number;
}

export type StagehandStopReason = 'timeout' | 'unavailable' | 'usage_unrecorded';

export interface StagehandTaskInput {
  /** The session's OWN cdp endpoint. The task acts on the browser the person is
   *  looking at, which is the whole point: acting anywhere else is the defect
   *  this replaces. */
  cdpUrl: string;
  prompt: string;
  tenantId: string;
  /** Attribution for the LLM the agent loop runs on. Without an invocation the
   *  gateway cannot match its usage rows to the run, so the call falls back to
   *  the managed key rather than routing. */
  invocationId?: string;
  runtimeAgentId?: string;
  /** The run's selection; absent for a platform-assistant task, which runs
   *  on the platform default provider at tier medium. */
  modelSelection?: ModelSelection;
  /** The task's remaining wall clock. Absent: the full STAGEHAND_TIMEOUT_MS. */
  clock?: TaskClock;
  /** The session the task runs on, for the saved-login fill
   *  (integrations/onepassword): absent, no login is applied. */
  vendor?: string;
  vendorSessionId?: string;
}

export interface StagehandTaskOutcome {
  status: string;
  result?: unknown;
  data?: unknown;
  trail: BrowserTaskTrail;
  /** Set when the loop stopped for a reason of its own rather than the
   *  vendor's: the clock, a provider this estate cannot build a model for,
   *  a usage record the control plane did not acknowledge. */
  reason?: StagehandStopReason;
}

/** Thrown from inside `doGenerate` when the usage post failed after its
 *  retries: the task stops rather than continuing unaccounted. */
export class UsageUnrecordedError extends Error {
  constructor(public readonly callId: string) {
    super('stagehand: usage record not acknowledged');
    this.name = 'UsageUnrecordedError';
  }
}

type Credential = { apiKey: string; baseURL?: string; byok: boolean };

/** The managed secret each provider's model is built with. Stated per
 *  provider, never a fallback to another provider's key. */
const MANAGED_SECRET_FOR: Readonly<Partial<Record<LLMProvider, string>>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  xai: 'XAI_API_KEY',
};

/** Where the agent loop's own tokens are billed: the BYOK gateway when the
 *  run has one, for the run's OWN provider; the provider's own managed secret
 *  otherwise. Null when neither exists for this provider. */
async function resolveCredential(
  input: StagehandTaskInput,
  provider: LLMProvider,
  modelId: string,
): Promise<Credential | null> {
  if (input.invocationId) {
    try {
      const byok = await openByokSession({
        tenantId: input.tenantId,
        invocationId: input.invocationId,
        resolvedProvider: provider,
        resolvedModelId: modelId,
        call: { callKind: 'agent_invocation' },
        ...(input.runtimeAgentId ? { runtimeAgentId: input.runtimeAgentId } : {}),
      });
      if (byok?.token) {
        return { apiKey: byok.token, ...(byok.baseUrl ? { baseURL: byok.baseUrl } : {}), byok: true };
      }
    } catch (err) {
      // A routing failure must not stop the person's click. Same rule the BYOK
      // session itself states: the cost of getting it wrong is one call.
      logger.warn(
        { err: (err as Error).message, tenantId: input.tenantId, provider },
        'stagehand: byok routing failed, using the managed key',
      );
    }
  }
  const secretName = MANAGED_SECRET_FOR[provider];
  const apiKey = secretName ? getManagedSecret(secretName) : undefined;
  return apiKey ? { apiKey, byok: false } : null;
}

/** A fetch that rejects on any retryable status rather than letting a
 *  provider SDK retry it, so the only retries are the AI SDK's own above the
 *  model — each of which re-enters `doGenerate` and is recorded. */
function singleAttemptFetch(base: typeof fetch = fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const resp = await base(input, init);
    if (resp.status === 408 || resp.status === 429 || resp.status >= 500) {
      throw Object.assign(new Error(`stagehand: provider returned ${resp.status}`), { status: resp.status });
    }
    return resp;
  }) as typeof fetch;
}

/** The AI SDK model for the run's provider, built with the provider's own
 *  factory and the resolved credential. Null for a provider this estate
 *  cannot build one for yet (google: Vertex; the gateway-served families). */
export async function buildLanguageModel(
  provider: LLMProvider,
  modelId: string,
  credential: Credential,
): Promise<LanguageModelV1 | null> {
  const fetchImpl = singleAttemptFetch();
  switch (provider) {
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      return createAnthropic({ apiKey: credential.apiKey, ...(credential.baseURL ? { baseURL: credential.baseURL } : {}), fetch: fetchImpl })(modelId);
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({ apiKey: credential.apiKey, ...(credential.baseURL ? { baseURL: credential.baseURL } : {}), fetch: fetchImpl })(modelId);
    }
    case 'xai': {
      const { createXai } = await import('@ai-sdk/xai');
      return createXai({ apiKey: credential.apiKey, ...(credential.baseURL ? { baseURL: credential.baseURL } : {}), fetch: fetchImpl })(modelId);
    }
    // Vertex needs @ai-sdk/google-vertex with the project, location and
    // service-account token; unavailable until that factory is implemented
    // and tested.
    default:
      return null;
  }
}

export interface UsageRecord {
  callId: string;
  attempts: 1;
  provider: LLMProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  tenantId: string;
  invocationId?: string;
  agentId?: string;
  success: boolean;
  error?: string;
}

/** Test seam: the usage post. True when the control plane acknowledged. */
let usagePoster: (record: UsageRecord) => Promise<boolean> = postStagehandUsage;
export function _setStagehandUsagePosterForTesting(poster: ((record: UsageRecord) => Promise<boolean>) | null): void {
  usagePoster = poster ?? postStagehandUsage;
}

const USAGE_POST_RETRIES = 2;
const USAGE_POST_TIMEOUT_MS = 5_000;

export async function postStagehandUsage(record: UsageRecord): Promise<boolean> {
  const client = getPlatformCallbackClient();
  if (!client) {
    logger.error({ callId: record.callId }, 'stagehand: no platform callback client; usage cannot be recorded');
    return false;
  }
  for (let attempt = 0; attempt <= USAGE_POST_RETRIES; attempt++) {
    try {
      const resp = await client.fetch('platform', '/api/internal/usage/record', {
        method: 'POST',
        body: JSON.stringify(record),
        signal: AbortSignal.timeout(USAGE_POST_TIMEOUT_MS),
      });
      if (resp.ok) return true;
      if (resp.status < 500) {
        logger.error({ callId: record.callId, status: resp.status }, 'stagehand: usage record refused');
        return false;
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message, callId: record.callId, attempt }, 'stagehand: usage post failed');
    }
  }
  return false;
}

/** The recording middleware: one row per provider request, posted and
 *  acknowledged before the response reaches the SDK. Exported for the test. */
export function recordingMiddleware(ctx: {
  provider: LLMProvider;
  model: string;
  tenantId: string;
  invocationId?: string;
  agentId?: string;
}): LanguageModelV1Middleware {
  return {
    wrapGenerate: async ({ doGenerate }) => {
      const callId = randomUUID();
      let result: Awaited<ReturnType<typeof doGenerate>> | undefined;
      let failure: unknown;
      let failed = false;
      try {
        result = await doGenerate();
      } catch (err) {
        failure = err;
        failed = true;
      }
      const error = failed ? ((failure as Error)?.message ?? String(failure)) : undefined;
      const recorded = await usagePoster({
        callId,
        attempts: 1,
        provider: ctx.provider,
        model: ctx.model,
        inputTokens: Math.max(0, Math.floor(result?.usage?.promptTokens ?? 0)),
        outputTokens: Math.max(0, Math.floor(result?.usage?.completionTokens ?? 0)),
        tenantId: ctx.tenantId,
        ...(ctx.invocationId ? { invocationId: ctx.invocationId } : {}),
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
        success: !failed,
        ...(error ? { error: error.slice(0, 500) } : {}),
      });
      if (!recorded) throw new UsageUnrecordedError(callId);
      // The provider's own error object, so the SDK's retry above can read
      // its retryable status; a replacement error would end the retry.
      if (failed) throw failure;
      return result as Awaited<ReturnType<typeof doGenerate>>;
    },
  };
}

/** The task, with the one rule the tail needs and does not have.
 *
 *  Asked for a video's address, the tail can open `view-source:`, go back
 *  through `about:blank`, and spend its steps there before clicking a tab.
 *  The pane is a browser a person is
 *  watching, and those addresses show them a blank window. */
function withNavigationRule(prompt: string): string {
  return `${prompt}\n\nStay on http and https addresses. Do not open view-source:, about:, file: or data: addresses: the person is watching this browser, and those show them nothing.`;
}

function stoppedOutcome(reason: StagehandStopReason, message: string): StagehandTaskOutcome {
  const trail: BrowserTaskTrail = { message, steps: [], captureGap: false, gapReason: null, stepsTruncated: false };
  return {
    status: 'incomplete',
    result: { success: false, completed: false, message, steps: 0, lastActions: [] },
    data: message,
    trail,
    reason,
  };
}

/** Drive the session at `cdpUrl` with a natural-language instruction.
 *
 *  Returns the same shape AnchorClient.runAgentTask returns, so the vendor proxy
 *  dispatches to either without adapting arguments and no caller branches on
 *  vendor — plus a SEPARATE `trail`, the loop's steps projected for the
 *  record (step-policy). The trail is beside `result`, never inside it, and
 *  the record gets every step whole rather than a JSON blob cut at a
 *  character cap. The result's `message`, top-level `data` and `lastActions`
 *  are the projection's own safe text: this is a deliberate privacy
 *  correction to the result shape, and the RPC/model contract test pins it. */
export async function runStagehandTask(
  input: StagehandTaskInput,
): Promise<StagehandTaskOutcome> {
  let resolved: { provider: LLMProvider; modelId: string };
  try {
    // The client initializes on its first completion, and this is the one
    // caller that resolves a model WITHOUT making one. A run that carries no
    // provider of its own — every task from the three platform assistants —
    // then resolves against an empty provider map and reads as "no provider
    // configured" on any instance that has served no other model call. That
    // is most instances: this service answers pane RPCs and feeds all day and
    // may never complete a turn. `init` is idempotent.
    await llmClient.init();
    resolved = llmClient.resolveForTier(input.modelSelection, 'medium');
  } catch (err) {
    logger.warn({ err: (err as Error).message, tenantId: input.tenantId }, 'stagehand: no model catalogue for the run\'s provider');
    return stoppedOutcome('unavailable', taskStopMessage('unavailable'));
  }
  const { provider, modelId } = resolved;
  const credential = await resolveCredential(input, provider, modelId);
  if (!credential) {
    logger.warn({ tenantId: input.tenantId, provider }, 'stagehand: no credential for the run\'s provider');
    return stoppedOutcome('unavailable', taskStopMessage('unavailable'));
  }
  const baseModel = await buildLanguageModel(provider, modelId, credential);
  if (!baseModel) {
    logger.warn({ tenantId: input.tenantId, provider, modelId }, 'stagehand: no AI SDK model factory for the run\'s provider');
    return stoppedOutcome('unavailable', taskStopMessage('unavailable'));
  }
  // Recorded per request on the managed path only; the gateway records the
  // BYOK path itself.
  let model: LanguageModelV1 = baseModel;
  if (!credential.byok) {
    let agentId: string | undefined;
    if (input.runtimeAgentId) {
      try {
        agentId = (await resolveInternalAgentId(input.tenantId, input.runtimeAgentId, 'stagehand-usage')) ?? undefined;
      } catch {
        // The resolver logs its own miss.
      }
    }
    model = wrapLanguageModel({
      model: baseModel,
      middleware: recordingMiddleware({
        provider, model: modelId, tenantId: input.tenantId,
        ...(input.invocationId ? { invocationId: input.invocationId } : {}),
        ...(agentId ? { agentId } : {}),
      }),
    });
  }

  // Imported here rather than at module load: this pulls in a browser
  // automation stack that most runs never touch, and the tool that needs it is
  // absent from most catalogs.
  const { Stagehand, AISdkClient } = await import('@browserbasehq/stagehand');

  const stagehand = new Stagehand({
    // LOCAL means "a browser I already have", not "a browser on this machine".
    // The cdpUrl is remote; this is the documented way to attach to one.
    env: 'LOCAL',
    localBrowserLaunchOptions: { cdpUrl: input.cdpUrl },
    // The provider's own model, never Stagehand's modelName string.
    llmClient: new AISdkClient({ model }),
    verbose: 0,
  });

  const remainingMs = input.clock ? Math.max(0, input.clock.deadlineAt - Date.now()) : STAGEHAND_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  // The saved-login fill (integrations/onepassword) on the page the agent is
  // about to drive: once before the agent looks, deterministic, and again on
  // each load inside the loop. The load listener runs beside the agent's own
  // next step: a fill that lands after the agent has already looked at an
  // empty form leaves the agent where it is today (it cannot type a
  // password; it raises intervention). That is the accepted limit of the
  // tail. The fill's steps are kept apart and joined to the trail: the
  // attach's before the agent's, the loads' after.
  const loginStepsBefore: BrowserTaskStep[] = [];
  const loginStepsDuring: BrowserTaskStep[] = [];
  let loginInFlight: Promise<unknown> = Promise.resolve();
  const applyLogin = async (page: import('playwright-core').Page, into: BrowserTaskStep[]): Promise<void> => {
    if (!input.vendor || !input.vendorSessionId) return;
    const { applySavedLoginOnTaskPage } = await import('../onepassword/autofill');
    await applySavedLoginOnTaskPage(
      { vendor: input.vendor, vendorSessionId: input.vendorSessionId, tenantId: input.tenantId, page },
      (step) => { into.push(step); },
    );
  };
  let onLoad: (() => void) | null = null;
  try {
    await stagehand.init();
    const page = stagehand.page as unknown as import('playwright-core').Page;
    await applyLogin(page, loginStepsBefore);
    onLoad = () => {
      loginInFlight = loginInFlight.then(() => applyLogin(page, loginStepsDuring)).catch(() => undefined);
    };
    page.on('load', onLoad);
    // A task is a job, not one action: "open the page, sign in with the saved
    // session, read the banner" is a navigation, several acts and an extract.
    // Stagehand's agent works the job step by step over the same CDP page —
    // observe, act, go to, extract — until it reports the task done or the
    // step bound is reached. A single `act` took the whole instruction as one
    // action and, on a page that had nothing to act on yet, found no elements.
    const agent = stagehand.agent();
    const execution = agent.execute({ instruction: withNavigationRule(input.prompt), maxSteps: STAGEHAND_MAX_STEPS });
    // The race clears its timer when execute settles, and on timeout closes
    // the session so the raced execution cannot continue unobserved.
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), remainingMs);
    });
    const raced = await Promise.race([execution.then((o) => ({ outcome: o })), timeout]);
    if (raced === 'timeout') {
      await stagehand.close().catch(() => undefined);
      execution.catch(() => undefined);
      return stoppedOutcome('timeout', taskStopMessage('timeout'));
    }
    const outcome = raced.outcome;
    const actions = outcome.actions ?? [];
    // Aggregate usage is reconciliation telemetry only; the rows are the
    // per-request records the middleware posted.
    if (outcome.usage) {
      logger.info({ tenantId: input.tenantId, provider, modelId, usage: outcome.usage, steps: actions.length }, 'stagehand: aggregate usage (telemetry)');
    }
    // Every step, no reasoning, each value classified and the closing
    // message with every omitted literal removed. The result below is a
    // view of THIS projection, never of the raw actions.
    const { protectedLiterals: _literals, ...projected } = projectStagehandTrail(actions, outcome.message);
    await loginInFlight;
    const trail: BrowserTaskTrail = {
      ...projected,
      steps: [...loginStepsBefore, ...projected.steps, ...loginStepsDuring],
    };
    const result = {
      success: outcome.success,
      completed: outcome.completed,
      message: trail.message,
      steps: actions.length,
      // The tail of the trail: what was done last, and where the page ended.
      lastActions: trail.steps.slice(-RESULT_ACTIONS).map((step) => ({
        type: step.type,
        ...(step.action ? { action: step.action } : {}),
        ...(step.pageUrl ? { pageUrl: step.pageUrl } : {}),
      })),
    };
    return { status: outcome.completed ? 'finished' : 'incomplete', result, data: trail.message, trail };
  } catch (err) {
    if (err instanceof UsageUnrecordedError || (err as { cause?: unknown })?.cause instanceof UsageUnrecordedError) {
      return stoppedOutcome('usage_unrecorded', taskStopMessage('unavailable'));
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    if (onLoad) {
      try { (stagehand.page as unknown as import('playwright-core').Page).off('load', onLoad); } catch { /* the page is gone */ }
    }
    // Detaches the CDP client. Verified against a live Browser Use browser: the
    // session stays `active` afterwards, so this does NOT take down the pane the
    // person is watching. Never allowed to throw over the caller's result.
    await stagehand.close().catch(() => undefined);
  }
}
