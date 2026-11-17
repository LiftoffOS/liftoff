# Context posture, per engine

Who owns the conversation history, who compacts it, and what happens when it
gets too long. Written because the answer differs per engine and the difference
is not visible from the adapter interface alone.

## The two shapes

**Session-owned.** The engine holds the history upstream. We send the first
turn's text, the engine assigns a session or thread id, and every later turn
sends only the new input. What has accumulated in our `state.conversationHistory`
is not what the model sees, so measuring it tells us nothing.

**Platform-owned.** We hold the history. Every `adapter.invoke` sends the whole
array. It grows with every assistant reply, every tool result, and every resume
that folds prior turns back in.

| Engine | Adapter | History owner | Compaction |
|---|---|---|---|
| Anthropic (Claude Agent SDK) | `adapter/anthropic` | Session-owned | The SDK compacts its own session. We do not control it and do not see it. |
| Codex | `adapter/codex` | Session-owned (thread) | Upstream. Resume re-enters via `resumeThread`. |
| opencode | `adapter/opencode` | Session-owned | Upstream. |
| Gemini ADK | `adapter/gemini-adk` | Session-owned | Upstream session service. |
| Gemini (direct) | `adapter/gemini` | **Platform-owned** | None. |
| OpenAI / OpenRouter | `adapter/openai` | **Platform-owned** | None. |

The `managesOwnContext` flag on `VendorSdkAdapter` is how an adapter declares
which side of that line it is on. It is `true` on the four session-owned
adapters and absent on the two platform-owned ones.

## Measurement is separate from intervention

`managesOwnContext` gates **acting**, not **looking**. On a session-owned engine
we cannot inject a summarize-and-continue turn or end a run on our own count,
because what accumulated locally is not what the model sees. There is no reason
to be blind while we cannot act — and the four session-owned engines are exactly
the ones that hit the ceiling, so gating the measurement on the same flag left us
blind precisely where it mattered (ADR-007).

**Every engine is measured. Two of them are intervened on.**

### In-run, from the provider's own count

Every `usage` event emits a `context_pressure` sample:

```
usedTokens          = usage.inputTokens + usage.cachedTokens
contextWindow       = the model's window (see below)
contextWindowSource = 'registry' | 'provider_floor'
usedRatio           = usedTokens / contextWindow
managesOwnContext   = whether we could have acted on it
```

`inputTokens + cachedTokens` is what the provider actually counted — strictly
better than `historyChars / 3.5`. `contextWindowSource` travels with every
sample because a ratio against a floor is a weaker claim than one against a
recorded window, and a reader who cannot tell them apart will draw a conclusion
the data does not support.

`scripts/harness-stats.ts --report context-pressure` reads the distribution by
engine and the registry/floor split.

### The window itself

`llm/context-window.ts` resolves it from the model registry overlay, which
platform-backend serves from `models.context_window` beside pricing and branding.
It falls back to `PROVIDER_WINDOW_TOKENS` and **says which it used**.

> **Only `source === 'registry'` may drive a destructive decision.** Anthropic's
> floor is 200,000 and `claude-opus-5[1m]` holds 1,000,000, so a healthy
> 300k-token run measured against the floor reads as an overflow — and wired to a
> session retirement, that abandons a perfectly good conversation. Use
> `mayDriveRetirement(reading)`, not an inline string comparison.

Before the registry loads, every reading is a floor and nothing can be retired on
window evidence. That is the correct failure direction.

### Pre-invoke seed check

Before the single `adapter.invoke`, the character estimate is taken and logged
**for every engine**. It is the only signal available before the first `usage`
event. The two interventions stay gated on `managesOwnContext !== true`:

- Past 75 percent — push one summarize-and-continue nudge as a user turn. The
  nudge also states what SURVIVES it (workspace, live shell/node sessions, spill
  files), because a model told to restate and carry on can otherwise conclude
  everything outside the restatement is gone and re-derive work it already did.
- Past 95 percent — do not call the provider at all. End the run as `escalated`
  with the last assistant text as its output.

## Overflow detection

`adapter/overflow.ts` detects three modes. Two of them produce **no error text**,
so no prose check could ever see them:

| Mode | Condition | Needs a recorded window? |
|---|---|---|
| `error_text` | the provider rejected the request and said so | no |
| `silent` | a healthy outcome whose input exceeded the window | **yes** |
| `length_stop` | `limit_reached` with ZERO output tokens at ≥99% of the window | **yes** |

`NON_OVERFLOW_PATTERNS` is tested first. Bedrock formats throttling as
*"Too many tokens, please wait before trying again"* — read as an overflow, that
retires a session that only needed to wait.

The verdict feeds `retireAutonomousSessionIfExhausted` as a fourth signal beside
`failureClass`, `output` and `error`, along with
`peakContextRatio >= CONTEXT_SATURATION_RATIO`. `contextExhaustedCompletion`
remains the last-resort prose check.

## We still do not compact

There is no compaction engine in this repo for any engine, and building one for
the two platform-owned paths is not justified by anything observed: those runs
are already bounded by the tool-result cap
(`adapter/tool-result-bound.ts`, 50K per result plus a 200K per-turn budget) and
by a finite turn count.

## If you are adding an engine

Set `managesOwnContext = true` only if the engine genuinely holds the history
upstream after the first turn. Getting this wrong in that direction is the
expensive mistake: the two interventions step aside and the run dies on a
provider rejection instead. Getting it wrong the other way is merely wasteful —
the pre-invoke estimate will be of a history the model never sees. Either way the
in-run `usage`-derived measurement is correct, because it comes from the provider.

Also: record the model's `context_window` in the platform-backend registry. A
model without one falls back to the provider floor, which logs and nudges fine
but can never retire a saturated session.
