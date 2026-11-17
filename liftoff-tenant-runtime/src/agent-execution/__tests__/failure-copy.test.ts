// What the person is told when a run dies.
//
// The contract this pins is narrow and absolute: `failureMessageForUser` is
// always safe to display. Before it existed the chat error frame carried
// `execResult.error` — a vendor SDK string, a Postgres error, an internal
// assertion — and the web client defended with a single prefix regex.

import { failureMessageForUser } from '../failure-classification';
import type { FailureClass } from '../../invocations/types';

const ALL_CLASSES: FailureClass[] = [
  'transient_infra',
  'agent_declined',
  'timeout',
  'stalled',
  'tool_error',
  'validation',
  'unknown',
  'task_failed',
  'recovery_declined',
];

describe('failureMessageForUser', () => {
  it('has copy for every failure class', () => {
    // A class with no copy would fall through to the generic sentence, which
    // is safe but silently drops whatever the classifier worked out. The
    // Record type catches this at compile time; this catches a class added to
    // the union at runtime via a DB value the type never saw.
    for (const c of ALL_CLASSES) {
      expect(failureMessageForUser(c)).toBeTruthy();
    }
  });

  it('never leaks internal vocabulary', () => {
    // The exact words the web client had to pattern-match around, plus the
    // shapes that mean a raw error got through.
    const forbidden = [
      /chat turn/i, /invocation/i, /adapter/i, /sdk/i, /postgres/i, /sql/i,
      /undefined/i, /null/i, /stack/i, /econnrefused/i, /\berr\b/i, /exception/i,
    ];
    for (const c of ALL_CLASSES) {
      const copy = failureMessageForUser(c);
      for (const pattern of forbidden) {
        expect(copy).not.toMatch(pattern);
      }
    }
  });

  it('reads as a finished sentence to a non-technical person', () => {
    for (const c of ALL_CLASSES) {
      const copy = failureMessageForUser(c);
      expect(copy.length).toBeGreaterThan(20);
      expect(copy).toMatch(/[.!]$/);
      // Product voice: never say "agent" to a user.
      expect(copy).not.toMatch(/\bagents?\b/i);
    }
  });

  it('distinguishes the cases a user would act on differently', () => {
    // The whole reason for classifying: one generic sentence told the person
    // nothing. Busy, too-long and malformed all need different next actions.
    const infra = failureMessageForUser('transient_infra');
    const timeout = failureMessageForUser('timeout');
    const validation = failureMessageForUser('validation');
    expect(new Set([infra, timeout, validation]).size).toBe(3);
    expect(timeout).toMatch(/smaller|shorter|break/i);
    expect(validation).toMatch(/rephras|reword/i);
  });

  it('falls back to the generic sentence for a class outside the union', () => {
    // Reached when a value read from the DB predates the current union.
    // Falling back to raw error text here would defeat the whole function.
    const copy = failureMessageForUser('something_new' as FailureClass);
    expect(copy).toBe(failureMessageForUser('unknown'));
  });
});
