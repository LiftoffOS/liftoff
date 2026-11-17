// opencode's built-in tools must not reach the model, and a permission prompt
// must not be approved.
//
// This engine's governance lives in ONE place: every tool it may use arrives
// through the `liftoff` MCP server, where dispatchFunctionCall applies the HITL
// gate, the oversight policy, untrusted framing, OU metering and the
// single-result bound. opencode's own built-ins never touch that proxy — which
// is exactly why the server raises a permission prompt for them.
//
// The adapter used to answer that prompt with `once`, commented "the Liftoff
// gate already ran in the httpMcp proxy". It had not: the prompt existed
// because it had not. That waved through an ungoverned shell running as root in
// the runtime's container under the runtime's service account, and `read` alone
// reached /proc and the application source without needing one.
//
// Static assertions rather than a live server: starting one spawns a Bun
// process and this is a property of the CONFIG and the handler, both of which
// are readable. A behavioural test would need the binary and would not fail on
// the thing that actually regressed here — a comment's reasoning drifting away
// from what the code does.

import { readFileSync } from 'fs';
import { join } from 'path';

const SOURCE = readFileSync(
  join(__dirname, '..', 'opencode', 'index.ts'),
  'utf8',
);

describe('the opencode server config', () => {
  it('denies the dangerous permission categories', () => {
    // The backstop for a built-in this adapter has never heard of: a future
    // opencode release's new tool still lands in one of these categories.
    //
    // Read off the DERIVED permission block rather than matched in the source.
    // The literals it used to look for are gone: the permission map is now built
    // from the deny list, so the two cannot disagree about a tool — which is
    // what a text match here was standing in for.
    expect(SOURCE).toMatch(/Object\.fromEntries\(Object\.keys\(OPENCODE_BUILTIN_TOOLS_DENIED\)/);
    expect(SOURCE).toMatch(/external_directory:\s*'deny'/);
    for (const category of ['bash', 'edit', 'webfetch']) {
      expect(SOURCE).toMatch(new RegExp(`\\n\\s+${category}: false,`));
    }
  });

  it('switches off every built-in by name', () => {
    // A per-name map with no wildcard: a tool the list does not name stays ON,
    // so the list is the enumeration and the permission block is the net.
    // `question` is in this list because it is the one whose absence does not
    // leak anything — it deadlocks the turn, waiting for a person who is not there.
    for (const tool of ['bash', 'edit', 'write', 'patch', 'read', 'grep', 'glob', 'webfetch', 'websearch', 'question', 'skill', 'lsp', 'apply_patch']) {
      expect(SOURCE).toMatch(new RegExp(`\\n\\s+${tool}: false,`));
    }
  });

  it('passes the deny map to the server', () => {
    expect(SOURCE).toMatch(/tools:\s*OPENCODE_BUILTIN_TOOLS_DENIED/);
  });
});

describe('the permission handler', () => {
  it('rejects rather than approves', () => {
    expect(SOURCE).toMatch(/response:\s*'reject'/);
    // The exact shape of the defect. `once` here is what waved the shell
    // through, so its absence is the regression this file exists to catch.
    expect(SOURCE).not.toMatch(/response:\s*'once'/);
    expect(SOURCE).not.toMatch(/response:\s*'always'/);
  });

  it('logs the refusal, because reaching that branch means a built-in escaped both nets', () => {
    // Not noise. A prompt arriving at all says an opencode release added a
    // capability this adapter has not classified — the signal that the deny map
    // above needs an entry.
    expect(SOURCE).toMatch(/opencode_builtin_tool_denied/);
  });

  it('no longer claims the Liftoff gate ran for built-in tools', () => {
    // The comment was the bug. It justified approving on a premise that was
    // exactly inverted, and it read as considered rather than mistaken.
    expect(SOURCE).not.toMatch(/auto-approve them since the\s*\n?\s*\/\/ Liftoff gate already ran/);
    expect(SOURCE).not.toMatch(/Liftoff gate already ran in the httpMcp proxy\./);
  });
});
