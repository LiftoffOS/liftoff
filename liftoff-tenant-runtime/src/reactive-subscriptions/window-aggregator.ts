// Fixed-bucket window aggregator.
//
// Upserts into reactive_subscription_windows, returning {matched, value}.
// Bucket is current-tick truncated to durationSeconds. Expires_at is bucket+2
// to handle late events arriving up to one full window after the bucket
// closes; the prune Cloud Run Job cleans up rows once expires_at < NOW()-1h.

import { getPool } from '../infrastructure/database';
import type { WindowSpec } from '../agent-lifecycle/types';

export async function aggregate(
  subscriptionId: string,
  spec: WindowSpec,
  event: { data: Record<string, unknown> },
): Promise<{ matched: boolean; value: number }> {
  const pool = getPool();
  const now = Date.now();
  const bucket = Math.floor(now / (spec.durationSeconds * 1000));
  const windowId = String(bucket);
  const expiresAt = new Date((bucket + 2) * spec.durationSeconds * 1000);

  const fieldVal = spec.field ? Number(resolve(event.data, spec.field)) : 1;
  if (Number.isNaN(fieldVal)) return { matched: false, value: NaN };

  const updated = await pool.query<{ count: string; sum_value: string; min_value: string | null; max_value: string | null }>(
    `INSERT INTO reactive_subscription_windows (subscription_id, window_id, count, sum_value, min_value, max_value, expires_at)
     VALUES ($1,$2,1,$3,$3,$3,$4)
     ON CONFLICT (subscription_id, window_id) DO UPDATE SET
       count = reactive_subscription_windows.count + 1,
       sum_value = reactive_subscription_windows.sum_value + EXCLUDED.sum_value,
       min_value = LEAST(reactive_subscription_windows.min_value, EXCLUDED.sum_value),
       max_value = GREATEST(reactive_subscription_windows.max_value, EXCLUDED.sum_value)
     RETURNING count, sum_value, min_value, max_value`,
    [subscriptionId, windowId, fieldVal, expiresAt]
  );

  const row = updated.rows[0];
  let value: number;
  switch (spec.aggregate) {
    case 'count': value = Number(row.count); break;
    case 'sum':   value = Number(row.sum_value); break;
    case 'avg':   value = Number(row.sum_value) / Number(row.count); break;
    case 'rate':  value = Number(row.count) / spec.durationSeconds; break;
    case 'min':   value = Number(row.min_value); break;
    case 'max':   value = Number(row.max_value); break;
  }

  const matched = ({
    gt:  () => value > spec.threshold.value,
    gte: () => value >= spec.threshold.value,
    lt:  () => value < spec.threshold.value,
    lte: () => value <= spec.threshold.value,
  })[spec.threshold.comparator]();

  return { matched, value };
}

function resolve(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, p) => (cur == null ? cur : (cur as Record<string, unknown>)[p]), obj);
}
