// Every standard tool must have a STATED side-effect class.
//
// `classifyVendorToolEffect` derives an effect from the tool's NAME, and its
// rule 3 sends any unrecognised verb to 'write' so an unknown tool gates. That
// is right for VENDOR tools, whose names arrive from a third party. It is wrong
// for ours, which we name ourselves and whose behaviour we know exactly.
//
// 19 of the 36 standard tools hit that default, because the verb vocabulary has
// no entry for research, extract, diff, landscape, retrieve, screenshot or
// check. A support agent looking for a Help Center article calls
// `web_research`, and the run pauses for approval with reason
// `external_content_write`. It is a SEARCH — it writes
// nothing, sends nothing, and reaches no customer.
//
// The ratchet below is the part that matters going forward: a new standard tool
// with no entry fails here, rather than silently defaulting to 'write' and
// gating a read in production months later.

import { STANDARD_TOOLS } from '../standard-tools';
import { STANDARD_TOOL_EFFECTS } from '../../tool-gateway/tool-effect';

describe('every standard tool is classified', () => {
  it('has an entry for each tool, so none falls back to the name guess', () => {
    const missing = STANDARD_TOOLS.map(t => t.name).filter(n => !(n in STANDARD_TOOL_EFFECTS));
    expect(missing).toEqual([]);
  });

  it('classifies nothing that is not a standard tool', () => {
    // A stale entry is a tool that was renamed or removed, and it would sit
    // here looking authoritative while applying to nothing.
    const names = new Set(STANDARD_TOOLS.map(t => t.name));
    expect(Object.keys(STANDARD_TOOL_EFFECTS).filter(n => !names.has(n))).toEqual([]);
  });

  it('uses only the three valid classes', () => {
    for (const [name, effect] of Object.entries(STANDARD_TOOL_EFFECTS)) {
      expect(['read', 'write', 'spawn']).toContain(effect);
      expect(typeof name).toBe('string');
    }
  });
});

describe('the tools that were being gated as writes', () => {
  it.each([
    'web_research',
    'web_deep_research',
    'web_extract',
    'web_diff',
    'tabular_extract',
    'data_landscape',
    'memory_retrieve',
    'screenshot_browser_session',
    'check_browser_intervention_pending',
    'read_browser_session_activity',
    'read_browser_session_controls',
  ])('%s is a read', (name) => {
    expect(STANDARD_TOOL_EFFECTS[name]).toBe('read');
  });
});

describe('what must stay gated', () => {
  it.each([
    // Changes state, or reaches a person or a third party.
    'memory_save',
    'note_save',
    'note_delete',
    'audit_log',
    'notifications_send',
    'web_session_save',
    'web_session_forget',
    'web_identity_connect',
    // One action on the shared browser, and the request for the person to
    // take it over: a side effect on the session, and a person reached.
    'act_in_browser_session',
    'ask_person_to_take_over_browser_session',
  ])('%s is a write', (name) => {
    expect(STANDARD_TOOL_EFFECTS[name]).toBe('write');
  });

  it.each([
    // An autonomous browser agent decides what it does at run time, so the tool
    // cannot promise it only looks — whatever the model intends when it calls.
    'web_task',
    'run_browser_task',
  ])('%s is a write, because it cannot bound itself', (name) => {
    expect(STANDARD_TOOL_EFFECTS[name]).toBe('write');
  });

  it('leaves the test-only failure injector to the name-based fallback', () => {
    // It is not in STANDARD_TOOLS outside test builds, so an entry would be a
    // stale key. classifyVendorToolEffect returns 'write' for it, and gating a
    // failure injector is the right outcome.
    expect('__fail_once__' in STANDARD_TOOL_EFFECTS).toBe(false);
  });

  it.each(['start_browser_session', 'schedule_followup'])('%s is a spawn', (name) => {
    expect(STANDARD_TOOL_EFFECTS[name]).toBe('spawn');
  });
});
