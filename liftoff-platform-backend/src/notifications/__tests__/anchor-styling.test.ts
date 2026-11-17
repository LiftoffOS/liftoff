// Verifies styleAnchorsInHtml — newsletter operators don't have to remember
// to inline-style their links; the server adds the brand color + no-underline
// to any <a> tag that doesn't already declare its own style attribute.

import { styleAnchorsInHtml } from '../email';

describe('styleAnchorsInHtml', () => {
  it('adds brand inline style to bare <a> tags', () => {
    const html = '<p>Click <a href="https://example.com">here</a> to continue.</p>';
    const out = styleAnchorsInHtml(html);
    expect(out).toContain('style="color:#FB411F;text-decoration:none;"');
    expect(out).toContain('href="https://example.com"');
  });

  it('handles multiple anchors in one body', () => {
    const html = '<a href="/a">A</a> and <a href="/b">B</a>';
    const out = styleAnchorsInHtml(html);
    expect(out.match(/style="color:#FB411F/g)).toHaveLength(2);
  });

  it('preserves existing attributes (target, rel, class) when injecting style', () => {
    const html = '<a href="/x" target="_blank" rel="noopener">x</a>';
    const out = styleAnchorsInHtml(html);
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener"');
    expect(out).toContain('style="color:#FB411F');
  });

  it('respects an explicit style on the operator anchor (does not double-style)', () => {
    // If an operator wants a custom style they get it; we only fill in the gap.
    const html = '<a href="/x" style="color:#0000ff;">x</a>';
    const out = styleAnchorsInHtml(html);
    expect(out).toBe(html);
  });

  it('respects an explicit style even when followed by other attributes', () => {
    const html = '<a style="color:red" href="/x">x</a>';
    const out = styleAnchorsInHtml(html);
    expect(out).toBe(html);
  });

  it('is case-insensitive for the <A> tag name', () => {
    const html = '<A HREF="/x">x</A>';
    const out = styleAnchorsInHtml(html);
    expect(out).toContain('style="color:#FB411F');
  });

  it('leaves non-anchor markup alone', () => {
    const html = '<p>Just text</p><strong>bold</strong>';
    const out = styleAnchorsInHtml(html);
    expect(out).toBe(html);
  });
});
