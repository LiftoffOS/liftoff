// A tool failure must say which connector it came from.
//
// Vendor errors identify the vendor's own objects and know nothing about ours.
// Composio's is:
//
//   Connected account "ca_…" not found
//
// and recoveryFor('not_found') is "The target does not exist. Re-check the
// id/reference…". Neither string names the connector. recoveryFor DOES name it
// for auth_expired and permission_denied ("the <type> connector needs to be
// reconnected"), so the gap is specific to the other codes — and a 404
// classifies to not_found.
//
// An agent cannot attribute an opaque `ca_…` id. An agent reading this error
// off a SLACK send can conclude GitHub is broken and escalate to a human over
// and over — "GitHub access cannot be established — reconnect ca_…" — while
// GitHub is healthy and has no Composio account at all, sending somebody to
// reconnect the wrong integration.
//
// The message is what the model reads most directly, so the attribution travels
// there.
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(__dirname, '..', 'execute-dispatcher.ts'), 'utf8');

/** The in-band failure branch added with ExecutorResult.failure. */
function failureBranch(): string {
  const start = src.indexOf('if (outcome.failure)');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('const response = create(ExecuteResponseSchema', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('in-band failure message', () => {
  it('prefixes the connector type and tool name', () => {
    expect(failureBranch()).toContain(
      '`${info.connectorType}.${functionName}: ${outcome.failure.message}`',
    );
  });

  it('does not pass the bare vendor message through', () => {
    // The exact regression: `outcome.failure.message` handed over unadorned is
    // a string with no connector in it.
    const branch = failureBranch();
    expect(branch).not.toMatch(/toolError\([^)]*\n\s*outcome\.failure\.message,/);
  });

  it('still carries the structured context for recoveryFor', () => {
    // The prefix is additive. connectorType must keep reaching recoveryFor, or
    // auth_expired loses "the <type> connector needs to be reconnected".
    expect(failureBranch()).toContain('connectorType: info.connectorType');
    expect(failureBranch()).toContain('toolName: functionName');
  });

  it('still classifies off the vendor text, not the prefixed string', () => {
    // classifyError pattern-matches the message. Feeding it the prefixed
    // version would let a connector named e.g. "notfound_crm" change the code.
    expect(failureBranch()).toContain('classifyError({ message: outcome.failure.message })');
  });
});
