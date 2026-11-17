# Event publishing — canonical pattern + migration status

## The canonical pattern (plan §5.4)

Whenever a request handler mutates an entity AND publishes a corresponding
control-plane event, the two operations MUST commit in the same DB transaction:

```ts
import { mutateAndPublishEvent } from '../events/publisher';

const result = await mutateAndPublishEvent<MyEntity>(
  { caller: 'MyService.create', actor: userId, reason: 'create + publish' },
  async (client) => {
    const entity = await this.repository.createInTx(client, input);
    return {
      entity,
      eventInput: {
        entityType: 'my_entity',
        entityId: entity.id,
        eventType: 'my_entity.created',
        entityVersion: entity.version,
        eventVersion: 1,
        tenantId: entity.tenantId,
        payload: { /* ... */ },
      },
    };
  },
);
```

The helper:
1. Opens a `withAdminScope` transaction (BYPASSRLS).
2. Runs the caller's mutation function (which uses `client.query(...)` or
   `repository.*InTx(client, ...)`).
3. Enqueues the outbox row inside the same transaction.
4. Commits.
5. Calls `publishOutboxRowInline(rowRef)` — never throws; failures leave the
   outbox row `pending` and the 30s worker retries.

If anything inside the callback throws (including the outbox INSERT itself),
the entire transaction rolls back — the entity mutation is undone. This closes
the cross-tx atomicity gap.

## Shape 1 (legacy convenience)

`publishEvent(input)` continues to work. It opens its OWN withAdminScope tx
and routes through the outbox. The cross-tx atomicity gap (entity mutation
committed but outbox INSERT not) is covered by the 5-min reconciler. Use only
when refactoring to shape-3 is impractical.

Error contract:
- `internal_agent` events: swallow (matches legacy typed-wrapper contract).
- All other event types: **rethrow** so callers that explicitly catch + return
  5xx (e.g. account creation rolling back Stripe customer) continue to behave.

## Migration status

Sites migrated to **shape 3 (canonical, entity mutation + outbox in same tx)**:

| Module | Methods migrated | Notes |
|---|---|---|
| `src/internal-agents/service.ts` | `create`, `update`, `updateStatus`, `delete`, `rollbackToVersion` (via `update`) | All five entity-mutation methods now use `mutateAndPublishEvent` internally. The router callsites (POST create, PATCH update, PATCH status, DELETE, rollback) all flow through these methods. `service-shape3.test.ts` asserts the invariant: outbox enqueue failure ⇒ entity mutation rolled back AND inline publish skipped. |
| `src/tenants/service.ts` | `provision`, `activate`, `suspend`, `reactivate` | migration.* events remain on shape-1 (low-impact operational signals; reconciler is not load-bearing here). |
| `src/accounts/service.ts` | `create` | `update`, `email_changed`, `deleted` events remain on shape-1; see follow-up below. |

Internal-agent callsites that remain on shape-1 (intentionally — no concurrent
entity mutation):

| File | Callsite | Reason |
|---|---|---|
| `src/internal-agents/router.ts` (backfill-created-events) | loop over agents that already exist | pure observability/recovery republish; no entity mutation |
| `src/internal-agents/router.ts` (backfill-deleted-events) | loop over soft-deleted agents | pure recovery republish |
| `src/internal-agents/router.ts` (admin /republish-created) | single-agent re-emit | operator-triggered republish; no entity mutation |
| `src/internal-agents/router.ts` (operator router /republish-created) | single-agent re-emit | same as above |

**Removed (no consumer):**
- `src/agent-chat/router.ts` previously published `tenant.internal_agent.chat_started` (on thread create) and `tenant.internal_agent.chat_feedback_received` (on feedback). The tenant runtime had no handler — every publish fell through to the subscriber switch's `default:` case and emitted "Unknown event type" warnings. Removed to stop wasted bandwidth + log noise.

**Co-located with primary update event (shape-3):**
- `src/internal-agents/service.ts` (runtime_config_updated): co-located in `service.update`'s `mutateAndPublishEvent` callback. Both outbox rows commit atomically with the entity mutation. Envelope `entity_version` is `null` to bypass the runtime's version gate (which would otherwise drop this event when it has the same version as the primary `updated` event); the handler reads `payload.entityVersion` instead.

All other PB event callsites (~140 across 29 files) remain on **shape 1** —
outbox-routed at-least-once delivery with cross-tx atomicity covered by the
5-min reconciler:

All other callsites (~140 across 29 files). The list:

- `src/admin/service.ts` (8)
- `src/prompt-registry/service.ts` (14)
- `src/model-registry/service.ts` (11)
- `src/compliance/data-residency/service.ts` (5)
- `src/validator-hooks/service.ts` (5)
- `src/subscriptions/service.ts` (4)
- `src/overage-rules/service.ts` (4)
- `src/human-feedback/service.ts` (4)
- `src/deployments/service.ts` (4)
- `src/workflow-engine/step-executor.ts` (4)
- `src/rollout/orchestration-service.ts` (3)
- `src/feature-flags/service.ts` (3)
- `src/corrections/service.ts` (2)
- `src/disaster-recovery/restore-drill.ts` (2)
- `src/compliance/evidence/automated-collection.ts` (2)
- Plus 14 files with 1 callsite each.

## Follow-up: completing the canonical migration

For each remaining file, the refactor pattern is:

1. **Repository:** add a `*InTx(client, ...)` variant of every mutation method
   referenced by the service. The variant takes a `Querier` (pool or PoolClient)
   as its first param and runs SQL via `client.query(...)`. Example pattern is
   in `src/accounts/repository.ts:createInTx`.
2. **Service:** wrap the mutation + publishEvent in `mutateAndPublishEvent`.
   The callback uses the `*InTx` repo method and returns `{ entity, eventInput }`.
3. **Test:** assert that `enqueueAny` mock throw causes the entity mutation to
   roll back (no row in DB).

Until every callsite is migrated, the residual atomicity gap is bounded by the
5-min reconciler cadence (plan §6). The reconciler republishes drift events
when PB's state and the runtime's mapping/instruction state diverge. This is
the safety net.

## Adding a new internal_agent event type

When introducing `tenant.internal_agent.<new>`:

- [ ] Add the new literal to `InternalAgentEventType` in `src/internal-agents/events.ts`
      and `InternalAgentOutboxEventType` in `src/internal-agents/outbox.ts`.
- [ ] Add the new literal to `ControlPlaneEventType` in `src/events/types.ts`.
- [ ] If the new type does NOT match the existing CHECK on
      `internal_agent_outbox.event_type` (`LIKE 'tenant.internal_agent.%'`),
      ship a new migration to relax the constraint.
- [ ] Add a handler `handleInternalAgent<New>` in
      `liftoff-tenant-runtime/src/events/subscriber.ts` and route it from the
      `SUBSCRIBED_EVENTS` switch.
- [ ] **Stale-after-delete gate**: if the new event is a state-mutating event
      for a non-tombstoned agent (anything other than `deleted`), add it to
      the switch at `subscriber.ts` ~line 302 alongside `created`/`updated`/
      `status_changed`/`runtime_config_updated`/`skills_updated`. Without
      this, a late event arriving after a `deleted` event will resurrect
      runtime state.
- [ ] **Version gate strategy**: the runtime's pre-dispatch version gate uses
      strict `>` (replays of the same version are dropped). If the new event
      may be republished by the reconciler at the SAME `entity_version` (e.g.
      after a state-only mutation that doesn't bump `current_version`), set
      envelope `entity_version=null` for the republish and carry the real
      version in `payload.entityVersion`. The handler should consume
      `payload.entityVersion ?? event.entity_version ?? <fallback>` and use
      `COALESCE($x, entity_version)` when writing back to cached state.
      Reference: `handleInternalAgentRuntimeConfigUpdated` and
      `republishForDrift` in reconciler.ts.
- [ ] Add the new event type to the union in
      `src/internal-agents/event-payload.ts`'s `buildInternalAgentEventPayload`
      so the live publish path and the reconciler produce identical payloads.
- [ ] Add an entity-version idempotency gate to the new handler (mirror
      `handleInternalAgentUpdated` pattern; reject events with
      `entity_version < cached`).
- [ ] If the drift mode is novel, extend `classifyDrift` in
      `src/internal-agents/reconciler.ts` and bump the `DriftType` union.
- [ ] Update integration test in
      `src/__tests__/integration/agent-creation-pipeline.test.ts`.
- [ ] Update `docs/runbooks/AGENT_CREATION_DRIFT.md` if the new type produces a
      new failure signature.

## Co-located secondary events

When a primary entity mutation publishes BOTH a primary event (e.g.
`tenant.internal_agent.updated`) AND a secondary event (e.g.
`tenant.internal_agent.runtime_config_updated`) describing a sub-aspect of
the same mutation, BOTH outbox rows MUST be enqueued inside the same
`mutateAndPublishEvent` callback. Otherwise a Pub/Sub publish blip between
the two enqueues can deliver one without the other, leaving downstream
consumers in an inconsistent state.

Reference implementation: `InternalAgentService.update` (service.ts), where
the secondary `runtime_config_updated` row is enqueued via
`enqueueInternalAgentOutbox(client, ...)` inside the same `mutate` callback
that enqueues the primary `updated` row, and inline-published after commit.
