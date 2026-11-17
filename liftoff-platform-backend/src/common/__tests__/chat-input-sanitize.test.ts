import {
  stripControlChars,
  sanitizeChatMessageContent,
} from '../chat-input-sanitize';

// Built with fromCharCode rather than literal escapes so the control bytes
// under test survive editing and code review intact.
const NUL = String.fromCharCode(0x00);
const SOH = String.fromCharCode(0x01);
const STX = String.fromCharCode(0x02);
const DEL = String.fromCharCode(0x7f);

describe('stripControlChars', () => {
  it('strips C0 control characters but preserves tab, LF, CR', () => {
    const input = `hi${NUL} there\t\n\r world${SOH}`;
    expect(stripControlChars(input)).toBe('hi there\t\n\r world');
  });

  it('strips the DEL character', () => {
    expect(stripControlChars(`a${DEL}b`)).toBe('ab');
  });

  it('returns the string unchanged when no control chars are present', () => {
    expect(stripControlChars('plain text 123')).toBe('plain text 123');
  });
});

describe('sanitizeChatMessageContent', () => {
  it('strips control chars and trims whitespace', () => {
    expect(sanitizeChatMessageContent(`  hello world${NUL}  `)).toBe('hello world');
  });

  it('returns empty string when input is only control characters', () => {
    expect(sanitizeChatMessageContent(`${NUL}${SOH}${STX}`)).toBe('');
  });

  // The regression this module was changed for. Each of these was written to
  // the database, and handed to the model, as an HTML entity.
  it('leaves an apostrophe alone', () => {
    expect(sanitizeChatMessageContent("What's the best beer garden in Berlin"))
      .toBe("What's the best beer garden in Berlin");
  });

  it('leaves an ampersand alone', () => {
    expect(sanitizeChatMessageContent('Fish & Chips')).toBe('Fish & Chips');
  });

  it('leaves quotes and angle brackets alone', () => {
    expect(sanitizeChatMessageContent('compare <a> to "b"')).toBe('compare <a> to "b"');
  });

  // Escaping was not composable: content sanitized once at the router and
  // again when carried into a delegate's thread gained an `amp;` each pass.
  it('is idempotent', () => {
    const once = sanitizeChatMessageContent('Terms & Conditions');
    expect(sanitizeChatMessageContent(once)).toBe(once);
  });
});
