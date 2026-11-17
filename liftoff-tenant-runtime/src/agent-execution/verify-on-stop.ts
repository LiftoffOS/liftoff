// B1 — did the agent check its own work before it stopped?
//
// The failure this addresses is specific and common: an autonomous SWE run
// edits files, reports success, and never ran a test, a build, or a linter.
// Nothing today notices. Every downstream signal — the outcome, the audit row,
// the activity feed — says the run succeeded, because from the platform's point
// of view it did.
//
// So: watch what the run touched, watch what it verified, and at the finalize
// point ask whether those two facts are consistent. When they are not, the run
// gets ONE bounded continuation asking it to verify or say plainly why it
// cannot. Not a retry loop, not a policy engine — one nudge, then the run ends
// either way.
//
// Two deliberate limits:
//   - Autonomous runs only. A chat turn has a person in it who can ask.
//   - Evidence is observed, never assumed. A run that says "tests pass" without
//     having run anything produces no evidence here, which is the point.

import { LruCache } from '../infrastructure/lru-cache';

/** Per-run observation. Keyed by invocation id, cleared at finalize. */
interface RunObservation {
  changedPaths: Set<string>;
  /** Verification-shaped commands the run actually executed, with what
   *  happened. `passed` is null when the exit status could not be read. */
  evidence: Array<{ command: string; passed: boolean | null }>;
  /** Workspace fingerprints, first and latest seen.
   *
   *  The allow-list below answers "which paths changed", and it answers it by
   *  recognising tool names and scraping shell commands — so it is blind to any
   *  write that goes through a path nobody enumerated. `curl -o out.json`,
   *  `git apply`, `npx prettier --write`, `git_clone`, `git_commit_and_push`,
   *  `nodejs_execute`, a non-bash `code_execute`, and `python -c "open(f,'w')"`
   *  inside a shell command are all invisible to it. An agent doing ordinary
   *  fetch-transform-write work reports an empty changedPaths however many files
   *  it wrote.
   *
   *  That made `wouldNudge: 0` uninterpretable: it means either "this run did no
   *  file work" or "this run's file work went through a path the observer does
   *  not watch", and nothing distinguishes them. The fingerprint answers the
   *  narrower question — did the workspace move — for every write, whatever made
   *  it, so the two readings can finally be told apart. */
  fingerprintAtStart?: string;
  fingerprintAtStop?: string;
}

/** The workspace fingerprint each run was last nudged at.
 *
 *  Deliberately NOT part of RunObservation. The observation is cleared on every
 *  finalize path — that is its documented contract and the reason the map does
 *  not grow for the life of the process — so a suppressor stored inside it would
 *  be erased at exactly the moment it becomes relevant: the run is nudged, the
 *  observation is released, the continuation re-enters, and the record of having
 *  already nudged is gone.
 *
 *  Bounded rather than unbounded for the same reason the observation map is
 *  cleared: a suppressor that leaks is a memory leak with extra steps. Six hours
 *  comfortably outlives any run, including one held at a HITL pause. */
const nudgedFingerprints = new LruCache<string, string>({
  max: 5_000,
  ttlMs: 6 * 60 * 60 * 1000,
});

const observations = new Map<string, RunObservation>();

/** Tools that write to a file directly, with the argument that names the path.
 *  Covers both our gateway's sandbox tools and the Claude Agent SDK's own file
 *  tools, since a SWE run on the Anthropic engine uses the latter. */
const FILE_WRITE_TOOLS: Record<string, string[]> = {
  write_file: ['path', 'file_path', 'filePath'],
  edit_file: ['path', 'file_path', 'filePath'],
  create_file: ['path', 'file_path', 'filePath'],
  str_replace_editor: ['path'],
  apply_patch: ['path', 'file_path'],
  // Claude Agent SDK built-ins.
  write: ['file_path', 'path'],
  edit: ['file_path', 'path'],
  multiedit: ['file_path', 'path'],
  notebookedit: ['notebook_path', 'file_path'],
  // Tool-gateway sandbox registry names (execution-environments/
  // function-registry.ts) — the tools the capability tier exposes to the
  // custom loop. These are what the gateway dispatch seam reports.
  file_write: ['path', 'file_path', 'filePath'],
  file_edit: ['path', 'file_path', 'filePath'],
  file_str_replace_editor: ['path'],
};

/** The str_replace editors multiplex reads and writes through one tool; a
 *  'view' reads and must not be recorded as a change (a false nudge is worse
 *  than a miss, per the module contract). */
const STR_REPLACE_EDITOR_NAMES = new Set(['str_replace_editor', 'file_str_replace_editor']);

const BASH_TOOL_NAMES = ['run_shell', 'bash', 'execute_command', 'shell', 'run_command', 'shell_exec'];

/** Extract the shell command a tool call runs, across the three shapes the
 *  platform dispatches: plain command-string tools, the bash-session exec
 *  (an argv array), and code_execute when its language is bash. Empty string
 *  when the call is not shell-shaped. */
function shellCommandFrom(name: string, args: Record<string, unknown>): string {
  if (BASH_TOOL_NAMES.includes(name)) {
    if (typeof args.command === 'string') return args.command;
    if (typeof args.cmd === 'string') return args.cmd;
    return '';
  }
  if (name === 'bash_session_exec') {
    const argv = args.args;
    return Array.isArray(argv)
      ? argv.filter((a): a is string => typeof a === 'string').join(' ')
      : '';
  }
  if (name === 'code_execute') {
    return args.language === 'bash' && typeof args.code === 'string' ? args.code : '';
  }
  return '';
}

/** Model-facing names are namespaced per server (`mcp__liftoff-tool-gateway__…`)
 *  and the SDK's own tools are capitalized. Reduce both to the bare lowercase
 *  name so one table covers every engine. */
function canonicalToolName(toolName: string): string {
  const bare = toolName.includes('__') ? toolName.slice(toolName.lastIndexOf('__') + 2) : toolName;
  return bare.toLowerCase();
}

/** Shell commands that mutate a tracked path. Same scrape-the-command approach
 *  branch-tracker.ts already uses for branch names — imperfect by nature, which
 *  is why a miss only means no nudge, never a false one. */
const SHELL_WRITE_PATTERNS: RegExp[] = [
  /(?:^|[;&|]\s*)(?:sudo\s+)?(?:tee|touch)\s+(\S+)/g,
  /(?:^|[;&|]\s*)(?:sudo\s+)?(?:cp|mv)\s+\S+\s+(\S+)/g,
  /(?:^|[;&|]\s*)(?:sudo\s+)?rm\s+(?:-\w+\s+)*(\S+)/g,
  />>?\s*(\S+)/g,
  /(?:^|[;&|]\s*)sed\s+-i\S*\s+\S+\s+(\S+)/g,
];

/** Commands that constitute verification. Intentionally about RUNNERS, not
 *  about words: "npm test" counts, a sentence containing the word test does
 *  not. */
const VERIFY_PATTERNS: RegExp[] = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|build|typecheck|tsc)\b/,
  /\bnpx\s+(?:jest|vitest|tsc|eslint|playwright)\b/,
  /\b(?:pytest|tox|mypy|ruff|flake8|black\s+--check)\b/,
  /\bgo\s+(?:test|vet|build)\b/,
  /\bcargo\s+(?:test|clippy|build|check)\b/,
  /\b(?:make)\s+(?:test|check|lint|build)\b/,
  /\bgradle(?:w)?\s+(?:test|check|build)\b/,
  /\bmvn\s+(?:test|verify)\b/,
  /\bdotnet\s+(?:test|build)\b/,
  /\bbundle\s+exec\s+(?:rspec|rubocop)\b/,
  /\bphpunit\b/,
  /\btsc\b(?!\w)/,
  /\beslint\b/,
];

/** Extensions whose change needs no test run. A README edit is not an
 *  unverified code change. */
const PROSE_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.rst', '.adoc',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
  '.csv', '.log',
]);

function isProsePath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return PROSE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/** Strip quoting and shell redirection noise so two spellings of one path do
 *  not read as two changes. Returns null for anything that is clearly not a
 *  path (a flag, a variable, an empty capture). */
function normalizePath(raw: string): string | null {
  let p = raw.trim().replace(/^['"]|['"]$/g, '');
  if (!p || p.startsWith('-') || p.startsWith('$')) return null;
  // Descriptors and process substitution are not files anyone edited.
  if (/^\/dev\//.test(p) || /^&\d/.test(p)) return null;
  p = p.replace(/^\.\//, '');
  return p || null;
}

function observationFor(invocationId: string): RunObservation {
  let o = observations.get(invocationId);
  if (!o) {
    o = { changedPaths: new Set(), evidence: [] };
    observations.set(invocationId, o);
  }
  return o;
}

/** Record a workspace fingerprint for this run.
 *
 *  Called from the sandbox executor, which is the only place that sees EVERY
 *  mutation — a file write, a shell command, a session exec and a clone all
 *  converge there — and the only place holding the provider and sandbox id the
 *  fingerprint needs. The first fingerprint recorded is the start state; every
 *  later one replaces the stop state.
 *
 *  Never throws: observation is diagnostics. */
export function recordWorkspaceFingerprint(
  invocationId: string | undefined,
  fingerprint: string | undefined,
): void {
  if (!invocationId || !fingerprint) return;
  try {
    const o = observationFor(invocationId);
    if (o.fingerprintAtStart === undefined) o.fingerprintAtStart = fingerprint;
    o.fingerprintAtStop = fingerprint;
  } catch {
    /* observation must never break a tool call */
  }
}

/** The workspace fingerprint this run was last nudged at. Test-only: the
 *  suppressor itself reads the map directly inside assessRun, and an accessor
 *  nothing production calls would be a feature that does not run. */
export function _lastNudgeFingerprintForTest(invocationId: string | undefined): string | undefined {
  if (!invocationId) return undefined;
  return nudgedFingerprints.get(invocationId);
}

/** Record that a nudge was issued at the run's current workspace state, so a
 *  later assessment can tell whether anything has moved since.
 *
 *  Stores a sentinel when the workspace could not be fingerprinted: "we nudged
 *  and could not read the workspace" still has to suppress a second identical
 *  nudge, or an unfingerprintable run can be nudged on every finalize. */
export function markNudged(invocationId: string | undefined): void {
  if (!invocationId) return;
  const o = observations.get(invocationId);
  nudgedFingerprints.set(invocationId, o?.fingerprintAtStop ?? UNFINGERPRINTED);
}

/** Stands in for "nudged, workspace unreadable". A real tree hash is a hex
 *  object id, so this can never collide with one. */
const UNFINGERPRINTED = 'unfingerprinted';

/** Forget one run's nudge record. Test-only: production relies on the TTL. */
export function _forgetNudgeForTest(invocationId: string): void {
  nudgedFingerprints.delete(invocationId);
}


/** Did this command run a verifier? Exported for the finalize gate's message,
 *  which names the verifiers it saw. */
export function looksLikeVerification(command: string): boolean {
  return VERIFY_PATTERNS.some((re) => re.test(command));
}

/** Read a shell tool result for a pass/fail signal. Tool results are shaped
 *  differently per engine, so this is deliberately forgiving: an unreadable
 *  result yields null (unknown), never a false pass. */
export function exitStatusFromResult(result: unknown): boolean | null {
  if (result == null) return null;

  const asRecord = typeof result === 'object' ? (result as Record<string, unknown>) : null;
  if (asRecord) {
    if (asRecord.isError === true) return false;
    for (const key of ['exitCode', 'exit_code', 'returncode', 'status']) {
      const v = asRecord[key];
      if (typeof v === 'number') return v === 0;
    }
  }

  const text = extractText(result);
  if (!text) return null;
  // Explicit exit-code reporting is the only textual signal worth trusting.
  const m = /\bexit(?:\s+|_)?(?:code|status)?\s*[:=]?\s*(\d+)\b/i.exec(text);
  if (m) return Number(m[1]) === 0;
  return null;
}

function extractText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      return content
        .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
          ? (c as { text: string }).text
          : ''))
        .join('\n');
    }
    const out = (result as { stdout?: unknown; output?: unknown });
    if (typeof out.stdout === 'string') return out.stdout;
    if (typeof out.output === 'string') return out.output;
  }
  return '';
}

/**
 * Record one tool call. Called from both observation seams — the MCP bridge
 * (OpenAI / OpenRouter / Gemini) and the Anthropic PostToolUse hook — so the
 * gate sees the same picture whichever engine ran.
 *
 * Never throws: observation is diagnostics, and a bad regex must not be able to
 * fail a tool call.
 */
export function observeToolCall(
  invocationId: string | undefined,
  toolName: string,
  args: Record<string, unknown> | undefined,
  result: unknown,
): void {
  if (!invocationId) return;
  try {
    const o = observationFor(invocationId);
    const name = canonicalToolName(toolName);

    if (name === 'code_session') {
      observeCodeSession(o, result);
      return;
    }

    const pathKeys = FILE_WRITE_TOOLS[name];
    if (pathKeys && args) {
      if (STR_REPLACE_EDITOR_NAMES.has(name) && args.command === 'view') return;
      for (const key of pathKeys) {
        const v = args[key];
        if (typeof v === 'string') {
          const p = normalizePath(v);
          if (p) o.changedPaths.add(p);
          break;
        }
      }
      return;
    }

    if (!args) return;
    const command = shellCommandFrom(name, args);
    if (!command) return;

    if (looksLikeVerification(command)) {
      o.evidence.push({ command: command.slice(0, 200), passed: exitStatusFromResult(result) });
      // A verifier can also write (a build emits artifacts); recording it as a
      // change would make the run look unverified for having verified.
      return;
    }

    for (const pattern of SHELL_WRITE_PATTERNS) {
      // Patterns are global; reset so a prior call's lastIndex cannot skip a match.
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(command)) !== null) {
        const p = normalizePath(m[1] ?? '');
        if (p) o.changedPaths.add(p);
      }
    }
  } catch {
    /* observation must never break a tool call */
  }
}

/** Shape a gateway dispatch result for observation. The tool's OWN exit
 *  information — a numeric exit key, an error envelope, or explicit exit-code
 *  text in a string result — always wins over the gateway-level success flag:
 *  a shell tool can dispatch successfully while the command inside it failed.
 *  The flag is only the fallback when the result carries no readable exit
 *  signal of its own. */
export function observedDispatchResult(success: boolean, data: unknown): unknown {
  if (exitStatusFromResult(data) !== null) return data;
  return {
    isError: !success,
    exitCode: success ? 0 : 1,
    output: typeof data === 'string' ? data : JSON.stringify(data ?? ''),
  };
}

/** code_session delegates the actual code work to a nested vendor coding agent
 *  and returns what that agent did — `files_modified` plus the inner agent's
 *  `tool_calls_made`. On the Anthropic engine the OUTER agent has no file or
 *  shell tools at all (code work goes via this tool), so this result is the
 *  only window into what a run changed. Mine it for both halves of the
 *  observation: changes, and verification evidence.
 *
 *  A verifier that ran inside a failed or timed-out session
 *  (`exit_reason !== 'success'`) is recorded with passed:false — an aborted
 *  session must never count as passing evidence. */
function observeCodeSession(o: RunObservation, result: unknown): void {
  const text = extractText(result);
  if (!text) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return; // not the CodeSessionOutput shape — observe nothing rather than guess
  }
  if (parsed == null || typeof parsed !== 'object') return;
  const out = parsed as {
    files_modified?: unknown;
    tool_calls_made?: unknown;
    exit_reason?: unknown;
  };
  const sessionSucceeded = out.exit_reason === 'success';

  if (Array.isArray(out.files_modified)) {
    for (const f of out.files_modified) {
      if (typeof f !== 'string') continue;
      const p = normalizePath(f);
      if (p) o.changedPaths.add(p);
    }
  }

  if (Array.isArray(out.tool_calls_made)) {
    for (const call of out.tool_calls_made) {
      if (!call || typeof call !== 'object') continue;
      const args = (call as { args?: unknown }).args;
      const command = typeof args === 'string'
        ? args
        : args && typeof args === 'object'
          ? typeof (args as { command?: unknown }).command === 'string'
            ? (args as { command: string }).command
            : typeof (args as { cmd?: unknown }).cmd === 'string'
              ? (args as { cmd: string }).cmd
              : ''
          : '';
      if (!command || !looksLikeVerification(command)) continue;
      const innerResult = (call as { result?: unknown }).result;
      const passed = sessionSucceeded
        ? exitStatusFromResult(typeof innerResult === 'string' ? innerResult : null)
        : false;
      o.evidence.push({ command: command.slice(0, 200), passed });
    }
  }
}

export interface VerifyAssessment {
  /** Code paths the run changed (prose and assets excluded), from the tool
   *  allow-list and the shell patterns. Answers WHICH paths. */
  changedPaths: string[];
  /** The workspace content changed between the first observed mutation and the
   *  last. Answers WHETHER anything did — for every write, whatever made it,
   *  including the ones the allow-list cannot see.
   *
   *  A run where `workspaceMoved && changedPaths.length === 0` is a directly
   *  measurable count of how blind the allow-list was. */
  workspaceMoved: boolean;
  /** Every verification-shaped command the run ran. */
  evidence: Array<{ command: string; passed: boolean | null }>;
  /** True when the run changed something and produced no passing verification. */
  shouldNudge: boolean;
}

/** What the finalize gate needs to decide, without mutating anything.
 *
 *  `fingerprints` overrides what was observed, for a caller that took its own
 *  readings; omitted, the stored ones are used. */
export function assessRun(
  invocationId: string | undefined,
  fingerprints?: { atStart?: string; atStop?: string },
): VerifyAssessment {
  const empty: VerifyAssessment = {
    changedPaths: [], workspaceMoved: false, evidence: [], shouldNudge: false,
  };
  if (!invocationId) return empty;
  const o = observations.get(invocationId);
  if (!o) return empty;

  const changedPaths = [...o.changedPaths].filter((p) => !isProsePath(p));
  // A verifier whose exit status we could not read counts as evidence of an
  // ATTEMPT, and nudging a run that plainly tried is worse than staying quiet.
  const hasPassing = o.evidence.some((e) => e.passed !== false);

  const atStart = fingerprints?.atStart ?? o.fingerprintAtStart;
  const atStop = fingerprints?.atStop ?? o.fingerprintAtStop;
  // Both must be known. One missing reading means "we could not tell", which
  // must never become "nothing changed" — that would suppress a nudge the run
  // had earned.
  const workspaceMoved = atStart !== undefined && atStop !== undefined && atStart !== atStop;

  // A second nudge only if the workspace MOVED since the first. Otherwise the
  // run is being asked to verify the state it was already asked about, which is
  // how a one-shot check becomes a loop.
  const nudgedAt = nudgedFingerprints.get(invocationId);
  const alreadyNudgedAtThisState =
    nudgedAt !== undefined && nudgedAt === (atStop ?? UNFINGERPRINTED);

  return {
    changedPaths,
    workspaceMoved,
    evidence: o.evidence,
    shouldNudge: (changedPaths.length > 0 || workspaceMoved)
      && !hasPassing
      && !alreadyNudgedAtThisState,
  };
}

/** Why an assessed autonomous run was NOT nudged. Logged by the shadow-mode
 *  decision telemetry so reachability is provable from production logs — a
 *  gate that declines everything and a fleet that verifies everything look
 *  identical without this distinction.
 *
 *  `unobserved` is the third answer and it exists because the first two were
 *  being conflated: a run that named no changed paths AND whose workspace
 *  fingerprint was never read has not been assessed at all. Recording that as
 *  `no_code_change` claims the run did nothing, which is a claim the data does
 *  not support. */
export type VerifyDeclineReason = 'no_code_change' | 'verified' | 'unobserved';

/** Why an assessed run was not nudged.
 *
 *  ONE function, taking both facts it needs. There was briefly a second that
 *  took only the assessment, and it could not tell "the workspace did not move"
 *  from "nobody looked" — so it answered `no_code_change` to both, which claims
 *  the run did nothing on evidence that says only that we did not watch. Two
 *  functions answering the same question differently is how the weaker answer
 *  ends up in the logs. */
export function declineReasonFor(
  assessment: VerifyAssessment,
  fingerprintAvailable: boolean,
): VerifyDeclineReason {
  if (assessment.changedPaths.length > 0 || assessment.workspaceMoved) return 'verified';
  return fingerprintAvailable ? 'no_code_change' : 'unobserved';
}

/** Whether this run produced any workspace fingerprint at all. */
export function hasWorkspaceFingerprint(invocationId: string | undefined): boolean {
  if (!invocationId) return false;
  return observations.get(invocationId)?.fingerprintAtStop !== undefined;
}

/** Drop a run's observation. Called at finalize; without it the map grows for
 *  the life of the process. */
export function clearRunObservation(invocationId: string | undefined): void {
  if (invocationId) observations.delete(invocationId);
}

export type VerifyOnStopMode = 'off' | 'shadow' | 'enforce';

export function verifyOnStopMode(): VerifyOnStopMode {
  const raw = (process.env.VERIFY_ON_STOP_MODE ?? 'off').toLowerCase();
  return raw === 'enforce' ? 'enforce' : raw === 'shadow' ? 'shadow' : 'off';
}

/** The continuation the run gets, once. Names what it changed and what it must
 *  do about it, and explicitly allows "I cannot" as an answer — a run that is
 *  blocked should say so rather than invent a green suite. */
export function buildVerifyContinuation(assessment: VerifyAssessment): string {
  const shown = assessment.changedPaths.slice(0, 10);
  const more = assessment.changedPaths.length - shown.length;
  const fileList = shown.map((p) => `- ${p}`).join('\n')
    + (more > 0 ? `\n- and ${more} more` : '');

  const attempted = assessment.evidence.length > 0
    ? `\n\nYou ran: ${assessment.evidence.map((e) => e.command).join('; ')}. `
      + 'That did not pass, so it does not count as verification.'
    : '';

  return 'You changed code and are about to finish without any passing verification.\n\n'
    + `Files changed:\n${fileList}${attempted}\n\n`
    + 'Run the project\'s tests, type check, and linter for what you changed, and report what they said. '
    + 'If you cannot run them — no test command, a missing dependency, no sandbox — say exactly what '
    + 'blocked you instead. Do not describe a suite as passing unless you ran it and saw it pass, and '
    + 'do not describe a targeted run as if it covered everything.';
}
