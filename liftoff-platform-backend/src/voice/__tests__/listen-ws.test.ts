// What rate the listening socket decodes against.
//
// It used to be the constant 48000 for everybody. That is right on most
// desktops, wrong on a 44.1 kHz Windows machine, and badly wrong on a Bluetooth
// headset in hands-free mode: measured end to end, its 16 kHz read as 48 kHz
// produced an empty transcript and a session that reported hearing no audio —
// on exactly the device someone puts on to hold a conversation.

jest.mock('../../infrastructure/secrets', () => ({
  getOpenAIApiKey: jest.fn().mockResolvedValue('test-key'),
}));

import { _captureRateFrom } from '../listen-ws';

describe('capture rate declared by the client', () => {
  it('takes the rate the browser says it is capturing at', () => {
    expect(_captureRateFrom('16000')).toBe(16000);
    expect(_captureRateFrom('44100')).toBe(44100);
    expect(_captureRateFrom('48000')).toBe(48000);
  });

  it('falls back to 48000 for a client that has not been updated to say', () => {
    // Which is the rate those clients were already assumed to be sending, so an
    // older tab behaves exactly as it did rather than newly failing.
    expect(_captureRateFrom(null)).toBe(48000);
    expect(_captureRateFrom('')).toBe(48000);
  });

  it('refuses a rate no microphone produces rather than trusting the query string', () => {
    // It arrives on a URL, so it is attacker-controlled. A wild value would be
    // handed to a vendor as a decoding hint, or make the adapter throw and take
    // the session with it.
    for (const junk of ['0', '-48000', '1e9', 'NaN', 'abc', '48000.5', '7999', '96001']) {
      expect(_captureRateFrom(junk)).toBe(48000);
    }
  });
});
