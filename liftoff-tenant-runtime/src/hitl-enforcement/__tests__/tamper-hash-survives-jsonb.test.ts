// The tamper hash must survive the round-trip through `jsonb`.
//
// `pending_tool_calls` is a jsonb column. jsonb does NOT store keys in the order
// they were written — it normalizes them (shortest key first, then bytewise). So
// the object read back is not the object written, and a plain `JSON.stringify`
// hashed one string on write and a different one on read.
//
// The hash therefore could never match for any tool call whose input had two or
// more keys not already in jsonb's order. Approving one threw TAMPER_DETECTED
// from approveRequest — an unhandled throw, so the RPC returned a bare HTTP 500
// with no message, on both surfaces that call it.
//
// For example, a Slack escalation with `{channel, text}`:
//
//   stored hash                          A
//   recomputed from the row as read      B   (jsonb order: text, channel)
//   recomputed in the written key order  A   exact match
//
// The third line is the proof: the stored value is correct and only the key
// order differs. No retry can help, which is why it fails identically from
// Slack and from /dashboard/review.
//
// Sorting recursively makes the hash a function of the VALUE, which is what
// tamper detection is about. Key order was never part of the claim.

import { hitlEnforcementService } from '../service';

type Call = { id: string; name: string; input: Record<string, unknown> };

const h = (calls: Call[]) => hitlEnforcementService.hashToolCalls(calls as never);

describe('key order does not change the hash', () => {
  it('matches across the exact reordering jsonb performs', () => {
    const written: Call[] = [{
      id: 'call-1',
      name: 'agent_slack__slack_send_message',
      input: { channel: '#customer-support', text: 'Support escalation' },
    }];
    // jsonb returns the shorter key first: text (4) before channel (7).
    const readBack: Call[] = [{
      id: 'call-1',
      name: 'agent_slack__slack_send_message',
      input: { text: 'Support escalation', channel: '#customer-support' },
    }];
    expect(h(readBack)).toBe(h(written));
  });

  it('sorts nested objects too, not just the top level', () => {
    // A tool input is frequently nested, and jsonb normalizes at every level.
    const a: Call[] = [{ id: 'c', name: 't', input: { outer: { zeta: 1, alpha: { yy: 2, xx: 3 } } } }];
    const b: Call[] = [{ id: 'c', name: 't', input: { outer: { alpha: { xx: 3, yy: 2 }, zeta: 1 } } }];
    expect(h(b)).toBe(h(a));
  });

  it('is stable across repeated calls', () => {
    const c: Call[] = [{ id: 'c', name: 't', input: { b: 1, a: 2 } }];
    expect(h(c)).toBe(h(c));
  });
});

describe('it still detects an actual change', () => {
  it('differs when a value changes', () => {
    const a: Call[] = [{ id: 'c', name: 't', input: { channel: '#ops', text: 'hello' } }];
    const b: Call[] = [{ id: 'c', name: 't', input: { channel: '#ops', text: 'goodbye' } }];
    expect(h(b)).not.toBe(h(a));
  });

  it('differs when a key is added or removed', () => {
    const a: Call[] = [{ id: 'c', name: 't', input: { channel: '#ops' } }];
    const b: Call[] = [{ id: 'c', name: 't', input: { channel: '#ops', text: 'x' } }];
    expect(h(b)).not.toBe(h(a));
  });

  it('differs when the tool name changes', () => {
    // The whole point: the same arguments pointed at a different tool.
    const a: Call[] = [{ id: 'c', name: 'slack_send_message', input: { channel: '#ops' } }];
    const b: Call[] = [{ id: 'c', name: 'gmail__send_email', input: { channel: '#ops' } }];
    expect(h(b)).not.toBe(h(a));
  });

  it('differs when call order changes', () => {
    // Array order is meaningful — these are calls to dispatch in sequence — so
    // only OBJECT keys are sorted.
    const one: Call = { id: '1', name: 'a', input: {} };
    const two: Call = { id: '2', name: 'b', input: {} };
    expect(h([two, one])).not.toBe(h([one, two]));
  });
});
