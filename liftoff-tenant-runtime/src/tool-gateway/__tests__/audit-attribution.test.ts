// Every tool call this gateway records says WHICH CONVERSATION it happened in,
// and WHAT came back.
//
// The audit trail is what a person reads to find work an agent did. Two of the
// three sites here recorded neither. The Composio dispatch — which is how every
// Composio-backed connector runs, Google Docs included — wrote the agent, the
// action and the arguments, then `outcome: 'success'` with no evidence and no
// thread.
//
// A sweep that creates several documents through that path leaves rows with
// `thread_id` NULL and `output_summary` NULL, so the platform's own record of
// creating them cannot say which conversation they belonged to or where they
// went. The person cannot find their report.
//
// A comment on the native path in this same file states why evidence is
// mandatory: "a green row said a call happened and nothing about what came
// back". That rule went into the path carrying a fraction of the traffic. This
// asserts it on all of them.

import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(join(__dirname, '..', 'mcp-server.ts'), 'utf8');

/** Each insertAuditLog call's property block. */
function auditCalls(): string[] {
  const calls: string[] = [];
  for (const m of source.matchAll(/insertAuditLog\(null, tenantId, \{/g)) {
    const end = source.indexOf('})', m.index!);
    calls.push(source.slice(m.index!, end));
  }
  return calls;
}

describe('what every audit row from this gateway carries', () => {
  it('finds all of the audit sites', () => {
    expect(auditCalls().length).toBeGreaterThanOrEqual(3);
  });

  it('names the conversation, at EVERY site', () => {
    // The property is destructured at the top of this file and was simply
    // unused. Nothing failed; the rows were just unattributable.
    for (const call of auditCalls()) {
      expect(call).toMatch(/^\s*threadId,\s*$/m);
    }
  });

  it('records what came back, at every site', () => {
    // Including the success paths. A row that says only "this happened" cannot
    // be checked against anything, and cannot surface the artifact it made.
    for (const call of auditCalls()) {
      expect(call).toContain('outputSummary');
    }
  });

  it('keeps the Composio path carrying its result, not a bare claim', () => {
    const composio = auditCalls().find(c => c.includes('auditAction'));
    expect(composio).toBeDefined();
    expect(composio!).toContain('composioOutput');
  });
});
