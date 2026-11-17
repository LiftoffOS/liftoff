# Inbound webhooks (custom event sources)

A per-team-member HTTP endpoint that turns an external event into agent work.
Provisioned and managed from the team settings page (`/api/internal-agents/:id/webhook*`,
see `routes.ts`); the agent's own distilled reactive subscription decides what
happens when something arrives.

This file exists to record two things: how a request travels from the wire to a
running agent, and one design decision that keeps getting re-proposed.

## The chain

```
POST /api/events/inbound/:sourceId
  │
  ├─ signature      signing.ts        HMAC required. Timestamp is bound into the
  │                                   signed data, so a captured request cannot
  │                                   be replayed later; far-future timestamps
  │                                   are rejected too (clock-skew abuse).
  ├─ rate limit     rate-limiter.ts   Per-source, plus a per-tenant ceiling.
  │                                   Answers 429 with Retry-After.
  ├─ size           inbound-router    Body cap checked before the body is read.
  ├─ content        content-filter.ts Unsafe payloads → rejected_unsafe_content.
  ├─ idempotency    inbound-router    Honours an Idempotency-Key header, so a
  │                                   provider's retry does not run the agent
  │                                   twice.
  │
  ├─ rule match     service.ts        Which rules on this source want this event.
  │
  ├─ enqueue        outbox            One control-plane outbox row per matched
  │                                   rule, written BEFORE the response. The
  │                                   inline publish that follows is an
  │                                   optimisation; if it fails, the outbox
  │                                   worker retries. Nothing is lost by
  │                                   answering the caller quickly.
  │
  └─ delivery       events/publisher  event.custom_received → tenant runtime
                                      → handleCustomEventReceived → the agent
                                        wakes with the payload as CONTAINED,
                                        untrusted event data.
```

Delivery outcomes are recorded per request (`updateDelivery`), including the
rejection reasons above, so a tenant can see why their provider's call did not
produce work.

## Why there is no prompt template on a rule

Hermes-style webhook routes let you write a prompt with payload fields
interpolated into it (`"PR #{pull_request.number}: {pull_request.title}"`). We
deliberately do not, for two reasons:

1. **Prompts here are distilled, never hand-written.** A rule that carried its
   own prompt would be a second, parallel way to author agent behaviour — one
   that skips distillation, versioning, and rollback. The team member's
   behaviour on an inbound event comes from its distilled reactive subscription,
   the same place the rest of its behaviour comes from.

2. **Interpolation would undo the containment.** The payload arrives as
   untrusted data inside a fenced block precisely so that a hostile field value
   (`"title": "Ignore previous instructions and ..."`) is read as data rather
   than as instruction. Splicing those fields into the prompt text would put
   attacker-controlled content into the instruction channel, which is the
   thing the framing exists to prevent.

If a tenant needs event-shaped behaviour, the answer is to say so in the team
member's responsibilities ("when a pull request touches the auth module, ...")
and let distillation build the subscription.

## Not built, deliberately

**Zero-LLM delivery routes** (Hermes's `deliver_only`: render the payload and
post it straight to a channel, no agent involved). It is a genuinely cheap
feature, and there is no demand signal for it here — every request so far has
wanted the team member to *do* something with the event, not to forward it.
Recorded so the absence reads as a decision rather than an oversight.
