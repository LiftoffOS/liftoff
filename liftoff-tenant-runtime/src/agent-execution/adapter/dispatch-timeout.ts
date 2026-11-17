// How long one MCP `tools/call` may take. Split out of mcp-bridge.ts so a
// caller that only needs the number (the opencode adapter's server config)
// does not have to load the bridge.

import { CODE_SESSION_DEFAULT_TIMEOUT_SECONDS } from './tools/code-session/types';

/** How long a single `tools/call` may take.
 *
 *  The MCP SDK's own default is 60 seconds, and nothing here used to override
 *  it — so every tool in the catalog shared a one-minute ceiling regardless of
 *  what it does. `code_session` advertises `timeout_seconds` up to 600 and
 *  enforces it inside the handler, which made the two disagree by an order of
 *  magnitude: the runner kept working, the transport gave up, and the model was
 *  told `-32001 Request timed out` for a session that then completed unseen.
 *  Provisioning an isolated sandbox alone can take most of a minute cold.
 *
 *  So a call that DECLARES its own budget is given it, plus a margin for the
 *  work either side of the vendor process (clone, preset read, diff capture,
 *  teardown). Everything else keeps a fixed ceiling — raised off the SDK
 *  default, because 60s was set by a library, not by anything we measured.
 *
 *  A ceiling is still a ceiling: it exists so a hung tool cannot hold a turn
 *  open forever, and it must never be removed in favour of waiting forever. */
const MCP_DISPATCH_TIMEOUT_MS = Number(process.env.MCP_DISPATCH_TIMEOUT_MS) || 180_000;
const MCP_DISPATCH_MARGIN_MS = 60_000;

export function dispatchTimeoutMs(args: unknown): number {
  const declared = Number((args as { timeout_seconds?: unknown } | undefined)?.timeout_seconds);
  if (Number.isFinite(declared) && declared > 0) {
    return declared * 1000 + MCP_DISPATCH_MARGIN_MS;
  }
  return MCP_DISPATCH_TIMEOUT_MS;
}

/** The ceiling for a transport that cannot be told a budget per call.
 *
 *  opencode (the outer engine for Grok and the open-weights families) reaches
 *  this bridge through the `liftoff` remote MCP server, and it calls every tool
 *  on that server with ONE timeout: the server's configured `timeout`, or the
 *  MCP SDK's 60-second default when none is set. So it has to cover the longest
 *  call the bridge itself will wait for — code_session at its default budget,
 *  plus the bridge's margin — or the engine abandons a call the bridge is still
 *  serving (`MCP error -32001: Request timed out`).
 *
 *  A call that declares a LONGER budget than code_session's default is still
 *  bounded here: this is a per-server ceiling, not a per-call one. */
export function longestDispatchTimeoutMs(): number {
  return Math.max(
    MCP_DISPATCH_TIMEOUT_MS,
    dispatchTimeoutMs({ timeout_seconds: CODE_SESSION_DEFAULT_TIMEOUT_SECONDS }),
  );
}
