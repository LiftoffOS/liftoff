// The hook behaviours the native-workspace architecture is built on, as probes
// that run against the LIVE Claude Agent SDK.
//
// These used to exist only as assertions inside a jest file, and a Cloud
// Scheduler job named `sdk-contract-weekly` pointed at an HTTP endpoint that has
// never existed, so it 404ed on every fire while reporting ENABLED. The
// behaviour it was supposed to watch is exactly the kind that changes underneath
// you: a patch release of somebody else's SDK can quietly stop honouring a deny,
// and nothing in our own repo would differ.
//
// Running them for the first time showed the old suite had been asserting a
// contract that no longer existed. Against 0.3.220:
//
//   · the SDK emits neither `tool_result` nor `text_delta` events, and the old
//     assertions collected both — so "no tool result came back" and "the marker
//     never reached the model" were true of every run, including one where the
//     hook never fired. Two of four tests passed against nothing.
//   · `PostToolUse` `modified_result` is not a field; the replacement field is
//     `hookSpecificOutput.updatedToolOutput`, and even that does not replace
//     what the model sees for built-in tools. This repo uses
//     `additionalContext` and `updatedMCPToolOutput` instead, so the probe
//     asserts the mechanism we actually depend on.
//   · **a `PreToolUse` throw does NOT stop the tool.** It runs, and its output
//     reaches the model. Nothing here relies on that — every gate returns
//     `permissionDecision: 'deny'` — so this is a correction to the document
//     rather than a live hole, but it is why no probe asserts it: a weekly check
//     that fails for a behaviour nothing uses is a weekly check people mute.
//
// So the probes live here, asserting what is true and load-bearing, and two
// things run them:
//   · `sdk-hook-contract.test.ts`, the PR-time consumer, which fails when
//     someone moves the pinned SDK version and the semantics moved with it;
//   · the `sdk_hook_contract` certification category, which runs weekly in the
//     engine-certification job against the live API.
//
// One definition, because a contract asserted in two places drifts in one of
// them, and the copy that drifts is always the one nobody runs.
//
// Every probe asserts the hook FIRED. A run where the model simply declined to
// call the tool must fail, not read as enforcement working.

import { promises as fs } from 'fs';
import crypto from 'crypto';
import { esmImport } from '../adapter/esm-import';
import { getManagedSecret } from '../../infrastructure/secret-store';

const SDK_MODULE = '@anthropic-ai/claude-agent-sdk';

type QueryEvent = { type: string; message?: unknown; [key: string]: unknown };

type HookCall = { tool_name: string; tool_input?: { file_path?: string; path?: string } };

export interface HookContractProbe {
  /** Stable id, used as the certification check name. */
  name: string;
  run(): Promise<void>;
}

/** Why these probes cannot be exercised here, or undefined when they can.
 *
 *  They drive the real API, so they need the SDK present and a credential. A
 *  caller that cannot run them has to say so rather than report a pass: "the
 *  contract holds" and "we did not check" are different answers, and only one
 *  of them is worth having. Returning the REASON rather than a boolean is what
 *  makes the second answer reportable. */
export function hookContractUnrunnableReason(): string | undefined {
  try {
    require.resolve(SDK_MODULE);
  } catch {
    return `${SDK_MODULE} is not installed`;
  }
  const credentialed =
    Boolean(getManagedSecret('ANTHROPIC_API_KEY')) ||
    Boolean(process.env.SDK_CONTRACT_RUN);
  if (!credentialed) return 'no ANTHROPIC_API_KEY';
  return undefined;
}

/** Drive one query to completion.
 *
 *  Reads assistant text out of `assistant` message content blocks. NOT
 *  `text_delta`, and tool outcomes NOT from `tool_result` — this SDK emits
 *  neither event type. The probes this replaced collected exactly those two,
 *  so their "no tool result came back" and "the marker never reached the model"
 *  assertions were true of every possible run, including one where the hook
 *  never fired at all. Two of the four passed against nothing.
 *
 *  Hook fire counts come back with the text for the same reason: every probe
 *  asserts on them, so a run where the model simply declined to call the tool
 *  FAILS instead of quietly looking like enforcement working. */
async function drive(
  prompt: string,
  hooks: { pre?: (call: HookCall) => unknown; post?: (call: HookCall) => unknown },
): Promise<{ text: string; preFired: number; postFired: number; preCalls: HookCall[]; postCalls: HookCall[] }> {
  // esmImport, not a bare `await import()`. Under `module: commonjs` TypeScript
  // downlevels a plain dynamic import to `require()`, which resolves this SDK to
  // an ESM entry and dies with "Cannot use import statement outside a module".
  const { query } = await esmImport<{
    query: (o: unknown) => AsyncIterable<QueryEvent>;
  }>(SDK_MODULE);

  // Read once: the store is the source the adapter uses, and the CLI accepts
  // either variable name depending on release.
  const anthropicKey = getManagedSecret('ANTHROPIC_API_KEY');

  let preFired = 0;
  let postFired = 0;
  const preCalls: HookCall[] = [];
  const postCalls: HookCall[] = [];
  const fragments: string[] = [];

  // The matcher-array registration form. A bare function under the event key is
  // not the shape this SDK reads, and it fails by never firing rather than by
  // erroring, which is the failure mode hardest to notice.
  const wrap = (fn: ((c: HookCall) => unknown) | undefined, count: () => void) =>
    [{ hooks: [async (call: HookCall) => { count(); return fn ? fn(call) : {}; }] }];

  for await (const ev of query({
    prompt,
    options: {
      cwd: '/tmp',
      allowedTools: ['Read'],
      // bypassPermissions is load-bearing, not convenience. Without it the
      // SDK's own permission layer runs alongside the hooks, the deny stops
      // holding, and the model reads the file anyway — verified, so the probe
      // would report a contract violation that is really a probe misconfiguration.
      permissionMode: 'bypassPermissions',
      // ...which the CLI refuses to honour as root, and the certification job's
      // container runs as root: "--dangerously-skip-permissions cannot be used
      // with root/sudo privileges for security reasons". IS_SANDBOX is the
      // documented escape for exactly this — an isolated container where the
      // protection that check provides is already supplied by the sandbox.
      //
      // Scoped to the subprocess rather than set on the process, because the
      // certification run drives seven other engines in the same process and
      // none of them should inherit it. `env` REPLACES rather than merges, so
      // process.env is spread back in or the subprocess loses PATH and HOME.
      //
      // The credential comes from the managed store, NOT from process.env.
      // `loadSecretsToEnv` copies only ENV_BOUND_SECRETS into the environment,
      // so in a job that runs with --clear-secrets the key is loaded and simply
      // not there — the CLI answers "Not logged in · Please run /login" and
      // three hook checks fail as contract violations. The adapter has always
      // read the store here; this is the one SDK caller that did not.
      env: {
        ...process.env,
        IS_SANDBOX: '1',
        ...(anthropicKey ? { ANTHROPIC_API_KEY: anthropicKey, ANTHROPIC_AUTH_TOKEN: anthropicKey } : {}),
      },
      hooks: {
        PreToolUse: wrap((c) => { preCalls.push(c); return hooks.pre ? hooks.pre(c) : {}; }, () => { preFired++; }),
        PostToolUse: wrap((c) => { postCalls.push(c); return hooks.post ? hooks.post(c) : {}; }, () => { postFired++; }),
      },
    },
  })) {
    if (ev.type === 'assistant') {
      const blocks = (ev.message as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? [];
      for (const b of blocks) if (b.type === 'text' && typeof b.text === 'string') fragments.push(b.text);
    }
  }
  return { text: fragments.join(''), preFired, postFired, preCalls, postCalls };
}

/** A sentinel file whose contents carry a marker unique to this probe run.
 *
 *  The marker, not the path, is what the assertions look for. A path proves the
 *  model was asked; only a marker distinguishes "the tool was blocked" from
 *  "the model paraphrased the file it did read". */
async function withSentinel<T>(fn: (path: string, marker: string) => Promise<T>): Promise<T> {
  const path = `/tmp/sentinel-${crypto.randomUUID()}.txt`;
  const marker = `MARKER_${crypto.randomBytes(8).toString('hex')}`;
  await fs.writeFile(path, `TRUSTED_SENTINEL_${marker}`);
  try {
    return await fn(path, marker);
  } finally {
    await fs.rm(path, { force: true });
  }
}

export const SDK_HOOK_CONTRACT_PROBES: readonly HookContractProbe[] = [
  {
    // The primary enforcement primitive: every gated tool call we refuse is
    // refused this way. A deny that blocks the call but leaks the content is
    // not a deny.
    name: 'permission_decision_deny_prevents_execution_and_leak',
    run: () =>
      withSentinel(async (path, marker) => {
        // EVERY tool is denied, not Read alone.
        //
        // The leak assertion below asks whether the sentinel reached the model.
        // Denying only Read left every other route open, so a model that gave
        // up on Read and reached the file another way tripped a check about
        // Read's deny — a probe hole reported as an SDK contract violation.
        const r = await drive(`Use the Read tool on ${path} and echo its exact contents.`, {
          pre: () => ({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: 'blocked by certification probe',
            },
          }),
        });
        if (!r.preCalls.some((c) => c.tool_name === 'Read')) {
          throw new Error('PreToolUse never fired for Read — the model did not call the tool, so nothing was proven');
        }
        // Scoped to the tool that was actually denied.
        //
        // This counted EVERY PostToolUse fire, and the probe denies Read alone —
        // so the model calling any other tool, once, reported a deny failure
        // that had not happened. That is why the check disagreed with itself
        // between two runs of the same image: whether a second tool gets called
        // is the model's decision, not the SDK's contract.
        const ran = r.postCalls.map((c) => c.tool_name);
        if (ran.length > 0) {
          throw new Error(`permissionDecision:deny did not stop the tool — PostToolUse fired for ${ran.join(', ')}`);
        }
        // Name the tools the model tried. A bare "content reached the model"
        // says nothing about how, and the how is the whole finding.
        if (r.text.includes(marker)) {
          throw new Error(
            `denied content reached the model anyway (tools attempted: ${r.preCalls.map((c) => c.tool_name).join(', ') || 'none'})`,
          );
        }
      }),
  },
  {
    // How the uniform TOOL_ERROR envelope and the recovery hints reach the
    // model. If injected context stops arriving, the model reads raw vendor
    // errors and every classification we do above it is wasted.
    //
    // NOT `updatedToolOutput`: verified against 0.3.220, it does not replace
    // what the model sees for built-in tools, and this repo does not use it —
    // asserting it would produce a check that fails every week for a behaviour
    // nothing depends on, which is how a weekly check gets ignored.
    name: 'post_tool_use_additional_context_reaches_model',
    run: () =>
      withSentinel(async (path) => {
        const injected = `INJECTED_${crypto.randomBytes(8).toString('hex')}`;
        const r = await drive(
          `Use the Read tool on ${path}. Then reply with every marker you were shown, verbatim.`,
          {
            post: () => ({
              hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `IMPORTANT MARKER: ${injected}` },
            }),
          },
        );
        if (r.postFired === 0) throw new Error('PostToolUse never fired — the model did not call the tool, so nothing was proven');
        if (!r.text.includes(injected)) throw new Error('PostToolUse additionalContext never reached the model');
      }),
  },
  {
    // Per-call granularity. If hooks fired per batch, one denied call would take
    // its siblings with it, or let them through.
    name: 'hooks_fire_per_call_with_deny_isolation',
    run: async () => {
      const markerA = `A_${crypto.randomBytes(8).toString('hex')}`;
      const markerB = `B_${crypto.randomBytes(8).toString('hex')}`;
      const pathA = `/tmp/a-${crypto.randomUUID()}.txt`;
      const pathB = `/tmp/b-${crypto.randomUUID()}.txt`;
      await fs.writeFile(pathA, `CONTENT_${markerA}`);
      await fs.writeFile(pathB, `CONTENT_${markerB}`);
      try {
        const r = await drive(
          `Use the Read tool on ${pathA}, then use the Read tool on ${pathB}. Then echo the exact contents of each file you were able to read.`,
          {
            pre: (call) => {
              const fp = call.tool_input?.file_path ?? call.tool_input?.path;
              return call.tool_name === 'Read' && fp === pathA
                ? {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: 'deny',
                      permissionDecisionReason: 'blocked-A',
                    },
                  }
                : {};
            },
          },
        );
        const reads = r.preCalls.filter((c) => c.tool_name === 'Read').length;
        if (reads < 2) throw new Error(`PreToolUse saw ${reads} Read call(s) for two files — hooks are not firing per call`);
        if (r.text.includes(markerA)) throw new Error('the DENIED file\'s contents reached the model');
        if (!r.text.includes(markerB)) throw new Error('the ALLOWED file\'s contents did not reach the model — a deny took its sibling with it');
      } finally {
        await fs.rm(pathA, { force: true });
        await fs.rm(pathB, { force: true });
      }
    },
  },
];
