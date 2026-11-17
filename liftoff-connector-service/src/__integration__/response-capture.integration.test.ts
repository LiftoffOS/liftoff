// Phase 4 capture — integration test against a real Postgres.
//
// Exercises captureResponseSample end-to-end against the real
// `connector_response_samples` table (migration 018): the redaction, the
// adapter-envelope unwrap, ON CONFLICT first-write-wins, and the JSONB
// round-trip — none of which the mocked-pool unit test
// (response-capture.test.ts) can prove.
//
// The admin pool connects as the harness `connector_app` user, which owns
// every table created by the docker-compose init SQL, so the INSERT/SELECT
// here need no extra grant. Secret Manager is never touched.
//
// Prereq: `docker-compose -f docker-compose.integration.yml up -d`
//         (if the volume predates migration 018, `down -v && up -d` to
//          re-run init SQL so the table exists).
// Runner: `npm run test:integration`

import { getAdminPool, closeAllPools } from '../db/pool.js';
import { captureResponseSample, _resetCaptured } from '../observability/response-capture.js';

const CT = 'bamboohr';
const FN = 'get_employees_directory';
const READ_FN = { categories: ['read'] as const };

// A read dispatch reaches the hook as the adapter's ExternalRecord envelope
// `{ id, data: <raw vendor body> }`; capture unwraps to the raw body before storing.
const envelope = (email: string) => ({
  id: 'generated',
  data: {
    employees: [
      { id: '1', displayName: 'Jane Doe', workEmail: email },
      { id: '2', displayName: 'John Roe', workEmail: 'john.roe@example.com' },
    ],
  },
});

async function rows(): Promise<Array<{ connector_type: string; function_name: string; sample: unknown }>> {
  const pool = await getAdminPool();
  const r = await pool.query('SELECT connector_type, function_name, sample FROM connector_response_samples ORDER BY function_name');
  return r.rows;
}

describe('captureResponseSample (real Postgres, migration 018)', () => {
  beforeEach(async () => {
    _resetCaptured(); // clear the per-process short-circuit between cases
    const pool = await getAdminPool();
    await pool.query('DELETE FROM connector_response_samples');
  });

  afterAll(async () => {
    const pool = await getAdminPool();
    await pool.query('DELETE FROM connector_response_samples');
    await closeAllPools();
  });

  it('records exactly one redacted, unwrapped sample for a native read', async () => {
    await captureResponseSample(CT, FN, READ_FN, envelope('jane.doe@example.com'));

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].connector_type).toBe(CT);
    expect(all[0].function_name).toBe(FN);

    // Stored the unwrapped raw body ({ employees: [...] }), not the { id, data } envelope.
    const sample = all[0].sample as { employees?: Array<Record<string, unknown>> };
    expect(Array.isArray(sample.employees)).toBe(true);
    expect(sample.employees).toHaveLength(2);

    // PII redacted before write — no raw email survives anywhere in the JSONB.
    const serialized = JSON.stringify(sample);
    expect(serialized).not.toContain('jane.doe@example.com');
    expect(serialized).not.toContain('john.roe@example.com');
  });

  it('is first-write-wins: a later, different payload never overwrites the first', async () => {
    await captureResponseSample(CT, FN, READ_FN, envelope('first@example.com'));
    const first = (await rows())[0].sample as { employees: Array<{ id: string }> };
    expect(first.employees).toHaveLength(2);

    // A second capture for the SAME action with a different (larger) body. Reset the per-process
    // short-circuit so the DB-level ON CONFLICT DO NOTHING is what enforces idempotency.
    _resetCaptured();
    await captureResponseSample(CT, FN, READ_FN, {
      id: 'generated',
      data: { employees: [{ id: '9', displayName: 'Later Person', workEmail: 'later@example.com' }] },
    });

    const all = await rows();
    expect(all).toHaveLength(1); // still one row
    const kept = all[0].sample as { employees: Array<{ id: string }> };
    expect(kept.employees).toHaveLength(2); // the ORIGINAL body, untouched
    expect(kept.employees.map((e) => e.id).sort()).toEqual(['1', '2']);
  });

  it('never writes for a write/mutating function', async () => {
    await captureResponseSample(CT, 'create_time_off_request', { categories: ['write'] }, envelope('x@example.com'));
    expect(await rows()).toHaveLength(0);
  });

  it('the per-process short-circuit skips the second DB round-trip for the same action', async () => {
    await captureResponseSample(CT, FN, READ_FN, envelope('a@example.com'));
    // No _resetCaptured() here — the in-process Set should short-circuit before any INSERT.
    await captureResponseSample(CT, FN, READ_FN, envelope('b@example.com'));
    expect(await rows()).toHaveLength(1);
  });
});
