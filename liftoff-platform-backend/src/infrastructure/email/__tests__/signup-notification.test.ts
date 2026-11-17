// Render tests for the signup-notification building blocks: buildOutlineButton
// (the "Waitlist" secondary button) and the signup-notification template body.

import { buildEmail, buildOutlineButton } from '../builder';

describe('buildOutlineButton', () => {
  it('renders a neutral GREY outline button (matches the site .btn--outline), not the accent', () => {
    const html = buildOutlineButton('Waitlist', 'https://app.example.com/signup-approval?token=t');
    expect(html).toContain('>Waitlist</a>');
    expect(html).toContain('border:1px solid #c4c4c4'); // grey border
    expect(html).toContain('color:#595959'); // grey font
    // No orange accent anywhere — that was the inconsistency being fixed.
    expect(html).not.toContain('#FB411F');
  });

  it('escapes ampersands in the href so email clients keep the button tappable', () => {
    const html = buildOutlineButton('Waitlist', 'https://x/y?token=t&intent=waitlist');
    expect(html).toContain('href="https://x/y?token=t&amp;intent=waitlist"');
  });
});

describe('signup-notification template', () => {
  it('renders the injected rawHtml body under a "New signup" heading', () => {
    const { html } = buildEmail('signup-notification', {
      firstName: '',
      rawHtml: '<p id="probe">signup details</p>',
    });
    expect(html).toContain('New signup');
    expect(html).toContain('<p id="probe">signup details</p>');
  });
});
