// How long one `tools/call` may take.
//
// The MCP SDK defaults a request to 60 seconds and the bridge passed no
// override, so every tool in the catalog shared a one-minute ceiling whatever
// it does. `code_session` advertises `timeout_seconds` up to 600 and enforces
// that inside the handler, so the two disagreed by an order of magnitude: the
// runner kept working while the transport gave up, and the model was handed
// `MCP error -32001: Request timed out` for a session that went on to finish
// unseen. Provisioning the isolated sandbox alone measured 45 seconds cold.
//
// The property is one-directional and worth stating plainly: the transport
// ceiling must never be SHORTER than the budget the call itself declares.

import { dispatchTimeoutMs } from '../mcp-bridge';

/** The SDK's own default, which is what the bridge used to inherit. */
const SDK_DEFAULT_MS = 60_000;

describe('MCP dispatch timeout', () => {
  it('honours a budget the call declares, with margin', () => {
    // code_session's own default. 60s would abandon it at a tenth of its life.
    const ms = dispatchTimeoutMs({ timeout_seconds: 600 });
    expect(ms).toBeGreaterThan(600 * 1000);
  });

  it('never gives a declared budget less than it asked for', () => {
    for (const declared of [90, 300, 600, 900]) {
      expect(dispatchTimeoutMs({ timeout_seconds: declared })).toBeGreaterThanOrEqual(declared * 1000);
    }
  });

  it('clears the SDK default for a call that declares nothing', () => {
    // A tool with no declared budget still has to outlast a cold sandbox start.
    expect(dispatchTimeoutMs({})).toBeGreaterThan(SDK_DEFAULT_MS);
    expect(dispatchTimeoutMs(undefined)).toBeGreaterThan(SDK_DEFAULT_MS);
  });

  it('ignores a nonsense budget rather than trusting it', () => {
    // These arguments come from a model, so they are not to be believed. A
    // zero or negative would otherwise mean "give up immediately", and NaN
    // would propagate into the transport as an invalid timeout.
    for (const bad of [0, -1, 'soon', null, NaN, Infinity]) {
      expect(dispatchTimeoutMs({ timeout_seconds: bad })).toBeGreaterThan(SDK_DEFAULT_MS);
    }
  });

  it('is a ceiling, not an absence of one', () => {
    // A hung tool must not hold the turn open forever.
    expect(Number.isFinite(dispatchTimeoutMs({}))).toBe(true);
    expect(Number.isFinite(dispatchTimeoutMs({ timeout_seconds: 600 }))).toBe(true);
  });
});
