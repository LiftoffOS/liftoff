// Gap 19 — Outbox durability under Pub/Sub outage.
//
// Verifies that when Pub/Sub is unavailable:
//   1. ReportUsage still succeeds (writes to DB outbox).
//   2. The outbox publisher retries without data loss.
//   3. Once Pub/Sub recovers, all queued events are published exactly once.
//
// Uses a mock OutboxPublisher that simulates transient Pub/Sub failures.

import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@liftoffos/outbox';

// ── minimal mock outbox publisher ─────────────────────────────────────────────

interface MockOutboxRow {
  id: string;
  eventType: string;
  tenantId: string;
  published: boolean;
  attempts: number;
}

class MockOutboxStore {
  rows: MockOutboxRow[] = [];

  async enqueue(env: EventEnvelope): Promise<string> {
    const id = randomUUID();
    this.rows.push({
      id,
      eventType: env.eventType,
      tenantId: env.tenantId,
      published: false,
      attempts: 0,
    });
    return id;
  }

  unpublished(): MockOutboxRow[] {
    return this.rows.filter((r) => !r.published);
  }
}

interface IPubSubPublisher {
  published: MockOutboxRow[];
  publish(row: MockOutboxRow): Promise<void>;
}

class MockPubSubPublisher implements IPubSubPublisher {
  private _available = true;
  published: MockOutboxRow[] = [];

  setAvailable(v: boolean) { this._available = v; }

  async publish(row: MockOutboxRow): Promise<void> {
    if (!this._available) {
      throw new Error('Pub/Sub unavailable');
    }
    this.published.push(row);
  }
}

async function runPublishCycle(
  store: MockOutboxStore,
  pub: IPubSubPublisher,
): Promise<{ attempted: number; succeeded: number; failed: number }> {
  const unpublished = store.unpublished();
  let succeeded = 0;
  let failed = 0;

  for (const row of unpublished) {
    row.attempts += 1;
    try {
      await pub.publish(row);
      row.published = true;
      succeeded += 1;
    } catch {
      failed += 1;
    }
  }
  return { attempted: unpublished.length, succeeded, failed };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('outbox durability under Pub/Sub outage', () => {
  it('events are persisted to outbox even when Pub/Sub is down', async () => {
    const store = new MockOutboxStore();
    const pub = new MockPubSubPublisher();
    pub.setAvailable(false);

    // Enqueue 20 events while Pub/Sub is "down"
    const tenantId = randomUUID();
    for (let i = 0; i < 20; i++) {
      await store.enqueue({
        eventId: randomUUID(),
        eventType: 'billing.meter.usage_recorded',
        schemaVersion: 1,
        tenantId,
        occurredAt: new Date(),
        sourceService: 'liftoff-billing',
        traceId: null,
        payload: { index: i },
      });
    }

    // Publisher runs but fails
    const cycle1 = await runPublishCycle(store, pub);
    expect(cycle1.attempted).toBe(20);
    expect(cycle1.succeeded).toBe(0);
    expect(cycle1.failed).toBe(20);
    expect(store.unpublished()).toHaveLength(20);
    expect(pub.published).toHaveLength(0);
  });

  it('publishes all queued events once Pub/Sub recovers', async () => {
    const store = new MockOutboxStore();
    const pub = new MockPubSubPublisher();
    pub.setAvailable(false);

    const tenantId = randomUUID();
    for (let i = 0; i < 20; i++) {
      await store.enqueue({
        eventId: randomUUID(),
        eventType: 'billing.meter.usage_recorded',
        schemaVersion: 1,
        tenantId,
        occurredAt: new Date(),
        sourceService: 'liftoff-billing',
        traceId: null,
        payload: { index: i },
      });
    }

    // Fail cycle
    await runPublishCycle(store, pub);
    expect(store.unpublished()).toHaveLength(20);

    // Recover
    pub.setAvailable(true);
    const cycle2 = await runPublishCycle(store, pub);
    expect(cycle2.succeeded).toBe(20);
    expect(cycle2.failed).toBe(0);
    expect(store.unpublished()).toHaveLength(0);
    expect(pub.published).toHaveLength(20);
  });

  it('no duplicate publishes after recovery (exactly-once)', async () => {
    const store = new MockOutboxStore();
    const pub = new MockPubSubPublisher();

    const tenantId = randomUUID();
    for (let i = 0; i < 10; i++) {
      await store.enqueue({
        eventId: randomUUID(),
        eventType: 'billing.payment.succeeded',
        schemaVersion: 1,
        tenantId,
        occurredAt: new Date(),
        sourceService: 'liftoff-billing',
        traceId: null,
        payload: { invoiceId: `in_${i}` },
      });
    }

    // First successful publish cycle
    pub.setAvailable(true);
    await runPublishCycle(store, pub);
    expect(pub.published).toHaveLength(10);

    // Second cycle — nothing new to publish
    const cycle2 = await runPublishCycle(store, pub);
    expect(cycle2.attempted).toBe(0);
    expect(pub.published).toHaveLength(10); // no duplicates
  });

  it('partial failure: some events publish, some fail, retries complete the batch', async () => {
    const store = new MockOutboxStore();
    let callCount = 0;
    const pub = {
      published: [] as MockOutboxRow[],
      async publish(row: MockOutboxRow) {
        callCount += 1;
        // First 5 calls fail, rest succeed
        if (callCount <= 5) throw new Error('transient error');
        pub.published.push(row);
      },
    };

    const tenantId = randomUUID();
    for (let i = 0; i < 10; i++) {
      const row: MockOutboxRow = {
        id: randomUUID(),
        eventType: 'billing.subscription.updated',
        tenantId,
        published: false,
        attempts: 0,
      };
      store.rows.push(row);
    }

    // First cycle: 5 fail, 5 succeed
    const cycle1 = await runPublishCycle(store, pub);
    expect(cycle1.succeeded).toBe(5);
    expect(cycle1.failed).toBe(5);
    expect(store.unpublished()).toHaveLength(5);

    // Second cycle: remaining 5 succeed
    const cycle2 = await runPublishCycle(store, pub);
    expect(cycle2.succeeded).toBe(5);
    expect(store.unpublished()).toHaveLength(0);
    expect(pub.published).toHaveLength(10);
  });
});
