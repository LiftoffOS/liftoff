// Sandbox Executor
// Manages sandbox lifecycle and dispatches tool calls to the SandboxProvider.
// All tool calls route through the ToolGatewayService for HITL/permissions/audit.
// This is a dispatch target — NOT a bypass of the tool gateway pipeline.

import { v4 as uuid } from 'uuid';
import { log } from '../infrastructure/logging';
import type { SkillBundle } from '../instruction-compiler/internal-agent-instruction-service';
import {
  SandboxProvider,
  SandboxInstance,
  SandboxConfig,
  SandboxCapability,
  ExecutionEnvironmentType,
} from './types';
import { SandboxStateRepository } from './sandbox-state-repository';
import { SandboxUsageRepository } from './usage-repository';
import { SandboxAuditRepository } from './audit-repository';
import { SandboxOutputSanitizer } from './output-sanitizer';
import { SandboxRateLimiter } from './rate-limiter';
import {
  validateWorkspacePath,
  validateBranchName,
  validateCommitMessage,
  filterSecretFiles,
} from './path-validator';


import { calculateSandboxCredits, CreditCostProvider } from './credit-calculator';
import { UsageLedgerService } from '../usage-ledger/service';
import { insertAuditLog } from '../audit';
import { frameUntrusted } from '../workspace/untrusted-content-wrapper';
import {
  clearCheckpointState,
  isMutatingTool,
  listCheckpoints,
  restoreCheckpoint,
  snapshotOnce,
  workspaceTreeHash,
  type Checkpoint,
} from './checkpoint-manager';
import { recordWorkspaceFingerprint } from '../agent-execution/verify-on-stop';
import {
  buildWorkspaceResetNotice,
  captureWorkspaceManifest,
  loadWorkspaceManifest,
} from './workspace-manifest';

/** Tools whose writes the verify gate's allow-list and shell patterns cannot
 *  see, so the only way to know whether they changed anything is to look at the
 *  workspace before and after.
 *
 *  Everything absent from this list is either not a mutation or is already
 *  reported with the path it touched, and paying two sandbox execs to re-learn
 *  what we were told is waste on the hot path. */
const UNOBSERVABLE_MUTATION_TOOLS = new Set([
  'git_clone',
  'git_commit_and_push',
  'nodejs_execute',
  'nodejs_session_exec',
]);

/** Shell forms that write without matching any SHELL_WRITE_PATTERNS. */
const UNOBSERVABLE_SHELL_WRITES = [
  /\bcurl\b[^|;&]*\s-[a-zA-Z]*o\b/,   // curl -o / -sOL
  /\bwget\b/,
  /\bgit\s+apply\b/,
  /\bpatch\b/,
  /--write\b/,                        // prettier, biome, ruff format
  /\bpython3?\s+-c\b/,
  /\bnode\s+-e\b/,
  /\bunzip\b|\btar\s+-?x/,
];

function mutationIsUnobservable(toolName: string, input: unknown): boolean {
  if (UNOBSERVABLE_MUTATION_TOOLS.has(toolName)) return true;
  const args = (input ?? {}) as Record<string, unknown>;
  // code_execute writes through the language runtime unless it is bash, which
  // the shell patterns already scrape.
  if (toolName === 'code_execute' && args.language !== 'bash') return true;
  const command = typeof args.command === 'string'
    ? args.command
    : Array.isArray(args.args)
      ? args.args.filter((a): a is string => typeof a === 'string').join(' ')
      : typeof args.code === 'string' ? args.code : '';
  if (!command) return false;
  return UNOBSERVABLE_SHELL_WRITES.some((re) => re.test(command));
}

/** What the reset notice says when the previous run left no manifest. Unchanged
 *  from the text that shipped before manifests existed — it is the floor, not a
 *  placeholder. */
const GENERIC_WORKSPACE_RESET_NOTICE =
  'This run resumed with a NEW, empty workspace — the previous one was '
  + 'reclaimed while the run was paused. Any files written before the pause are gone. '
  + 'Re-create anything you still need rather than assuming it is present.';

// audit_logs.invocation_id is a UUID column with a FK to invocations(id).
// session.invocationId is a sandbox-domain handle that is not always a real
// invocation uuid (provisioning, sidecar callbacks, the parity/E2E rig pass
// composite `sandbox:<id>:<tool>:<seq>` ids). Pass it through only when it is
// a genuine uuid so the audit write never violates the FK — non-uuid handles
// audit-log with invocation_id = NULL. (The sandbox-domain tables in
// migration 286 store the raw handle as text; audit_logs is a shared
// cross-runtime table and stays uuid.)
/** How long to tell a caller to wait for a workspace that is starting.
 *
 *  PROVISIONAL. Hand-timed provisions take roughly a minute, which is a range,
 *  not a distribution — and the column that should answer this
 *  (`ready_at - created_at`) reads a few milliseconds when the row is written
 *  after provisioning finishes. Claiming the session up front makes that subtraction mean what its
 *  name says, so the next revision of this number is a query rather than
 *  another guess. Deliberately shorter than a full provision: a caller that
 *  comes back early is told to wait again, which costs one cheap round trip,
 *  whereas one that comes back late has burned the difference doing nothing. */
const SANDBOX_PROVISION_RETRY_MS = 20_000;

/** The timer ladder at this hop, written down because getting it backwards is
 *  what caused the original defect.
 *
 *    in-request wait   45s   <-- here
 *    tool-gateway      60s   (Cloud Run request timeout, Terraform)
 *    sandbox-executor 600s   (this service; provisioning keeps running)
 *
 *  Each step must be strictly shorter than the one in front of it. It was
 *  inverted — a 60-second caller waiting on work allowed 600 — so a cold
 *  provision returned a 504 to a caller whose work then completed anyway, and
 *  the requester and the workspace disagreed about whether it had happened.
 *
 *  Derived, not chosen: 45s leaves 15s of headroom under the 60s ceiling for
 *  the round trip and the response. If tool-gateway's timeout changes, this
 *  MUST move with it. */
const SANDBOX_PROVISION_WAIT_MS = 45_000;

/** A slice of a file, plus what the model needs to know to ask for the rest.
 *
 *  Character offsets rather than lines, because the values this exists for are
 *  single-line JSON parked by the offload path — the one shape line-based
 *  chunking cannot help with.
 */
export function sliceForRead(
  whole: string,
  offsetInput: unknown,
  limitInput: unknown,
): { text: string; offset: number; returned: number; totalChars: number; hasMore: boolean; note: string } {
  const o = Number(offsetInput ?? 0);
  const l = Number(limitInput ?? Number.NaN);
  const offset = Number.isFinite(o) && o > 0 ? Math.floor(o) : 0;
  const limit = Number.isFinite(l) && l > 0 ? Math.floor(l) : undefined;

  const text = limit === undefined && offset === 0
    ? whole
    : whole.slice(offset, limit === undefined ? undefined : offset + limit);
  const end = offset + text.length;
  const hasMore = end < whole.length;

  // Said in the text the model reads, not only in a sibling field: a slice that
  // does not announce itself is read as the whole file, which is the failure
  // `requiresComplete` exists to prevent.
  const note = (hasMore || offset > 0)
    ? `\n[Showing characters ${offset}-${end} of ${whole.length}.`
      + (hasMore ? ` Call file_read again with offset=${end} for the next slice.]` : ']')
    : '';

  return { text, offset, returned: text.length, totalChars: whole.length, hasMore, note };
}

/** Where a repository is checked out inside the workspace.
 *
 *  Derived from the URL so two repositories in one workspace cannot collide, and
 *  STABLE so the same repo resolves to the same directory on a later run — which
 *  is what lets an existing checkout be fetched instead of re-cloned.
 *
 *  Sanitised to one path segment: the owner and name are remote-controlled
 *  strings, and they are about to become a filesystem path passed to git.
 */
export function gitCheckoutPath(repo: string): string {
  let owner = '';
  let name = '';
  try {
    const parts = new URL(repo).pathname.replace(/\/+$/, '').replace(/^\/+|\.git$/g, '').split('/');
    name = parts.pop() ?? '';
    owner = parts.pop() ?? '';
  } catch {
    // Not a URL (scp-style or a local path). Fall back to the trailing segments
    // rather than inventing a name, so the directory still tracks the repo.
    const parts = repo.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).filter(Boolean);
    name = parts.pop() ?? '';
    owner = parts.pop() ?? '';
  }
  const safe = (v: string) => v.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[.-]+/, '').slice(0, 64);
  const slug = [safe(owner), safe(name)].filter(Boolean).join('-') || 'repo';
  return `/workspace/${slug}`;
}

/** A bare `owner/name` is a repository reference too.
 *
 *  This platform has two clone implementations and, until this function, they
 *  disagreed about what `repo` means. `code_session` takes `owner/name` and
 *  builds the URL itself (`https://<host>/<repo>.git`); `git_clone` documented
 *  "Repository URL (HTTPS)" and passed the string straight to git. Same platform,
 *  same parameter name, opposite formats — and a distilling LLM cannot see which
 *  of the two it is writing for.
 *
 *  It can pick the other one. A graph that fed `git_clone` the GitHub API's
 *  `full_name` field — `owner/name` — failed on both legs:
 *
 *    - `new URL(repo)` threw in the credential builder, which returns undefined
 *      on an unparseable ref, so the clone ran UNAUTHENTICATED against a private
 *      repository. Silently: the one warn on that path only covers a resolver
 *      that throws, not a ref that will not parse.
 *    - `git clone owner/name` reads a non-URL as a LOCAL PATH, so
 *      git failed in well under a second with "repository does not exist".
 *
 *  `gitCheckoutPath` already tolerated the bare form, which is exactly why this
 *  survived the previous round of fixes: one of the three consumers coped and the
 *  other two did not, so the checkout path in the result looked right while the
 *  clone that was supposed to fill it had never been reachable. Normalising once,
 *  here, is what stops the three from drifting again — path, credentials and argv
 *  now consume one value in one format.
 *
 *  Two segments of URL-safe characters and nothing else: anything carrying a
 *  scheme, a host, an `@`, or more than one slash is already a real remote and is
 *  passed through untouched. The github.com default matches code_session, which
 *  resolves gitlab only from explicit provider context and treats GitHub as the
 *  fallback. A GitLab repo named the bare way therefore gets a clean auth failure
 *  rather than a wrong review, and its full HTTPS URL keeps working as documented.
 */
const BARE_REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export function normalizeRepoRef(repo: string, defaultHost = 'github.com'): string {
  const trimmed = (repo ?? '').trim();
  if (!BARE_REPO_SLUG_RE.test(trimmed)) return trimmed;
  return `https://${defaultHost}/${trimmed.replace(/\.git$/, '')}.git`;
}

const INVOCATION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asInvocationUuid = (id: string | undefined): string | undefined =>
  id && INVOCATION_UUID_RE.test(id) ? id : undefined;

export type {
  SandboxSession,
  SandboxToolCallInput,
  SandboxToolCallResult,
  SandboxExecutorInterface,
} from './types';
import type { SandboxSession, SandboxToolCallInput, SandboxToolCallResult, SandboxExecutorInterface, GitCredentialResolver } from './types';

export class SandboxExecutor implements SandboxExecutorInterface {
  // In-memory cache for quick lookups — DB is source of truth
  private readonly activeSandboxes = new Map<string, SandboxInstance>();
  // Injected at boot so cleanup() can flush the final partial-minute of
  // instance-alive billing before the Cloud Run service is destroyed.
  private aliveTicker?: { tick: () => Promise<void> };

  private gitCredentials?: GitCredentialResolver;

  constructor(
    private readonly provider: SandboxProvider,
    private readonly stateRepo: SandboxStateRepository,
    private readonly usageRepo: SandboxUsageRepository,
    private readonly auditRepo: SandboxAuditRepository,
    private readonly sanitizer: SandboxOutputSanitizer,
    private readonly rateLimiter: SandboxRateLimiter,
    private readonly creditCostProvider: CreditCostProvider,
    private readonly usageLedger: UsageLedgerService,
    private readonly defaultConfig: Partial<SandboxConfig> = {},
  ) {}

  setAliveTicker(ticker: { tick: () => Promise<void> }): void {
    this.aliveTicker = ticker;
  }

  /** Sandboxes whose skill files have already been written.
   *
   *  Keyed by SANDBOX rather than by session, because that is where the files
   *  actually are: a workspace that is reaped and rebuilt starts empty, and the
   *  entry is dropped at teardown so the replacement gets filled again. */
  private readonly skillFilesMaterialized = new Set<string>();

  /** Make materialized skill files read-only, in one pass per mode.
   *
   *  Best-effort: a chmod that fails leaves the files writable, which is worse
   *  than read-only but far better than failing the tool call that was about to
   *  use them. The failure is logged rather than swallowed. */
  private async protectSkillFiles(
    sandboxId: string,
    materialized: { files: Array<{ absolutePath: string; executable: boolean }> },
  ): Promise<void> {
    const readable = materialized.files.filter((f) => !f.executable).map((f) => f.absolutePath);
    const runnable = materialized.files.filter((f) => f.executable).map((f) => f.absolutePath);

    // Argv, never a shell string: a skill's own file names reach this, and a
    // shell would give a name with a space or a quote in it a second meaning.
    for (const [mode, paths] of [['0444', readable], ['0555', runnable]] as const) {
      if (paths.length === 0) continue;
      try {
        await this.provider.exec(sandboxId, ['chmod', mode, ...paths]);
      } catch (err) {
        log.warn({
          message: 'Could not make skill files read-only; they remain writable for this run',
          sandboxId,
          mode,
          error: (err as Error).message,
        });
      }
    }
  }

  /** Write the files of every skill this agent has that ships any.
   *
   *  Reads the agent's skills rather than the turn's retrieved subset: the
   *  executor is behind the tool gateway and has no view of what retrieval
   *  selected, and the set that ships files is small — most skills are text
   *  only, so the common case reads a handful of rows and writes nothing. */
  private async materializeSkillFilesOnce(
    session: SandboxSession,
    sandboxId: string,
  ): Promise<void> {
    if (this.skillFilesMaterialized.has(sandboxId)) return;
    this.skillFilesMaterialized.add(sandboxId);

    try {
      const { getPool } = await import('../infrastructure/database');
      const result = await getPool().query<{ id: string; bundle: SkillBundle | null }>(
        `SELECT id, bundle FROM agent_skills
          WHERE agent_id = $1::uuid AND tenant_id = $2::uuid
            AND status = 'active' AND bundle IS NOT NULL`,
        [session.agentId, session.tenantId],
      );
      if (result.rows.length === 0) return;

      const { materializeSkillBundle, describeMaterializedFiles } = await import(
        '../skills/bundle-materializer'
      );
      const { fetchSkillBundleFile } = await import('../platform-callback/client');

      for (const row of result.rows) {
        const materialized = await materializeSkillBundle(row.id, row.bundle, {
          fetchContent: (storageRef, sha256) =>
            fetchSkillBundleFile(session.tenantId, storageRef, sha256),
          writeFile: (absolutePath, content) =>
            this.provider.writeFile(sandboxId, absolutePath, content),
        });

        // Read-only once written.
        //
        // A skill's files are the skill, and the run they are materialized for
        // must not be able to edit them: a turn that rewrites its own
        // instructions leaves the next turn reading something nobody authored,
        // and the copy in the control plane — which is authoritative — would
        // still say otherwise. Executables keep their execute bit; nothing
        // keeps a write bit.
        await this.protectSkillFiles(sandboxId, materialized);

        log.info({
          message: 'Skill files materialized into sandbox',
          sandboxId,
          skillId: row.id,
          landed: materialized.files.length,
          failed: materialized.failed.length,
          detail: describeMaterializedFiles(materialized),
        });
      }
    } catch (err) {
      log.warn({
        message: 'Skill file materialization failed; the run continues without those files',
        sandboxId,
        error: (err as Error).message,
      });
    }
  }

  /** Resolve the OAuth token for the version-control connector this session's
   *  agent is bound to. Injected rather than constructed here so the executor
   *  keeps no connector-service knowledge, and so a deployment that has no
   *  resolver simply clones unauthenticated exactly as before. */
  setGitCredentialResolver(resolve: GitCredentialResolver): void {
    this.gitCredentials = resolve;
  }

  /**
   * Execute a sandbox tool call. Called by the tool gateway after
   * HITL enforcement, admission control, and allowlist validation.
   */
  async execute(
    session: SandboxSession,
    call: SandboxToolCallInput,
  ): Promise<SandboxToolCallResult> {
    const sandbox = await this.getOrCreate(session);

    // Someone else is provisioning this session's workspace. Say so and say
    // when to come back, instead of holding the request open: the caller's own
    // deadline is shorter than a provision, so waiting here ends as a gateway
    // timeout — an answer the model cannot act on, for work that then finishes
    // anyway and lands somewhere nobody is looking.
    if (sandbox.status === 'creating') {
      return {
        success: false,
        data: {},
        error: 'The workspace for this run is still starting.',
        errorCode: 'vendor_unavailable',
        retryable: true,
        retryAfterMs: SANDBOX_PROVISION_RETRY_MS,
      };
    }

    // A skill's files have to exist before the agent can run them. This is the
    // first moment a sandbox certainly exists — sandboxes are provisioned on
    // demand, so materializing at run start would mean provisioning one for
    // every run, including the majority that never touch it.
    //
    // Once per session, and never able to fail the tool call it precedes: a
    // skill whose files did not land is a skill missing its scripts, which the
    // agent discovers as a missing file. Failing the call instead would take
    // down a tool that had nothing to do with the skill.
    await this.materializeSkillFilesOnce(session, sandbox.sandboxId);

    const startMs = Date.now();

    // Keep the sandbox's event routing context aligned with this invocation so
    // any events the sidecar emits during the call carry the right threadId.
    // Fire-and-forget — failure here must not block the tool call.
    const providerWithRouting = this.provider as unknown as { setRoutingContext?: (id: string, ctx: { threadId?: string; invocationId?: string }) => Promise<void> };
    if (typeof providerWithRouting.setRoutingContext === 'function') {
      providerWithRouting.setRoutingContext(sandbox.sandboxId, { threadId: session.threadId, invocationId: session.invocationId }).catch(() => undefined);
    }

    // Audit every tool call (Resolved: SE-012)
    const auditRecord = {
      tenantId: session.tenantId,
      agentId: session.agentId,
      invocationId: session.invocationId,
      sandboxId: sandbox.sandboxId,
      toolName: call.toolName,
      commandArgs: null as string[] | null,
      workDir: null as string | null,
      exitCode: null as number | null,
      stdoutPreview: null as string | null,
      stderrPreview: null as string | null,
      wallClockMs: 0,
    };

    // Snapshot the workspace before this turn first changes it.
    //
    // Here rather than in the agent layer because this is the only place that
    // sees EVERY mutation: a file write, a shell command, a session exec and a
    // clone all converge on this switch, and a checkpoint that missed one of
    // them would be a restore point that quietly does not restore.
    //
    // Awaited, not fire-and-forget: a snapshot racing the write it is meant to
    // precede would capture the state after. It runs once per turn, so this is
    // one cost at the start of a turn, not a cost per tool call. A failure
    // returns null and the tool call proceeds — insurance must never be able to
    // fail the thing it insures.
    if (isMutatingTool(call.toolName)) {
      await snapshotOnce({
        provider: this.provider,
        sandboxId: sandbox.sandboxId,
        invocationId: session.invocationId,
      });
    }

    // Fingerprint the workspace around mutations the verify gate CANNOT observe
    // any other way.
    //
    // Its change detection recognises tool names and scrapes shell commands, so
    // `file_write` and `sed -i` are already reported with the path they touched
    // and need nothing here. What it cannot see is `curl -o`, `git apply`,
    // `npx prettier --write`, `git_clone`, `git_commit_and_push`,
    // `nodejs_execute` and a non-bash `code_execute` — and an agent doing
    // ordinary fetch-transform-write work reports an empty changedPaths however
    // many files it wrote.
    //
    // Narrowed to those on purpose. A reading costs two sandbox execs, and
    // taking one around every mutating call would put that on the hot path of a
    // run that writes fifty files through tools we can already account for.
    const needsFingerprint = mutationIsUnobservable(call.toolName, call.input);
    if (needsFingerprint) {
      recordWorkspaceFingerprint(
        session.invocationId,
        await workspaceTreeHash(this.provider, sandbox.sandboxId).catch(() => undefined),
      );
    }

    try {
      let result: SandboxToolCallResult;

      switch (call.toolName) {
        case 'shell_exec': {
          // Resolved: SE-014 — rate limit exec calls
          const rateCheck = this.rateLimiter.checkExecAllowed(sandbox.sandboxId);
          if (!rateCheck.allowed) {
            return { success: false, data: {}, error: rateCheck.reason };
          }

          const args = call.input.args as string[];
          const workDir = validateWorkspacePath(call.input.workDir as string | undefined);
          const timeout = Math.min((call.input.timeout as number) ?? 60_000, 300_000);

          auditRecord.commandArgs = args;
          auditRecord.workDir = workDir;

          const execResult = await this.provider.exec(sandbox.sandboxId, args, { workDir, timeout });
          const sanitized = this.sanitizer.sanitize(execResult.stdout, execResult.stderr);

          auditRecord.exitCode = execResult.exitCode;
          auditRecord.stdoutPreview = sanitized.stdout;
          auditRecord.stderrPreview = sanitized.stderr;

          result = {
            success: execResult.exitCode === 0,
            data: {
              stdout: sanitized.stdout,
              stderr: sanitized.stderr,
              exitCode: execResult.exitCode,
            },
          };
          break;
        }

        case 'file_read': {
          const readPath = validateWorkspacePath(call.input.path as string);
          const whole = await this.provider.readFile(sandbox.sandboxId, readPath);

          // Sliceable, because without this the platform's own advice is
          // impossible to follow.
          //
          // A value gets parked in the workspace precisely BECAUSE it was too
          // large for the conversation, and the note attached to it says "call
          // file_read with that path". file_read then returned the whole thing
          // — still too large — so the SDK spilled it to a file of its own and
          // told the model to slice it by character range with a shell. That
          // shell is `code_execute`, categorised destructive, so on a run that
          // has read any external content the taint gate stops it and asks a
          // human to approve reading a file this platform wrote, one step
          // earlier, in the same run.
          //
          // Character offsets rather than lines: the parked values are
          // single-line JSON, which is exactly the shape line-based chunking
          // cannot help with.
          const slice = sliceForRead(whole, call.input.offset, call.input.limit);

          result = {
            success: true,
            data: {
              // `asInvocationUuid`, not the raw handle: the screen's audit row
              // lands in audit_logs, whose invocation_id is a uuid with an FK,
              // and session.invocationId is a sandbox-domain handle that is
              // sometimes a composite `sandbox:<id>:<tool>:<seq>` string. A
              // non-uuid there would make every finding's audit write fail
              // silently. Where it is not a real invocation the screen simply
              // runs undeduplicated, which is the stated fallback.
              content: frameUntrusted(`file:${readPath}`, slice.text, undefined, { tenantId: session.tenantId, agentId: session.agentId, invocationId: asInvocationUuid(session.invocationId) }) + slice.note,
              offset: slice.offset,
              returned: slice.returned,
              totalChars: slice.totalChars,
              hasMore: slice.hasMore,
            },
          };
          break;
        }

        case 'file_write': {
          const writePath = validateWorkspacePath(call.input.path as string);
          await this.provider.writeFile(sandbox.sandboxId, writePath, call.input.content as string);
          result = { success: true, data: { path: writePath } };
          break;
        }

        case 'file_edit': {
          const editPath = validateWorkspacePath(call.input.path as string);
          const current = await this.provider.readFile(sandbox.sandboxId, editPath);
          const oldText = call.input.oldText as string;
          const newText = call.input.newText as string;

          if (!current.includes(oldText)) {
            return { success: false, data: {}, error: `Text not found in file: ${editPath}` };
          }

          const edited = current.replace(oldText, newText);
          await this.provider.writeFile(sandbox.sandboxId, editPath, edited);
          result = { success: true, data: { path: editPath } };
          break;
        }

        case 'file_search': {
          const searchPath = validateWorkspacePath(call.input.path as string | undefined);
          const pattern = call.input.pattern as string;
          // Use provider.exec with args array (consistent with security model — no shell string)
          const findArgs = ['find', searchPath, '-name', pattern, '-type', 'f', '-maxdepth', '10'];
          const findResult = await this.provider.exec(sandbox.sandboxId, findArgs, { timeout: 30_000 });
          const findSanitized = this.sanitizer.sanitize(findResult.stdout, findResult.stderr);
          result = { success: true, data: { files: findSanitized.stdout.trim().split('\n').filter(Boolean) } };
          break;
        }

        case 'content_search': {
          const searchRoot = validateWorkspacePath(call.input.path as string | undefined);
          const globFilter = (call.input.glob as string) ?? '*';
          const searchPattern = call.input.pattern as string;
          // Use provider.exec with args array (consistent with security model — no shell string)
          const grepArgs = ['grep', '-r', '--include', globFilter, '-n', '-l', searchPattern, searchRoot];
          const grepResult = await this.provider.exec(sandbox.sandboxId, grepArgs, { timeout: 30_000 });
          const grepSanitized = this.sanitizer.sanitize(grepResult.stdout, grepResult.stderr);
          result = { success: true, data: { matches: grepSanitized.stdout } };
          break;
        }

        case 'git_clone': {
          // Normalise FIRST, so the checkout path, the credential lookup and the
          // argv all read the same value. They used to derive independently from
          // the raw input and disagreed about a bare `owner/name`.
          const rawRepo = call.input.repo as string;
          const repo = normalizeRepoRef(rawRepo);
          if (repo !== rawRepo?.trim()) {
            // Worth a line: this is the shape the distiller actually emits, and
            // the previous version of this failure was invisible precisely
            // because nothing recorded that the ref had not parsed.
            log.info({
              message: 'git_clone: normalized a bare owner/name to an HTTPS remote',
              rawRepo,
              repo,
              sessionId: session.sessionId,
            });
          }

          // A path per repository, returned to the caller, and idempotent.
          //
          // It used to clone into a single hardcoded `/workspace/repo` and return
          // only stdout/stderr/exitCode — so nothing downstream could learn where
          // the checkout was. A distilled graph guessed: an agent's next
          // step ran `git fetch` with `workDir: {{steps.s2.repo}}`, the bare repo
          // NAME, against a checkout that was actually at /workspace/repo. It had
          // no way to know better, because the tool never said.
          //
          // One fixed slot is also now actively unsafe. Workspaces are keyed per
          // AGENT rather than per invocation, so a sandbox survives between ticks
          // — and `git clone` into a non-empty directory fails outright. Two
          // repositories through one slot is either a hard failure or, worse, a
          // review of the wrong code. Per-repo paths remove the collision, and
          // re-running against an existing checkout FETCHES instead, which is what
          // the agent's own instructions have been promising all along ("if a
          // clone of this repository already exists from an earlier follow-up run,
          // fetch instead of re-cloning") and what makes self-continuation resume
          // rather than restart.
          const checkoutPath = gitCheckoutPath(repo);

          // Authenticated, because a bare `git clone` of a PRIVATE repository is
          // an immediate auth failure and every repository this is pointed at is
          // private. It ran unauthenticated from the day it was written: the
          // sandbox is built with `credentials: []`, nothing else supplied a
          // token, and the failure was fast enough (about a second) to look like
          // anything but what it was. code_session has cloned WITH a token the
          // whole time (adapter/tools/code-session), so the platform had two
          // clone implementations and only one of them could reach a repo.
          //
          // The token goes in the ENVIRONMENT and nowhere else. Not the URL,
          // which `git` echoes back on failure and which the sanitizer would
          // then have to catch; not argv, which this method records to
          // sandbox_audit_log; not the payload, which is audited too.
          // GIT_CONFIG_COUNT/KEY/VALUE (git >= 2.31) installs a credential
          // helper for exactly one host, reading the secret from a second env
          // var, so the token appears in no command line and no log line.
          const gitEnv = await this.buildGitCredentialEnv(session, repo);
          const execOpts = { timeout: 120_000, ...(gitEnv ? { env: gitEnv } : {}) };

          // Is it already here? `git -C <path> rev-parse --git-dir` answers for a
          // real checkout and fails for an empty or absent directory, which is
          // the distinction that matters — a leftover directory that is not a
          // repository must not be fetched into.
          const probe = await this.provider.exec(
            sandbox.sandboxId, ['git', '-C', checkoutPath, 'rev-parse', '--git-dir'], execOpts,
          );
          const alreadyCloned = probe.exitCode === 0;

          const args = alreadyCloned
            ? ['git', '-C', checkoutPath, 'fetch', '--all', '--prune']
            : (() => {
              const a = ['git', 'clone'];
              if (call.input.branch) a.push('--branch', call.input.branch as string);
              if (call.input.depth) a.push('--depth', String(call.input.depth));
              a.push(repo, checkoutPath);
              return a;
            })();

          const execResult = await this.provider.exec(sandbox.sandboxId, args, execOpts);
          const sanitized = this.sanitizer.sanitize(execResult.stdout, execResult.stderr);
          result = {
            success: execResult.exitCode === 0,
            data: {
              // `path` first because it is the field every downstream step needs
              // and the one whose absence caused the guess.
              path: checkoutPath,
              action: alreadyCloned ? 'fetched' : 'cloned',
              stdout: sanitized.stdout,
              stderr: sanitized.stderr,
              exitCode: execResult.exitCode,
            },
          };
          break;
        }

        case 'git_commit_and_push': {
          // Resolved: SE-001 — parameterized execution, explicit file staging
          const files = call.input.files as string[];
          const message = call.input.message as string;
          const branch = call.input.branch as string;

          validateBranchName(branch);
          validateCommitMessage(message);

          // Resolved: SE-009 — filter secret files
          const { safe, rejected } = filterSecretFiles(files);
          if (rejected.length > 0) {
            log.warn({
              message: 'Rejected secret files from git staging',
              rejected,
              sandboxId: sandbox.sandboxId,
            });
          }
          if (safe.length === 0) {
            return { success: false, data: {}, error: 'No files to stage after filtering secrets' };
          }

          // Stage files individually (NOT git add -A)
          await this.provider.exec(sandbox.sandboxId, ['git', 'add', '--', ...safe], { workDir: '/workspace/repo' });
          // Commit with parameterized message (NOT shell string interpolation)
          await this.provider.exec(sandbox.sandboxId, ['git', 'commit', '-m', message], { workDir: '/workspace/repo' });
          // Push to branch
          const pushResult = await this.provider.exec(
            sandbox.sandboxId,
            ['git', 'push', 'origin', branch],
            { workDir: '/workspace/repo' },
          );
          const sanitized = this.sanitizer.sanitize(pushResult.stdout, pushResult.stderr);

          auditRecord.commandArgs = ['git', 'push', 'origin', branch];
          auditRecord.exitCode = pushResult.exitCode;

          result = {
            success: pushResult.exitCode === 0,
            data: {
              branch,
              filesStaged: safe,
              filesRejected: rejected,
              stdout: sanitized.stdout,
              stderr: sanitized.stderr,
            },
          };
          break;
        }

        default: {
          // Dispatcher routing — Phase 2-5 parity tools live in modular dispatchers.
          const { findDispatcher } = await import('./dispatchers');
          const { isToolEnabledForCurrentPhase, phaseForTool, currentParityPhase, isTenantAllowed } = await import('./parity-phase');

          if (!isTenantAllowed(session.tenantId)) {
            return { success: false, data: {}, error: 'sandbox_parity_tenant_not_allowed' };
          }
          if (!isToolEnabledForCurrentPhase(call.toolName)) {
            return {
              success: false,
              data: {},
              error: `phase_not_enabled (tool requires phase ${phaseForTool(call.toolName)}, current is ${currentParityPhase()})`,
            };
          }

          const dispatcher = findDispatcher(call.toolName);
          if (!dispatcher) {
            return { success: false, data: {}, error: `Unknown sandbox tool: ${call.toolName}` };
          }
          const dispatchResult = await dispatcher.handle(
            {
              toolName: call.toolName,
              input: call.input as Record<string, unknown>,
              sandboxId: sandbox.sandboxId,
              tenantId: session.tenantId,
              agentId: session.agentId,
              invocationId: session.invocationId,
            },
            { provider: this.provider as unknown as import('./types').SandboxProviderV2 },
          );
          result = { success: dispatchResult.success, data: (dispatchResult.data ?? {}) as Record<string, unknown>, error: dispatchResult.error };
          break;
        }
      }

      const wallClockMs = Date.now() - startMs;
      auditRecord.wallClockMs = wallClockMs;

      // Record audit (fire-and-forget, never blocks execution)
      this.auditRepo.logToolCall(auditRecord);

      // Record usage and credit cost
      await this.recordUsage(session, sandbox, call.toolName, wallClockMs, auditRecord.exitCode, call.id);

      // The other half of the reading above: what the workspace looks like now
      // that the unobservable mutation has run.
      if (needsFingerprint) {
        recordWorkspaceFingerprint(
          session.invocationId,
          await workspaceTreeHash(this.provider, sandbox.sandboxId).catch(() => undefined),
        );
      }

      // Update heartbeat
      await this.stateRepo.heartbeat(sandbox.sandboxId);

      // Tell the agent, once, that this is not the workspace it had. Attached
      // to the first call rather than raised as an error: the call itself
      // succeeded, and a fresh workspace is usable — what would be wrong is
      // letting it infer from an empty directory that its earlier work simply
      // never happened.
      if (sandbox.workspaceReset) {
        sandbox.workspaceReset = false;
        // Name the files when the previous run left a manifest. "Any files
        // written before the pause" is a category, and an agent that wrote
        // twelve files has to re-derive which of them mattered. The generic
        // text stays as the fallback, so a missing manifest degrades to today's
        // behaviour rather than to silence.
        result.notice = buildWorkspaceResetNotice(
          loadWorkspaceManifest(session.sessionId),
          GENERIC_WORKSPACE_RESET_NOTICE,
        );
      }

      return result;
    } catch (err) {
      const wallClockMs = Date.now() - startMs;
      auditRecord.wallClockMs = wallClockMs;
      auditRecord.stderrPreview = (err as Error).message;
      this.auditRepo.logToolCall(auditRecord);

      log.error({
        message: 'Sandbox tool call failed',
        toolName: call.toolName,
        sandboxId: sandbox.sandboxId,
        error: (err as Error).message,
      });

      return {
        success: false,
        data: {},
        error: `Sandbox execution failed: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Get or create a sandbox for the given session.
   * Resolved: TE-001 — TOCTOU protection via DB-level upsert.
   */
  /**
   * The rollback verbs.
   *
   * Operator surface, deliberately not tools. A model that can see its own
   * checkpoints starts reasoning about them, and "roll back and try again" is a
   * loop rather than a recovery — it will burn a whole run rediscovering the
   * same failure from the same starting state. The snapshots are invisible to
   * it; only a person, or the platform acting for one, can go back.
   *
   * Neither verb creates a sandbox. A checkpoint only exists inside a live
   * workspace, so there is nothing to list or restore for a session whose
   * sandbox has gone, and spinning one up to answer would be worse than saying
   * so.
   */
  async listWorkspaceCheckpoints(session: SandboxSession): Promise<Checkpoint[]> {
    const sandboxId = await this.liveSandboxId(session);
    if (!sandboxId) return [];
    return listCheckpoints(this.provider, sandboxId);
  }

  async restoreWorkspaceCheckpoint(
    session: SandboxSession,
    checkpointId: string,
  ): Promise<{ restored: boolean; safetyCheckpoint: string | null; error?: string }> {
    const sandboxId = await this.liveSandboxId(session);
    if (!sandboxId) {
      return { restored: false, safetyCheckpoint: null, error: 'no live sandbox for this session' };
    }
    return restoreCheckpoint({
      provider: this.provider,
      sandboxId,
      checkpointId,
      invocationId: session.invocationId,
    });
  }

  /** The sandbox backing this session, or null when it has none. Read-only:
   *  unlike getOrCreate, this never provisions. */
  private async liveSandboxId(session: SandboxSession): Promise<string | null> {
    const cached = this.activeSandboxes.get(session.sessionId);
    if (cached && cached.status !== 'destroyed' && cached.status !== 'error') return cached.sandboxId;
    const existing = await this.stateRepo.getBySession(session.sessionId);
    if (!existing || existing.status === 'destroyed' || existing.status === 'error') return null;
    return existing.sandboxId;
  }

  /** Env that authenticates git for ONE host, or undefined to clone as before.
   *
   *  `GIT_CONFIG_COUNT`/`_KEY_n`/`_VALUE_n` is git's own way to set config from
   *  the environment (>= 2.31). The helper is scoped to the specific host so a
   *  clone of anything else cannot pick the credential up, and the secret itself
   *  is read by the helper from a separate variable rather than being part of
   *  the config value — so it never appears in a command line, a config file, or
   *  a git error message.
   *
   *  The username is provider-specific and matches what code-session already
   *  uses: GitHub authenticates a token as `x-access-token`, GitLab as `oauth2`.
   */
  private async buildGitCredentialEnv(
    session: SandboxSession,
    repo: string,
  ): Promise<Record<string, string> | undefined> {
    if (!this.gitCredentials) return undefined;

    const host = (() => {
      try {
        return new URL(repo).host.toLowerCase();
      } catch {
        return '';
      }
    })();
    if (!host) {
      // Callers normalize before reaching here, so an unparseable ref now means
      // a genuinely odd remote (scp-style, a local path) rather than the routine
      // `owner/name` case. Say so. The bare-slug version of this returned
      // undefined in silence, and an unauthenticated clone of a private repo is
      // indistinguishable from a missing binding in every log we keep.
      log.warn({
        message: 'git credential lookup skipped: no host in repo ref; cloning unauthenticated',
        repo,
        sessionId: session.sessionId,
      });
      return undefined;
    }

    let token: string | undefined;
    try {
      token = await this.gitCredentials({
        tenantId: session.tenantId,
        agentId: session.agentId,
        host,
      });
    } catch (err) {
      // Clone unauthenticated rather than failing the call: a public repository
      // still works, and the git error for a private one says more about what is
      // wrong than a credential-lookup stack trace would.
      log.warn({
        message: 'git credential lookup failed; cloning unauthenticated',
        host,
        sessionId: session.sessionId,
        error: (err as Error).message,
      });
      return undefined;
    }
    if (!token) return undefined;

    const user = host.includes('gitlab') ? 'oauth2' : 'x-access-token';
    return {
      GIT_TERMINAL_PROMPT: '0',
      LIFTOFF_GIT_TOKEN: token,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `credential.https://${host}.helper`,
      GIT_CONFIG_VALUE_0:
        `!f() { echo username=${user}; echo "password=$LIFTOFF_GIT_TOKEN"; }; f`,
    };
  }

  private async getOrCreate(session: SandboxSession): Promise<SandboxInstance> {
    // Check in-memory cache first
    const cached = this.activeSandboxes.get(session.sessionId);
    if (cached && cached.status !== 'destroyed' && cached.status !== 'error') {
      return cached;
    }

    // Check DB (source of truth)
    const existing = await this.stateRepo.getBySession(session.sessionId);
    if (existing) {
      const instance: SandboxInstance = {
        sandboxId: existing.sandboxId,
        status: existing.status,
        workDir: '/workspace',
        createdAt: existing.createdAt,
        lastHeartbeatAt: existing.lastHeartbeat,
      };
      this.activeSandboxes.set(session.sessionId, instance);
      return instance;
    }

    // Check rate limits before creating
    const rateCheck = await this.rateLimiter.checkCreationAllowed(session.tenantId, session.agentId);
    if (!rateCheck.allowed) {
      throw new Error(`Sandbox creation denied: ${rateCheck.reason}`);
    }

    // NO EGRESS POLICY IS APPLIED HERE, BECAUSE NONE IS APPLIED ANYWHERE.
    //
    // `egressPolicy` / `allowedDomains` / `validateEgressConfig` used to be
    // resolved and validated at this point. The whole surface was inert: the
    // policy travelled to the container as EGRESS_POLICY_DEFAULT, the sidecar
    // parsed it into `config.egressPolicyDefault`, and NOTHING read that field —
    // zero references. `block` blocked nothing and `allow-list` restricted
    // nothing.
    //
    // Deleted rather than documented: a control that does not control is false
    // assurance, and the next person to reach for it would believe they had
    // restricted a sandbox. The same goes for a metadata-blocking firewall: VPC
    // egress firewalls cannot block Cloud Run's link-local metadata server, so
    // such a rule is removed rather than kept. Same principle, same conclusion.
    //
    // The sandbox IS unrestricted on the network, deliberately: the provider
    // puts it on the tenant VPC with ALL_TRAFFIC so agent code keeps internet
    // access and the sidecar can call back to the internal-ingress runtime. The
    // isolation that matters is elsewhere and is real — a per-tenant GCP project
    // and VPC, and a `sandbox-runtime` service account holding ZERO project
    // roles, so the OAuth token agent code can mint from the metadata server is
    // useless by design (terraform sandbox_runtime_sa.tf).
    //
    // Restoring a policy here means building an enforcement point first. See
    // docs/design/sandbox-governance.md in platform-backend.

    // Create new sandbox
    const config: SandboxConfig = {
      // The session's own template wins, so one caller can ask for a different
      // image without changing what every other sandbox runs. `code_session` is
      // the only one that does, and it runs under its own sessionId so the
      // choice cannot leak into the agent's shared sandbox.
      template: (session.template
        ?? this.defaultConfig.template
        ?? 'aio-sandbox') as ExecutionEnvironmentType,
      resourceLimits: this.defaultConfig.resourceLimits ?? {
        cpuMillis: 4_000,
        memoryMb: 8192,
        timeoutMs: 600_000,
        maxOutputBytes: 100_000,
      },
      credentials: this.defaultConfig.credentials ?? [],
      timeoutMs: this.defaultConfig.timeoutMs ?? 600_000,
      costCeilingCredits: this.defaultConfig.costCeilingCredits ?? 500,
      // Bake THIS session's identity into the sandbox container so the sidecar's
      // callback JWTs carry the real agent (not the sandbox-executor's shared,
      // placeholder process.env). Without this, connector dispatch from sandbox
      // code resolves the wrong/no agent → buildToolsForAgent returns nothing.
      tenantId: session.tenantId,
      agentId: session.agentId,
      instructionVersion: session.instructionVersion,
    };

    log.info({
      message: 'Creating sandbox',
      sessionId: session.sessionId,
      tenantId: session.tenantId,
      template: config.template,
    });

    // Did this session already have a workspace that has since been reaped?
    // Asked BEFORE the claim, while the only rows for this session are the old
    // ones. A run that paused for a human stops touching its sandbox, so the
    // heartbeat lapses and the sweep destroys it; when the human answers, the
    // run resumes into a directory that is empty for a reason nobody told it.
    // try/catch rather than `.catch()`: this is best-effort, and a `.catch()`
    // only covers a rejected promise, not a call that throws before returning
    // one.
    let workspaceReset = false;
    try {
      workspaceReset = await this.stateRepo.hadDestroyedSandbox(session.sessionId);
    } catch (err) {
      log.warn({
        message: 'workspace-reset lookup failed; provisioning without the notice',
        sessionId: session.sessionId,
        error: (err as Error).message,
      });
    }

    // Claim the session BEFORE provisioning. The id is minted here rather than
    // inside the provider so the intent can be recorded first: provisioning
    // takes about a minute, and until the row exists that minute is invisible
    // to everyone else.
    const sandboxId = `sandbox-${uuid().slice(0, 8)}`;
    const claimed = await this.stateRepo.claimProvisioning({
      sandboxId,
      sessionId: session.sessionId,
      tenantId: session.tenantId,
      agentId: session.agentId,
      invocationId: session.invocationId,
      template: config.template,
      capabilities: (this.defaultConfig as { capabilities?: SandboxCapability[] }).capabilities,
    });

    if (!claimed) {
      // A concurrent caller is already provisioning this session. Return THEIR
      // row; execute() turns a 'creating' status into a retryable answer rather
      // than a second Cloud Run service and a second provision charge.
      const winner = await this.stateRepo.getBySession(session.sessionId);
      if (!winner) {
        throw new Error(
          `Sandbox claim for session ${session.sessionId} was taken but the winning row is gone; retry.`,
        );
      }
      const instance: SandboxInstance = {
        sandboxId: winner.sandboxId,
        status: winner.status,
        workDir: '/workspace',
        createdAt: winner.createdAt,
        lastHeartbeatAt: winner.lastHeartbeat,
      };
      this.activeSandboxes.set(session.sessionId, instance);
      return instance;
    }

    // Provisioning runs to completion regardless of who is still waiting for
    // it. The caller in front of us gives up long before a cold sandbox is
    // ready, and a request held past that ceiling returns a gateway timeout
    // while this work carries on anyway — leaving the requester told it failed
    // and the workspace very much alive. So: start it, wait a bounded while,
    // and answer honestly if it is not ready yet.
    const provisioning = this.provisionAndFinalize(session, config, sandboxId, workspaceReset);
    // The detached path must never surface as an unhandled rejection; the
    // failure is already recorded by markProvisionFailed inside.
    provisioning.catch(() => undefined);

    type RaceOutcome =
      | { kind: 'ready'; instance: SandboxInstance }
      | { kind: 'failed'; error: unknown }
      | { kind: 'pending' };

    const readyOrNot = await Promise.race<RaceOutcome>([
      provisioning.then(
        instance => ({ kind: 'ready', instance } as const),
        error => ({ kind: 'failed', error } as const),
      ),
      new Promise<RaceOutcome>(resolve =>
        setTimeout(() => resolve({ kind: 'pending' }), SANDBOX_PROVISION_WAIT_MS).unref?.()),
    ]);

    if (readyOrNot.kind !== 'ready') {
      if (readyOrNot.kind === 'failed') {
        // Rethrow the provider's own error. Replacing it with a generic one
        // would cost the caller the only description of what went wrong.
        throw readyOrNot.error;
      }
      // Still coming. execute() turns a 'creating' status into the retryable
      // answer, and the row is already claimed so nobody provisions a second.
      log.info({
        message: 'Sandbox still provisioning past the in-request wait; answering retryable',
        event: 'sandbox_provision_still_pending',
        sandboxId,
        sessionId: session.sessionId,
        waitedMs: SANDBOX_PROVISION_WAIT_MS,
      });
      return {
        sandboxId,
        status: 'creating',
        workDir: '/workspace',
        createdAt: new Date(),
        lastHeartbeatAt: new Date(),
      };
    }
    return readyOrNot.instance;
  }

  /** Provision, then do everything that must happen exactly once for a new
   *  sandbox. Runs to completion even when the caller has stopped waiting. */
  private async provisionAndFinalize(
    session: SandboxSession,
    config: SandboxConfig,
    sandboxId: string,
    workspaceReset: boolean,
  ): Promise<SandboxInstance> {
    let instance: SandboxInstance;
    try {
      instance = await this.provider.create(config, sandboxId);
    } catch (err) {
      // Release the claim. Without this the session keeps a 'creating' row the
      // index treats as live, and every later attempt is told to retry against
      // a provision that already died.
      await this.stateRepo.markProvisionFailed(sandboxId).catch(markErr => log.error({
        message: 'Failed to release sandbox provisioning claim',
        sandboxId,
        error: (markErr as Error).message,
      }));
      throw err;
    }

    // Capture per-sandbox JWT envelope ciphertext (if the provider returned one)
    // so audit-trace / runtime restart can recover it.
    let jwtSecretEncrypted: Buffer | undefined;
    const providerWithSecret = this.provider as unknown as { getEncryptedSecret?: (sandboxId: string) => Buffer | null };
    if (typeof providerWithSecret.getEncryptedSecret === 'function') {
      jwtSecretEncrypted = providerWithSecret.getEncryptedSecret(instance.sandboxId) ?? undefined;
    }

    // The claim row becomes the ready row. `ready_at` is stamped here, so
    // `ready_at - created_at` spans the actual provision.
    await this.stateRepo.markProvisioned(instance.sandboxId, {
      jwtSecretEncrypted,
      imageTag: (this.defaultConfig as { imageTag?: string }).imageTag,
    });

    // Record provision cost. Two sinks must stay in sync:
    //   - usageRepo (sandbox_usage_log) — per-sandbox cost report column
    //     `sandbox_cost_credits` rolls these up at write time.
    //   - usageLedger (usage_events) — drains the OU bucket via the
    //     spend-subscriber. Without this, every provision burns ~30 cr =
    //     $0.03 of Cloud Run cold-start the tenant never paid for.
    //     ~88 % of single-shot dispatch cost on the inner side.
    const provisionCredits = await calculateSandboxCredits(
      'provision', 0, this.creditCostProvider, session.tenantId,
    );
    await this.usageRepo.recordUsage({
      tenantId: session.tenantId,
      invocationId: session.invocationId,
      agentId: session.agentId,
      sandboxId: instance.sandboxId,
      phase: 'provision',
      toolName: null,
      cpuMillis: 0,
      memoryMbSeconds: 0,
      egressBytes: 0,
      wallClockMs: 0,
      creditsConsumed: provisionCredits,
      template: config.template,
      exitCode: null,
      idempotencyKey: `${session.invocationId}:${instance.sandboxId}:provision`,
    });
    await this.usageLedger.recordUsage({
      tenantId: session.tenantId,
      agentId: session.agentId,
      workflowId: null,
      actionId: uuid(),
      eventType: 'sandbox_provision',
      credits: provisionCredits,
      metadata: {
        sandboxId: instance.sandboxId,
        template: config.template,
        actionRef: `sandbox:${instance.sandboxId}:provision`,
      },
    });

    if (workspaceReset) {
      instance.workspaceReset = true;
      log.warn({
        message: 'Workspace was reset — this session had a sandbox that was reaped',
        event: 'sandbox_workspace_reset',
        sessionId: session.sessionId,
        sandboxId: instance.sandboxId,
        tenantId: session.tenantId,
        agentId: session.agentId,
      });
    }
    this.activeSandboxes.set(session.sessionId, instance);

    // Process initRepos if configured (clone repositories into sandbox at startup)
    if (this.defaultConfig.initCommands && this.defaultConfig.initCommands.length > 0) {
      for (const cmdArgs of this.defaultConfig.initCommands) {
        try {
          await this.provider.exec(instance.sandboxId, cmdArgs, { timeout: 120_000 });
        } catch (err) {
          log.warn({
            message: 'Init command failed',
            sandboxId: instance.sandboxId,
            command: cmdArgs[0],
            error: (err as Error).message,
          });
        }
      }
    }

    log.info({
      message: 'Sandbox created',
      sandboxId: instance.sandboxId,
      sessionId: session.sessionId,
    });

    return instance;
  }

  /**
   * Record sandbox usage, deduct credits from burn_state, and emit audit log.
   */
  private async recordUsage(
    session: SandboxSession,
    sandbox: SandboxInstance,
    toolName: string,
    wallClockMs: number,
    exitCode: number | null,
    callId: string | undefined,
  ): Promise<void> {
    const credits = await calculateSandboxCredits(
      'execute', wallClockMs, this.creditCostProvider, session.tenantId,
    );

    // Use the caller-supplied call id when present so retries collapse to a
    // single row; fall back to a fresh uuid for callers that don't supply one.
    const callKey = callId ?? uuid();

    // Record in sandbox_usage_log + increment invocations.sandbox_cost_credits
    await this.usageRepo.recordUsage({
      tenantId: session.tenantId,
      invocationId: session.invocationId,
      agentId: session.agentId,
      sandboxId: sandbox.sandboxId,
      phase: 'execute',
      toolName,
      cpuMillis: wallClockMs,
      memoryMbSeconds: 0,
      egressBytes: 0,
      wallClockMs,
      creditsConsumed: credits,
      template: (this.defaultConfig.template ?? 'general-shell') as ExecutionEnvironmentType,
      exitCode,
      idempotencyKey: `${session.invocationId}:${sandbox.sandboxId}:exec:${callKey}`,
    });

    // Deduct credits from burn_state (so mid-session exhaustion blocks next tool call).
    // actionId is usage_events.action_id (UUID); the stringy sandbox:<id>:<tool>:<callKey>
    // tracing handle moves into metadata so it stays queryable without breaking the
    // UUID column type. Mirrors the randomUUID() pattern every other recordUsage
    // caller in standard-tool-handler.ts uses.
    await this.usageLedger.recordUsage({
      tenantId: session.tenantId,
      agentId: session.agentId,
      workflowId: null,
      actionId: uuid(),
      eventType: 'sandbox_exec',
      credits,
      metadata: {
        sandboxId: sandbox.sandboxId,
        toolName,
        wallClockMs,
        actionRef: `sandbox:${sandbox.sandboxId}:${toolName}:${callKey.slice(0, 8)}`,
      },
    });

    await insertAuditLog(null, session.tenantId, {
      internalAgentId: session.agentId,
      invocationId: asInvocationUuid(session.invocationId),
      action: `sandbox:${toolName}`,
      inputArgs: { sandboxId: sandbox.sandboxId, toolName },
      outcome: exitCode === 0 || exitCode === null ? 'success' : 'error',
      triggeredBy: `agent:${session.agentId}`,
      durationMs: wallClockMs,
      idempotencyKey: `${session.invocationId}:${sandbox.sandboxId}:exec:${callKey}`,
    });
  }

  /**
   * Destroy a sandbox and record teardown cost.
   * Idempotent — safe to call multiple times.
   * Resolved: TE-009 — destroy failure path defined.
   */
  async cleanup(session: SandboxSession): Promise<void> {
    const sandbox = this.activeSandboxes.get(session.sessionId);
    const stateRecord = sandbox
      ? await this.stateRepo.getBySandboxId(sandbox.sandboxId)
      : await this.stateRepo.getBySession(session.sessionId);

    if (!stateRecord || stateRecord.status === 'destroyed') return;

    const sandboxId = stateRecord.sandboxId;

    // Flush the final partial-minute of instance-alive billing BEFORE marking
    // the sandbox destroyed. The ticker fires every 60s; without this, the
    // tail seconds between the last tick and teardown would be lost.
    try {
      const aliveTicker = (this as unknown as { aliveTicker?: { tick: () => Promise<void> } }).aliveTicker;
      if (aliveTicker) await aliveTicker.tick();
    } catch (err) {
      log.warn({ message: 'instance-alive flush before teardown failed', sandboxId, error: (err as Error).message });
    }

    // Capture what the workspace held BEFORE it is destroyed. This is the only
    // moment it can be done: after `destroy` there is nothing left to list, and
    // the next run on this session is exactly the one that needs to be told what
    // it lost. Awaited rather than fire-and-forget for the same reason — the
    // filesystem is about to go.
    await captureWorkspaceManifest({
      provider: this.provider,
      sandboxId,
      sessionId: session.sessionId,
    }).catch(() => null);

    try {
      await this.stateRepo.updateStatus(sandboxId, 'destroying');
      await this.provider.destroy(sandboxId);
    } catch (err) {
      log.warn({
        message: 'Sandbox destroy failed, marking for GC',
        sandboxId,
        error: (err as Error).message,
      });
      // Mark as error so GC sweep can retry later
      await this.stateRepo.updateStatus(sandboxId, 'error');
    }

    // The checkpoint store died with the sandbox, so the in-memory
    // "already snapshotted this turn" marks for it are now claims about a
    // filesystem that no longer exists. Left behind, a recycled sandbox id
    // would skip its first snapshot.
    clearCheckpointState(sandboxId);

    // Mark destroyed even if provider.destroy failed (GC sweep will handle orphans)
    await this.stateRepo.updateStatus(sandboxId, 'destroyed');
    await this.stateRepo.stopBilling(sandboxId);

    // Record teardown cost — both sinks (sandbox_usage_log + usage_events)
    // for the same OU drain reason as provision above.
    const teardownCredits = await calculateSandboxCredits(
      'teardown', 0, this.creditCostProvider, session.tenantId,
    );
    await this.usageRepo.recordUsage({
      tenantId: session.tenantId,
      invocationId: session.invocationId,
      agentId: session.agentId,
      sandboxId,
      phase: 'teardown',
      toolName: null,
      cpuMillis: 0,
      memoryMbSeconds: 0,
      egressBytes: 0,
      wallClockMs: 0,
      creditsConsumed: teardownCredits,
      template: stateRecord.template,
      exitCode: null,
      idempotencyKey: `${session.invocationId}:${sandboxId}:teardown`,
    });
    await this.usageLedger.recordUsage({
      tenantId: session.tenantId,
      agentId: session.agentId,
      workflowId: null,
      actionId: uuid(),
      eventType: 'sandbox_teardown',
      credits: teardownCredits,
      metadata: {
        sandboxId,
        template: stateRecord.template,
        actionRef: `sandbox:${sandboxId}:teardown`,
      },
    });

    // Clean up in-memory state
    this.activeSandboxes.delete(session.sessionId);
    this.rateLimiter.clearSandbox(sandboxId);
    // The skill files lived in THAT workspace. A replacement sandbox starts
    // empty, so forgetting this is what lets the next one be filled again.
    this.skillFilesMaterialized.delete(sandboxId);

    log.info({ message: 'Sandbox cleaned up', sandboxId });
  }

  /**
   * GC sweep: find and destroy orphaned sandboxes.
   *
   * Two phases run on every invocation:
   *   1. DB-backed sweep — rows in `sandbox_state` whose heartbeat lapsed
   *      (status NOT IN ('destroyed','error') AND last_heartbeat < now-window).
   *      This catches the normal failure mode: agent or runtime instance died
   *      mid-session, leaving the sandbox running with stale heartbeats.
   *   2. Cloud Run orphan sweep — services that exist at the provider level
   *      but have no row in `sandbox_state`. This catches the failure mode
   *      where `provider.create()` threw inside waitForServiceReady BEFORE
   *      stateRepo.create() inserted a row.
   *
   * Returns the total number of sandboxes destroyed across both phases.
   */
  async gcSweep(maxHeartbeatAgeMs: number = 1_200_000): Promise<number> {
    let cleaned = 0;
    cleaned += await this.sweepFinishedAutonomous();
    cleaned += await this.sweepDbOrphans(maxHeartbeatAgeMs);
    cleaned += await this.sweepCloudRunOrphans();
    return cleaned;
  }

  /** Phase 0: sandboxes belonging to a finished cron/event run.
   *
   *  The heartbeat window cannot tell "finished" from "paused" — the heartbeat
   *  only advances on tool calls, and both stop making them — so it has to be
   *  long enough for the paused case, and every minute of it is a pinned
   *  instance. Asking the invocation instead answers the question directly for
   *  the one class of run that provably has no second reader. Runs it does not
   *  cover still fall through to the heartbeat sweep below. */
  private async sweepFinishedAutonomous(): Promise<number> {
    let finished: Awaited<ReturnType<typeof this.stateRepo.findFinishedAutonomous>>;
    try {
      finished = await this.stateRepo.findFinishedAutonomous();
    } catch (err) {
      // Never let this cost the heartbeat sweep, which is the safety net.
      log.warn({ message: 'finished-run sweep query failed', error: (err as Error).message });
      return 0;
    }
    if (finished.length === 0) return 0;

    let cleaned = 0;
    for (const record of finished) {
      try {
        await this.aliveTicker?.tick();
      } catch (err) {
        log.warn({
          message: 'instance-alive flush before finished-run teardown failed',
          sandboxId: record.sandboxId,
          error: (err as Error).message,
        });
      }
      try {
        await this.provider.destroy(record.sandboxId);
        await this.stateRepo.updateStatus(record.sandboxId, 'destroyed');
        cleaned++;
        log.info({
          message: 'Released sandbox for a finished run',
          event: 'sandbox_released_on_finish',
          sandboxId: record.sandboxId,
          tenantId: record.tenantId,
          heldMs: Date.now() - record.createdAt.getTime(),
        });
      } catch (err) {
        log.error({
          message: 'finished-run teardown failed',
          sandboxId: record.sandboxId,
          error: (err as Error).message,
        });
        await this.stateRepo.updateStatus(record.sandboxId, 'error');
      }
    }
    return cleaned;
  }

  /** Phase 1: rows in sandbox_state with stale heartbeats. */
  private async sweepDbOrphans(maxHeartbeatAgeMs: number): Promise<number> {
    const orphaned = await this.stateRepo.findOrphaned(maxHeartbeatAgeMs);

    if (orphaned.length === 0) return 0;

    log.warn({
      message: 'GC sweep found orphaned sandboxes',
      count: orphaned.length,
      sandboxIds: orphaned.map(s => s.sandboxId),
    });

    let cleaned = 0;
    for (const record of orphaned) {
      try {
        await this.provider.destroy(record.sandboxId);
        await this.stateRepo.updateStatus(record.sandboxId, 'destroyed');
        cleaned++;
        log.info({
          message: 'GC sweep destroyed orphaned sandbox',
          sandboxId: record.sandboxId,
          tenantId: record.tenantId,
          ageMs: Date.now() - record.lastHeartbeat.getTime(),
        });
      } catch (err) {
        log.error({
          message: 'GC sweep failed to destroy sandbox',
          sandboxId: record.sandboxId,
          error: (err as Error).message,
        });
        await this.stateRepo.updateStatus(record.sandboxId, 'error');
      }
    }

    return cleaned;
  }

  /**
   * Phase 2: Cloud Run services with no corresponding sandbox_state row.
   *
   * Skipped silently if the provider does not implement listSandboxServices
   * (e.g. in-process test stubs). Services younger than `minAgeSeconds` are
   * skipped to avoid racing with an in-flight create() whose stateRepo.create()
   * call hasn't landed yet.
   */
  private async sweepCloudRunOrphans(minAgeSeconds: number = 900): Promise<number> {
    if (typeof this.provider.listSandboxServices !== 'function') return 0;

    let services: import('./types').SandboxServiceRecord[];
    try {
      services = await this.provider.listSandboxServices();
    } catch (err) {
      log.error({ message: 'GC sweep listSandboxServices failed', error: (err as Error).message });
      return 0;
    }

    if (services.length === 0) return 0;

    const eligible = services.filter(s => s.ageSeconds >= minAgeSeconds);
    if (eligible.length === 0) return 0;

    // Single batched query of sandbox_state — checking each id individually
    // would be N round-trips for a sweep that runs every 2 minutes.
    const tracked = await this.stateRepo.findExisting(eligible.map(s => s.sandboxId));
    const trackedSet = new Set(tracked);
    const orphanIds = eligible.filter(s => !trackedSet.has(s.sandboxId)).map(s => s.sandboxId);

    if (orphanIds.length === 0) return 0;

    log.warn({
      message: 'GC sweep found Cloud Run orphans (services not in sandbox_state)',
      count: orphanIds.length,
      sandboxIds: orphanIds,
    });

    let cleaned = 0;
    for (const sandboxId of orphanIds) {
      try {
        await this.provider.destroy(sandboxId);
        cleaned++;
        log.info({ message: 'GC sweep destroyed Cloud Run orphan', sandboxId });
      } catch (err) {
        log.error({
          message: 'GC sweep failed to destroy Cloud Run orphan',
          sandboxId,
          error: (err as Error).message,
        });
      }
    }

    return cleaned;
  }
}
