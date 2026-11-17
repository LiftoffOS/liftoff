// The HITL gate must be able to resolve a collapsed vendor tool's effect.
//
// An oversized vendor server is collapsed behind a search pair, so its members
// leave `catalog.tools` and move to `deferredVendorTools`. They remain
// dispatchable — and on claude-agent-sdk the collapse is bypassed entirely,
// since the SDK talks to the vendor server directly.
//
// The external-content gate resolves a call's `effect` from the list the gate
// is handed. A miss reads as `effect === undefined`, which fails closed. So on
// an untrusted-inbound run — which is every GitHub-triggered run, because a pull
// request title is written by whoever opened it — EVERY call to a collapsed
// vendor tool gated, including pure reads.
//
// Reported from the approval card itself:
//
//   Approval needed — Action: Read pull request #101 ...
//   github · pull_request_read
//
// `pull_request_read` classifies as 'read' and should never have gated. The
// classifier was right; the tool simply could not be found to ask.
//
// Failing closed meant this over-gated rather than under-gated, so nothing
// unsafe happened. It still asked a person to approve a read, and a queue of
// approvals that did not need approving is how people learn to approve without
// looking.

import { classifyVendorToolEffect, effectPassesUngated } from '../../tool-gateway/tool-effect';
import { resolveCatalogTool } from '../../hitl-enforcement/tool-name-resolution';

const COLLAPSED = 'github-7d07a896__pull_request_read';
const COLLAPSED_WRITE = 'github-7d07a896__add_issue_comment';

describe('a collapsed vendor tool still resolves for the gate', () => {
  it('classifies pull_request_read as a read', () => {
    // The premise: the classifier was never wrong about this name.
    expect(classifyVendorToolEffect('pull_request_read')).toBe('read');
    expect(effectPassesUngated('read')).toBe(true);
  });

  it('gates when the tool is missing from the list handed to the gate', () => {
    // The defect, reproduced: collapse removes the tool, the lookup misses, and
    // the undefined effect fails closed.
    const onlyTiered = [{ name: 'github-7d07a896__search', effect: 'read' as const }];
    const found = resolveCatalogTool(COLLAPSED, onlyTiered);
    expect(found).toBeUndefined();
    expect(effectPassesUngated(found?.effect)).toBe(false); // → gates a read
  });

  it('passes a read once the deferred tools are included', () => {
    const withDeferred = [
      { name: 'github-7d07a896__search', effect: 'read' as const },
      { name: COLLAPSED, effect: classifyVendorToolEffect('pull_request_read') },
    ];
    const found = resolveCatalogTool(COLLAPSED, withDeferred);
    expect(found?.effect).toBe('read');
    expect(effectPassesUngated(found?.effect)).toBe(true); // → no gate
  });

  it('still gates a collapsed vendor WRITE', () => {
    // The fix must not turn into a bypass: including the deferred tools makes
    // reads pass, and must leave writes gating exactly as before.
    const withDeferred = [
      { name: COLLAPSED_WRITE, effect: classifyVendorToolEffect('add_issue_comment') },
    ];
    const found = resolveCatalogTool(COLLAPSED_WRITE, withDeferred);
    expect(found?.effect).toBe('write');
    expect(effectPassesUngated(found?.effect)).toBe(false); // → gates
  });

  it('an unknown vendor tool still fails closed', () => {
    // The safety property that made this over-gate rather than under-gate.
    expect(effectPassesUngated(resolveCatalogTool('github-7d07a896__mystery', [])?.effect)).toBe(false);
  });

  it('the service merges deferredVendorTools into the gate list', () => {
    // Asserted at the source, because the behavioural path needs the whole
    // execution service and a live vendor probe.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'service.ts'), 'utf8');
    const at = src.indexOf('state.cachedModelTools = [');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at - 600, at + 200)).toMatch(/deferredVendorTools/);
  });
});
