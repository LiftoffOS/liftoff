// The gate's three states are all observable.
//
// Written because the first version emitted only `would_block`, and a metric
// with one observable state cannot be read. `would_block == 0` meant either
// "every write was provenanced" or "the gate never evaluated anything" —
// opposite conclusions from identical telemetry, and the second one is exactly
// the failure this whole effort keeps finding: a quiet signal taken for
// coverage.
//
// So a run has to be traceable end to end: what was RECORDED, which writes
// PASSED, which were FLAGGED, and which were NOT JUDGED at all. Four states,
// four events, one invocationId threading them.

import {
  recordProvenance,
  checkWriteProvenance,
  reportProvenance,
  seedProvenanceFromTrigger,
  _resetProvenanceForTesting,
} from '../record-provenance';
import { logger } from '../../infrastructure/logging';

const INVOCATION = 'inv-observability';

/** Every structured log the code under test emitted, flattened, each tagged
 *  with the LEVEL it was emitted at.
 *
 *  The level is part of what these assertions are about. `provenance_pass` and
 *  `provenance_not_judged` were emitted at `debug` while every deployment runs
 *  at `info`, so the denominator this file exists to protect was never
 *  collected — and this test passed throughout, because it spied on `debug` and
 *  read the call directly. Capturing all three levels and asserting the level
 *  is what closes that gap. */
async function captureLogs(fn: () => unknown): Promise<Array<Record<string, unknown>>> {
  const seen: Array<Record<string, unknown>> = [];
  const grab = (level: string) => (o: unknown): void => {
    if (o && typeof o === 'object') seen.push({ ...(o as Record<string, unknown>), _level: level });
  };
  const debug = jest.spyOn(logger, 'debug').mockImplementation((grab('debug')) as never);
  const info = jest.spyOn(logger, 'info').mockImplementation((grab('info')) as never);
  const warn = jest.spyOn(logger, 'warn').mockImplementation((grab('warn')) as never);
  try { await fn(); } finally { debug.mockRestore(); info.mockRestore(); warn.mockRestore(); }
  return seen;
}

/** The level a deployment actually collects. Anything the readiness report
 *  needs has to be at or above it. */
const COLLECTED = new Set(['info', 'warn', 'error']);

const events = (logs: Array<Record<string, unknown>>): unknown[] => logs.map((l) => l.event);

beforeEach(async () => {
  _resetProvenanceForTesting();
  process.env.PROVENANCE_GATE_MODE = 'shadow';
});

describe('every state a run passes through is emitted', () => {
  it('says what it recorded, and how many', async () => {
    const logs = await captureLogs(() => recordProvenance({
      invocationId: INVOCATION,
      declaration: { returnsIds: [{ entityType: 'message', path: 'items[].id' }] },
      payload: {},
      result: { items: [{ id: 'm1' }, { id: 'm2' }] },
      isWrite: false,
    }));

    const rec = logs.find((l) => l.event === 'provenance_recorded');
    expect(rec).toBeDefined();
    expect(rec!.added).toBe(2);
    expect(rec!.invocationId).toBe(INVOCATION);
  });

  it('says nothing when a call recorded nothing', async () => {
    // A read with no returnsIds contributes nothing, and saying "recorded 0"
    // on every such call would bury the lines that matter.
    const logs = await captureLogs(() => recordProvenance({
      invocationId: INVOCATION,
      declaration: {},
      payload: {},
      result: { items: [{ id: 'm1' }] },
      isWrite: false,
    }));
    expect(events(logs)).not.toContain('provenance_recorded');
  });

  it('says the trigger seeded it', async () => {
    const logs = await captureLogs(() => seedProvenanceFromTrigger({
      invocationId: INVOCATION,
      payload: { object_attributes: { iid: 4127 } },
    }));
    const seeded = logs.find((l) => l.event === 'provenance_seeded');
    expect(seeded).toBeDefined();
    expect(seeded!.invocationId).toBe(INVOCATION);
  });

  it('says a judged write PASSED', async () => {
    // The denominator. Without this line there is no way to tell a clean run
    // from a gate that never ran.
    await recordProvenance({
      invocationId: INVOCATION,
      declaration: { returnsIds: [{ entityType: 'thread', path: 'id' }] },
      payload: {},
      result: { id: 't1' },
      isWrite: false,
    });
    const verdict = await checkWriteProvenance({
      invocationId: INVOCATION,
      declaration: { idArgs: ['thread_id'], entityType: 'thread' },
      payload: { thread_id: 't1' },
    });

    const logs = await captureLogs(() => reportProvenance({
      mode: 'shadow',
      verdict,
      connector: 'gmail',
      actionType: 'reply_to_thread',
      tenantId: 't',
      agentId: 'a',
      invocationId: INVOCATION,
    }));

    const pass = logs.find((l) => l.event === 'provenance_pass');
    expect(pass).toBeDefined();
    expect(pass!.metric).toBe('provenance.checked');
    // At a level the environment keeps. This is the denominator — without it
    // `would_block == 0` cannot be told from "the gate never ran", which is the
    // ambiguity the whole event exists to remove.
    expect(COLLECTED.has(pass!._level as string)).toBe(true);
  });

  it('says a flagged write was flagged, and names the identifier', async () => {
    // A count says a write was unprovenanced; the value says WHICH record it
    // was about, which is the difference between a metric somebody can act on
    // and one they can only watch.
    const verdict = await checkWriteProvenance({
      invocationId: INVOCATION,
      declaration: { idArgs: ['thread_id'], entityType: 'thread' },
      payload: { thread_id: 'never-read' },
    });
    // No entry at all is "not judged"; seed one so the check really runs.
    await recordProvenance({
      invocationId: INVOCATION,
      declaration: { returnsIds: [{ entityType: 'thread', path: 'id' }] },
      payload: {}, result: { id: 'something-else' }, isWrite: false,
    });
    const real = await checkWriteProvenance({
      invocationId: INVOCATION,
      declaration: { idArgs: ['thread_id'], entityType: 'thread' },
      payload: { thread_id: 'never-read' },
    });
    expect(verdict.basis).toBe('no_declaration'); // no entry yet
    expect(real.provenanced).toBe(false);

    const logs = await captureLogs(() => reportProvenance({
      mode: 'shadow',
      verdict: real,
      connector: 'gmail',
      actionType: 'reply_to_thread',
      tenantId: 't',
      agentId: 'a',
      invocationId: INVOCATION,
    }));

    const blocked = logs.find((l) => l.event === 'provenance_would_block');
    expect(blocked).toBeDefined();
    expect(blocked!.unseen).toEqual(['never-read']);
    expect(blocked!.invocationId).toBe(INVOCATION);
  });

  it('distinguishes NOT JUDGED from passed', async () => {
    // The state that must never be reported as a pass: a write nobody declared
    // id arguments for was not checked, and counting it as clean is the same
    // lie as counting it as dirty.
    const logs = await captureLogs(() => reportProvenance({
      mode: 'shadow',
      verdict: { provenanced: true, basis: 'no_declaration', unseen: [] },
      connector: 'monday',
      actionType: 'update_column_value',
      tenantId: 't',
      agentId: 'a',
      invocationId: INVOCATION,
    }));

    expect(events(logs)).toContain('provenance_not_judged');
    expect(events(logs)).not.toContain('provenance_pass');
  });
});
