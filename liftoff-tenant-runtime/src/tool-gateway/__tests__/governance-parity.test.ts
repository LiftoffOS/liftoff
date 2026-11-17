// The two dispatch paths must govern identically.
//
// WHY THIS TEST EXISTS. `execute()` handles one call; `executeBatch()` handles
// several and RE-IMPLEMENTS the governance sequence inline rather than calling
// `execute()` per operation. `executeToolCalls` sends every batchable connector
// call to the batch path, so `execute()` is the path almost nothing takes —
// which means anything added to `execute()` alone is added to nothing.
//
// Four things have been lost that way:
//
//   checkSsrfGate                — an untrusted_inbound call could batch a
//                                  private-IP URL past the gate
//   duplicate-outward-action     — never saw batched calls, so one run could
//                                  post to the same inline comment target five
//                                  times
//   BUILTIN_OUTPUT_GUARDRAILS    — `secret-scrub` did not run on a batched
//                                  connector result, so credentials in a file an
//                                  agent read reached the model verbatim
//   contentIndexer               — `connector_content` was barely written while
//                                  two readers depended on it
//
// Each is found by hand only when someone notices an absence. That is not a
// method. This test is the method.
//
// WHY SOURCE AND NOT BEHAVIOUR. The property is "both bodies perform this step",
// and source cannot lie about presence. A behavioural version would need both
// paths driven through mocks — and mocks are how this stayed hidden once
// already: `execute-batch.test.ts` mocked `getPool` but not `pool`, the export
// the duplicate guard reads, so its lookup threw, failed open, and the suite
// went green against a check that never ran. A test written against the same
// mocks would inherit the same blindness. The behavioural assertions live in
// `execute-batch.test.ts`; this one guards the boundary they cannot see.

import { readFileSync } from 'fs';
import { join } from 'path';

const SOURCE = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8').split('\n');

/** The body of a method, from its declaration to the next one at class indent. */
function methodBody(name: string): string {
  const start = SOURCE.findIndex((l) =>
    new RegExp(`^\\s+(private |public )?async ${name}\\(`).test(l));
  if (start < 0) throw new Error(`governance-parity: no method named ${name}`);
  let end = SOURCE.length;
  for (let i = start + 4; i < SOURCE.length; i++) {
    if (/^ {2}(private |public )?(async )?\w+\(/.test(SOURCE[i])) { end = i; break; }
  }
  return SOURCE.slice(start, end).join('\n');
}

/** Governance steps, and the call each path may satisfy them with.
 *
 *  A step is satisfied by ANY of its aliases, because the two paths legitimately
 *  decompose some steps differently: the serial path asks
 *  `findDuplicateOutwardAction` (target + lookup in one), while the batch path
 *  needs the target separately for its in-batch claim and so calls
 *  `guardableTarget` and `findCompletedDuplicate`. Same step, same guarantee. */
const GOVERNANCE_STEPS: Record<string, readonly string[]> = {
  'identity validation':      ['validateIdentity'],
  'SSRF gate':                ['checkSsrfGate'],
  'idempotency short-circuit':['getByIdempotencyKey'],
  'admission control':        ['checkAdmission'],
  'allowlist':                ['validateAllowlist'],
  'conflict policy':          ['getConflictPolicy'],
  'target derivation':        ['deriveAndReportTarget'],
  // `preDispatchGuards` is the serial path's spelling now: the four checks that
  // run before a dispatch were extracted so the Composio route and the batch
  // fast path could run the SAME ones rather than a copy. The batch path keeps
  // its own `findCompletedDuplicate`, because two identical calls in one batch
  // are both absent from the ledger and only `seenInBatch` sees that.
  'duplicate refusal':        ['preDispatchGuards', 'findDuplicateOutwardAction', 'findCompletedDuplicate'],
  'action-ledger intent':     ['recordIntent'],
  'output guardrails':        ['applyOutputGuardrails'],
  'content indexing':         ['indexToolResult'],
  'action-ledger outcome':    ['recordOutcome', 'backstopLedger'],
  'action-ledger failure':    ['recordFailure', 'backstopLedger'],
  'governance audit record':  ['recordToGovernance'],
  'pre-action snapshot':      ['capturePreActionSnapshot'],
};

/** Divergences that are DELIBERATE, each with the reason it is allowed.
 *
 *  Frozen debt, not a permission list. Anything here is a step the batch path
 *  does not perform, which means a guarantee the estate does not have on the
 *  path it actually uses. Removing an entry is the goal; adding one needs the
 *  same scrutiny as removing the check. */
/** Divergences that are DELIBERATE, each with the reason it is allowed.
 *
 *  Frozen debt, not a permission list. Anything here is a step the batch path
 *  does not perform, which means a guarantee the estate does not have on the
 *  path it actually uses. Removing an entry is the goal; adding one needs the
 *  same scrutiny as removing the check itself.
 *
 *  EMPTY, and that is the point. It held `pre-action snapshot` — the fifth
 *  divergence, found by this test on the day it was written — and that entry
 *  was closed rather than kept: the batch path now captures a snapshot the same
 *  way the serial path does, so a batched write has something for undo and
 *  conflict detection to restore from. */
const KNOWN_DIVERGENCE: Record<string, string> = {};

const SERIAL = methodBody('execute') + '\n' + methodBody('executeInner');
const BATCH = methodBody('executeBatch');

const performs = (body: string, aliases: readonly string[]): boolean =>
  aliases.some((a) => body.includes(`${a}(`));

describe('both dispatch paths perform the same governance', () => {
  it('has found both methods to compare', () => {
    // A rename that silently emptied this test would make it pass forever.
    expect(SERIAL.length).toBeGreaterThan(2000);
    expect(BATCH.length).toBeGreaterThan(2000);
  });

  describe.each(Object.entries(GOVERNANCE_STEPS))('%s', (step, aliases) => {
    it('is performed by the serial path', () => {
      expect(performs(SERIAL, aliases)).toBe(true);
    });

    it('is performed by the batch path — the one everything actually takes', () => {
      expect(performs(BATCH, aliases)).toBe(true);
    });
  });

  it('records every deliberate divergence with a reason', () => {
    // The value is the reason. An entry with none is a divergence nobody
    // decided on, which is indistinguishable from one nobody noticed.
    for (const [name, reason] of Object.entries(KNOWN_DIVERGENCE)) {
      expect(reason.length).toBeGreaterThan(120);
      expect(name).toBeTruthy();
    }
  });

  it('does not let a governance step be silently dropped from BOTH paths', () => {
    // The failure mode this test cannot otherwise see: deleting a check
    // everywhere keeps the two paths in perfect agreement.
    for (const [step, aliases] of Object.entries(GOVERNANCE_STEPS)) {
      expect({ step, present: performs(SERIAL + BATCH, aliases) })
        .toEqual({ step, present: true });
    }
  });
});

// ── One database accessor ────────────────────────────────────────────────────
//
// The parity test above is only as good as the seams it can see, and mocks are
// how the last divergence hid: `execute-batch.test.ts` mocked `getPool` but not
// `pool`, so the duplicate guard's lookup called a method on `undefined`,
// threw, failed open, and the suite passed against a check that never ran.
//
// `pool` is a Proxy onto `getPool()` — identical in production, and NOT
// identical under test, because a suite replaces each export independently.
// Two accessors is one for a mock to forget. This keeps the gateway on one.
describe('the gateway reads the database through one accessor', () => {
  const GATEWAY_DIR = join(__dirname, '..');
  const MODULES = [
    'service.ts', 'duplicate-outward-action.ts', 'permission-validator.ts',
    'content-indexer.ts', 'output-guardrails.ts',
  ];

  it.each(MODULES)('%s does not import the bare `pool` export', (file) => {
    let src: string;
    try {
      src = readFileSync(join(GATEWAY_DIR, file), 'utf8');
    } catch {
      // A module that no longer exists is not a violation; the list above is a
      // convenience, and `service.ts` failing to load would fail every test.
      return;
    }
    const importsBarePool = /import\s*\{[^}]*\bpool\b[^}]*\}\s*from\s*'[^']*infrastructure\/database'/.test(src);
    expect({ file, importsBarePool }).toEqual({ file, importsBarePool: false });
  });
});
