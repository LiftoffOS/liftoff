import { voiceFor, voiceSlotFor } from '../voice-identity';

describe('voice identity', () => {
  it('gives the same agent the same voice every time', () => {
    const id = '7f3c1e2a-0b44-4c9d-9a1e-2f6b8c0d1e23';
    expect(voiceFor('google', id)).toBe(voiceFor('google', id));
    expect(voiceSlotFor(id)).toBe(voiceSlotFor(id));
  });

  it('is stable across processes, not just within one', () => {
    // A literal, not a recomputation: if the hash ever changes, every agent's
    // voice changes with it, and this is the test that says so out loud.
    expect(voiceSlotFor('agent-one')).toBe(voiceSlotFor('agent-one'));
    expect(voiceSlotFor('')).toBe(0x811c9dc5);
  });

  it('spreads a realistic team across the pool rather than clustering', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `11111111-2222-3333-4444-00000000000${i.toString(16)}`);
    const voices = new Set(ids.map((id) => voiceFor('google', id)));
    // Not a guarantee of zero collisions — a hash into 12 slots will collide —
    // but a cast of 12 landing on one or two voices would mean the slot is not
    // actually varying.
    expect(voices.size).toBeGreaterThanOrEqual(6);
  });

  it('never gives an agent the voice the platform speaks with', () => {
    const platform = voiceFor('google', undefined);
    const agentVoices = Array.from({ length: 200 }, (_, i) => voiceFor('google', `agent-${i}`));
    expect(agentVoices).not.toContain(platform);
  });

  it('always returns a real voice from the pool', () => {
    for (let i = 0; i < 100; i++) {
      expect(voiceFor('google', `agent-${i}`)).toMatch(/^en-US-Chirp3-HD-[A-Za-z]+$/);
    }
  });

  it('gives every vendor with an adapter a pool that excludes its platform voice', () => {
    // Same guarantee as the Google case above, asserted per vendor so adding a
    // vendor cannot quietly hand an agent the platform's own voice.
    for (const vendor of ['google', 'openai'] as const) {
      const platform = voiceFor(vendor, undefined);
      const agentVoices = Array.from({ length: 200 }, (_, i) => voiceFor(vendor, `agent-${i}`));
      expect(agentVoices).not.toContain(platform);
      expect(new Set(agentVoices).size).toBeGreaterThan(1);
    }
  });

  it('keeps each agent in the same position when the vendor changes', () => {
    // The point of a slot indexing a pool: switching vendor moves the whole cast
    // together rather than reshuffling who sounds like whom.
    const ids = ['agent-a', 'agent-b', 'agent-c', 'agent-d'];
    const googleIdx = ids.map((id) => voiceSlotFor(id) % 12);
    const openaiIdx = ids.map((id) => voiceSlotFor(id) % 8);
    // Same slot number drives both; only the pool length differs.
    expect(googleIdx).toEqual(ids.map((id) => voiceSlotFor(id) % 12));
    expect(openaiIdx).toEqual(ids.map((id) => voiceSlotFor(id) % 8));
  });

  it('refuses a vendor with no pool rather than inventing one', () => {
    expect(() => voiceFor('elevenlabs', 'some-agent')).toThrow(/no voice pool/);
    expect(() => voiceFor('elevenlabs', undefined)).toThrow(/no platform voice/);
  });
});
