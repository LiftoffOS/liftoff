// The workspace actions, registered as the CAIO's own tools.
//
// platform-backend owns the shared workspace-action registry (teams, reviews,
// connections, collaborators, activity, help centre, administration) and
// serves its manifest at GET /api/internal/workspace-actions/tools. This
// module fetches that manifest and registers each entry as a WorkforcePlanTool
// whose execute POSTs to /api/internal/workspace-actions with the caller
// headers (the reverse direction of platform-backend's
// buildWorkforceCallHeaders), so the action runs THERE as the person the CAIO
// speaks for, with the same role rule, preview → confirm and audit as every
// other surface. The manifest carries the role rule already applied
// (`roles`), so this side records who may call each tool without keeping a
// copy of platform-backend's permissions table.
//
// Availability is never silent. At startup the first attempt is awaited (a
// healthy backend registers the tools before the server listens); the four
// retries (1 s, 2 s, 4 s, 8 s) run behind it so an unreachable backend never
// delays the listen. Afterwards it re-runs every five minutes for the life of
// the process (unref'd) so a backend that comes back later still registers
// the tools, and a manifest that adds or removes tools updates the registry
// and REMOTE_TOOL_PERMISSIONS. The chat service waits for an attempt in
// flight and triggers one of its own when the remote set is empty and the
// last attempt is older than a minute. Every fetch has a timeout; every
// failure logs at error; /health carries the last outcome.

import { log } from '../../infrastructure/logging.js';
import { loadConfig } from '../../infrastructure/config.js';
import { getServiceAuthHeaders } from '../../infrastructure/service-auth.js';
import { buildCallerHeaders } from '../caller-context.js';
import {
  getRegisteredWorkforcePlanTool,
  registerWorkforcePlanTool,
  unregisterWorkforcePlanTool,
} from './dispatcher.js';
import { REMOTE_TOOL_PERMISSIONS } from './role-matrix.js';
import type { WorkforcePlanRole, WorkforcePlanTool, WorkforcePlanToolContext } from './types.js';
import type { LLMToolDefinition } from '../../llm/types.js';

interface RemoteToolManifestEntry {
  definition: LLMToolDefinition;
  permission: string | null;
  mutating: boolean;
  /** The roles platform-backend's role rule admits for this tool. */
  roles: WorkforcePlanRole[];
}

export interface RemoteWorkspaceActionsStatus {
  status: 'ok' | 'unavailable';
  lastSuccessAt: string | null;
  lastError: string | null;
  lastAttemptAt: string | null;
  toolCount: number;
}

const REFRESH_INTERVAL_MS = 5 * 60_000;
const INLINE_REFRESH_MIN_AGE_MS = 60_000;
const STARTUP_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000];
/** The manifest is small; a backend that does not answer in this time is
 *  down for the purposes of this attempt. */
const MANIFEST_TIMEOUT_MS = 10_000;
/** A read answers in seconds; a call that outlives this is a hung backend,
 *  not a slow one. */
const DISPATCH_TIMEOUT_MS = 120_000;
/** A mutating action can rebuild a team (team_update's confirm distils it
 *  before anything is saved), and a rebuild can take minutes. A two-minute
 *  wait can time out while platform-backend is still finishing the rebuild,
 *  and the Chief AI Officer then tells the person "nothing changed" about a
 *  team that is already on its new version. The wait is sized to the work, and matches the ceiling the chat-turns
 *  queue gives a redistill. */
const MUTATING_DISPATCH_TIMEOUT_MS = 600_000;

const state: RemoteWorkspaceActionsStatus = {
  status: 'unavailable',
  lastSuccessAt: null,
  lastError: null,
  lastAttemptAt: null,
  toolCount: 0,
};
let lastAttemptMs = 0;
let inflight: Promise<'ok' | 'unavailable'> | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let startupRetries: Promise<'ok' | 'unavailable'> | null = null;
/** The names this module registered, so a manifest that drops one can
 *  unregister it and nothing else. */
const registeredRemote = new Set<string>();

function getPlatformBackendUrl(): string {
  return loadConfig().PLATFORM_BACKEND_URL.replace(/\/$/, '');
}

export function getRemoteWorkspaceActionsStatus(): RemoteWorkspaceActionsStatus {
  return { ...state };
}

/** One workspace action, run in platform-backend as the person named by
 *  `caller`. What a remote tool's execute does for the CAIO's turn, and what
 *  the provisioning path does for the approver minutes after their turn: the
 *  same POST, the same headers, the same result shape (the dispatcher's JSON
 *  when it parses, `{ result: text }` otherwise). */
export async function dispatchWorkspaceActionAs(
  tool: string,
  input: Record<string, unknown>,
  caller: Pick<WorkforcePlanToolContext, 'tenantId' | 'accountId' | 'role' | 'origin'>,
  /** How long to wait: a read's seconds, or a rebuild's minutes. */
  timeoutMs: number = DISPATCH_TIMEOUT_MS,
): Promise<unknown> {
  const baseUrl = getPlatformBackendUrl();
  const headers = await getServiceAuthHeaders(baseUrl, loadConfig().WORKFORCE_SERVICE_TOKEN);
  const resp = await fetch(`${baseUrl}/api/internal/workspace-actions`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      ...buildCallerHeaders(caller),
    },
    body: JSON.stringify({ tenantId: caller.tenantId, tool, input }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return { ok: false, error: `The workspace could not be reached for this action (HTTP ${resp.status}). ${text.slice(0, 300)}` };
  }
  const body = (await resp.json()) as { result?: string };
  const text = body.result ?? '';
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { result: text };
  }
}

/** The tool the CAIO calls: a POST to platform-backend as the person. */
function remoteTool(entry: RemoteToolManifestEntry): WorkforcePlanTool {
  return {
    definition: entry.definition,
    execute: (input: Record<string, unknown>, ctx: WorkforcePlanToolContext) =>
      dispatchWorkspaceActionAs(
        entry.definition.name,
        input,
        ctx,
        entry.mutating ? MUTATING_DISPATCH_TIMEOUT_MS : DISPATCH_TIMEOUT_MS,
      ),
  };
}

async function fetchManifest(): Promise<RemoteToolManifestEntry[]> {
  const baseUrl = getPlatformBackendUrl();
  const headers = await getServiceAuthHeaders(baseUrl, loadConfig().WORKFORCE_SERVICE_TOKEN);
  const resp = await fetch(`${baseUrl}/api/internal/workspace-actions/tools`, {
    headers,
    signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from platform-backend /api/internal/workspace-actions/tools`);
  const body = (await resp.json()) as { tools?: unknown };
  if (!Array.isArray(body.tools)) throw new Error('platform-backend returned no `tools` array; the response shape changed');
  const entries = body.tools as RemoteToolManifestEntry[];
  for (const e of entries) {
    if (!e || typeof e !== 'object' || !e.definition || typeof e.definition.name !== 'string') {
      throw new Error('platform-backend returned a tool without a definition name; the manifest shape changed');
    }
  }
  return entries;
}

/** Apply a manifest to the registry: register what is new, replace what
 *  changed, unregister what is gone. Built-in tools are never touched. */
function applyManifest(entries: RemoteToolManifestEntry[]): void {
  const next = new Map(entries.map((e) => [e.definition.name, e]));
  for (const name of Array.from(registeredRemote)) {
    if (!next.has(name)) {
      unregisterWorkforcePlanTool(name);
      registeredRemote.delete(name);
      delete REMOTE_TOOL_PERMISSIONS[name];
    }
  }
  for (const [name, entry] of next) {
    if (getRegisteredWorkforcePlanTool(name) && !registeredRemote.has(name)) {
      // A built-in tool with the same name: the registry keeps its own.
      log.error({ tool: name }, 'workspace-actions: remote tool name collides with a built-in tool; the built-in is kept');
      continue;
    }
    if (registeredRemote.has(name)) unregisterWorkforcePlanTool(name);
    registerWorkforcePlanTool(remoteTool(entry));
    registeredRemote.add(name);
    REMOTE_TOOL_PERMISSIONS[name] = {
      permission: entry.permission ?? null,
      mutating: entry.mutating === true,
      roles: Array.isArray(entry.roles) ? entry.roles : [],
    };
  }
  state.toolCount = registeredRemote.size;
}

async function attemptOnce(): Promise<'ok' | 'unavailable'> {
  lastAttemptMs = Date.now();
  state.lastAttemptAt = new Date(lastAttemptMs).toISOString();
  try {
    const entries = await fetchManifest();
    applyManifest(entries);
    state.status = 'ok';
    state.lastSuccessAt = new Date().toISOString();
    state.lastError = null;
    log.info({ toolCount: registeredRemote.size }, 'workspace-actions: remote tools registered');
    return 'ok';
  } catch (err) {
    state.status = 'unavailable';
    state.lastError = (err as Error).message;
    log.error({ error: (err as Error).message }, 'workspace-actions: remote tool manifest fetch failed');
    return 'unavailable';
  }
}

/** One fetch, shared by concurrent callers. */
export function refreshRemoteWorkspaceActions(): Promise<'ok' | 'unavailable'> {
  if (!inflight) {
    inflight = attemptOnce().finally(() => { inflight = null; });
  }
  return inflight;
}

async function retryWithBackoff(
  sleep: (ms: number) => Promise<void>,
  backoff: readonly number[],
): Promise<'ok' | 'unavailable'> {
  let outcome: 'ok' | 'unavailable' = 'unavailable';
  for (const delay of backoff) {
    await sleep(delay);
    outcome = await refreshRemoteWorkspaceActions();
    if (outcome === 'ok') break;
  }
  return outcome;
}

/**
 * Startup registration. The first attempt is awaited, so a healthy backend
 * registers the tools before the server listens; when it fails, the retries
 * (backoff 1 s, 2 s, 4 s, 8 s) continue behind the returned promise and the
 * five-minute refresh takes over afterwards. Resolves with the first
 * attempt's outcome. The process starts either way: a CAIO with its built-in
 * tools is better than no CAIO, and the refresh registers the rest when the
 * backend answers.
 */
export async function registerRemoteWorkspaceActions(
  opts: { sleep?: (ms: number) => Promise<void>; backoffMs?: readonly number[]; schedule?: boolean } = {},
): Promise<'ok' | 'unavailable'> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const backoff = opts.backoffMs ?? STARTUP_BACKOFF_MS;
  const first = await refreshRemoteWorkspaceActions();
  if (first !== 'ok' && backoff.length > 0) {
    startupRetries = retryWithBackoff(sleep, backoff).finally(() => { startupRetries = null; });
  }
  if (opts.schedule !== false && !refreshTimer) {
    refreshTimer = setInterval(() => { void refreshRemoteWorkspaceActions(); }, REFRESH_INTERVAL_MS);
    refreshTimer.unref();
  }
  return first;
}

/** The startup retries still running, for a caller that must wait for them
 *  (tests; a drain hook). Resolves at once when none are running. */
export function startupRetriesSettled(): Promise<'ok' | 'unavailable' | null> {
  return startupRetries ?? Promise.resolve(null);
}

/** Called by the chat service before listing tools: an attempt in flight is
 *  waited for; when the remote set is empty and the last attempt is older
 *  than a minute, one more is made, so a turn never runs without the tools
 *  when the backend has come back. */
export async function ensureRemoteWorkspaceActions(): Promise<void> {
  if (inflight) { await inflight; return; }
  if (registeredRemote.size > 0) return;
  if (Date.now() - lastAttemptMs < INLINE_REFRESH_MIN_AGE_MS) return;
  await refreshRemoteWorkspaceActions();
}

/** Test seam. */
export function _resetRemoteWorkspaceActions(): void {
  for (const name of Array.from(registeredRemote)) {
    unregisterWorkforcePlanTool(name);
    delete REMOTE_TOOL_PERMISSIONS[name];
  }
  registeredRemote.clear();
  state.status = 'unavailable';
  state.lastSuccessAt = null;
  state.lastError = null;
  state.lastAttemptAt = null;
  state.toolCount = 0;
  lastAttemptMs = 0;
  inflight = null;
  startupRetries = null;
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}
