# SDK Hook Contract

## Pinned version

`@anthropic-ai/claude-agent-sdk` is pinned to an exact version in
`package.json` (no `^` or `~`). Every upgrade requires re-running the contract
test suite and updating this document.

Current pinned version: **0.3.220**.

Upgraded from 0.2.98, whose bundled CLI predated `claude-opus-5` and applied the
wrong thinking config for it; 0.3.220 recognizes opus-5 natively.

This number is now ENFORCED, not merely written down. `sdk-hook-contract.test.ts`
reads the exact pin out of `package.json` and fails when this line disagrees with
it. The drift it replaces was not cosmetic: this page was described as pinned to
0.2.98 while the runtime had been on 0.3.220 for weeks, so
anyone reading this page to decide whether an upgrade was safe was reading about
a version we do not run.

## Contract

The native-workspace architecture depends on three SDK hook semantics. Each is
proven by a probe in `src/agent-execution/certification/sdk-hook-contract.ts`,
run at PR time by `src/interactive-chat/__tests__/sdk-hook-contract.test.ts` and
against the LIVE API by the `sdk_hook_contract` certification category whenever
the pinned SDK version changes (`certify-on-sdk-change` in cloudbuild.yaml,
which gates the deploy). Bumping the pin is the only thing that can invalidate
these, so it is the trigger; there is deliberately no schedule.

### 1. Returning `permissionDecision: 'deny'` blocks tool execution

Returned under `hookSpecificOutput` as
`{ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason }`.
The tool does not run — `PostToolUse` never fires for it — and its output never
reaches the model. This is the primitive every gate in the runtime uses.

### 2. `PostToolUse` `additionalContext` reaches the model

Returned as `{ hookEventName: 'PostToolUse', additionalContext }`. The text is
put in front of the model after the call. This is how the uniform `TOOL_ERROR`
envelope and the recovery hints arrive; if it stops working, the model reads raw
vendor errors and every classification above it is wasted.

For MCP tools specifically the runtime also uses `updatedMCPToolOutput` to
replace the output outright.

### 3. Hooks fire per tool call, not per batch

When the model issues multiple tool calls, the hooks fire independently for
each. Denying one does not affect its siblings.

### 4. `PostToolBatch` fires once per batch, after its `PostToolUse` hooks, naming the calls

`PostToolBatchHookInput.tool_calls[]` carries the `tool_use_id` of every call in
the model turn, and the hook fires once after all of them have resolved and
before the next model request. Two things depend on it: the terminal-round
turn-closer in the Anthropic adapter, and the strike ledger in
`agent-execution/service.ts`, which folds a model turn's tool rejections into
ONE strike only when the batch closes and names them. The per-call
`PostToolUse` hooks may run concurrently, so they cannot say which batch a
rejection belonged to; this hook is the only in-order statement of that. If it
stops firing, no rejection ever becomes a strike: the run logs
`tool_batch_boundary_missing` at its end, and the escalation caps for permanent
and malformed calls are effectively off on this engine until the pin is fixed.

## What does NOT hold on the pinned SDK

Two semantics that are easy to assume are not true of the pinned SDK. A suite
that skips itself without a credential cannot catch that, which is why the
live certification run exists.

- **"Throwing from `PreToolUse` blocks tool execution" is FALSE on 0.3.220.**
  The hook fires, the throw is swallowed, the tool executes, and
  its content reaches the model. Nothing in the runtime relies on this — every
  gate returns a `deny` decision — so there is no live hole, but no probe
  asserts it either. A check that fails for a behaviour nothing uses is a check
  people mute.
- **"`PostToolUse` `modified_result` replaces what the model sees" names a field
  that does not exist.** The replacement fields are `updatedToolOutput` (which
  does not take effect for built-in tools) and `updatedMCPToolOutput`.

A suite that collects `tool_result` and `text_delta` events, neither of which
this SDK emits, has "the tool was blocked" and "the content never reached the
model" assertions that hold for every possible run — including one where the
hook never fired at all.

## If the contract fails

`certify-on-sdk-change` runs the suite when the pin moves and **gates
`deploy-agent-service`**, so a pin bump that breaks the contract leaves the image
built and the service not moved onto it. The failing category is in the
`engine_live_certification` result log. See
`docs/runbooks/sdk-contract-failure.md`.

- **`deny` stops blocking** — the serious one. Every gated tool call in the
  runtime is refused this way, so a deny that no longer blocks means governance
  denials become advisory. There is no fallback primitive: throwing does not
  block on this SDK version either. The runtime falls back to sandbox-only mode
  via the emergency kill switch
  (`system_config.chat_turn_globally_disabled = TRUE`).
- **`additionalContext` stops arriving** — the model reads raw vendor tool
  errors instead of the uniform envelope. Not a safety hole; a quality and
  recovery-accuracy regression. Fix forward.
- **Hooks stop firing per call** — a deny would take its siblings with it or let
  them through. Treat as the first case until it is understood which.


## Related

- `docs/runbooks/sdk-contract-failure.md` — incident response runbook
- `cloudbuild.yaml` step `certify-on-sdk-change` — runs the live suite when the
  pin moves, and gates the deploy on it
- `src/agent-execution/certification/sdk-hook-contract.ts` — the probes
  themselves, shared by that run and the PR-time suite
