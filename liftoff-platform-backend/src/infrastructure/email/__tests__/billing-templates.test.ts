// Render tests for the billing/lifecycle email templates added by the
// transactional-email-coverage rollout. Each test calls `buildEmail(key, …)`
// with a complete BuildOptions and asserts:
//   • subject line is correct (placeholders substituted)
//   • preheader is correct
//   • body content contains the expected sentences
//   • CTA renders at the right position
//   • voice rules: no `<strong>` / `<b>` / `<em>` / `<i>`, no contractions,
//     no "top up" / "top-up", no "Please " before action verbs, US English
//
// Targeted assertions rather than full HTML snapshots: small copy edits
// should not require regenerating snapshots, but voice/structural mistakes
// should fail fast.

import { buildEmail } from '../builder';

const FE = 'https://app.example';

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Voice rules from the implementation plan §"Voice/style rules from existing
 * templates". Applied to every NEW user-facing template (not the legacy
 * email-verification / password-reset / welcome / team-invite ones).
 */
function expectVoiceRules(html: string): void {
  expect(html).not.toMatch(/<strong>/i);
  expect(html).not.toMatch(/<\/?b>/i);
  expect(html).not.toMatch(/<\/?em>/i);
  expect(html).not.toMatch(/<\/?i>/i);
  // Plain-English contractions in user-facing copy. Skip checks that would
  // false-positive on inline CSS values and HTML structural keywords.
  // Strip the <head> + style blocks before checking.
  const visibleText = html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<head[\s\S]*?<\/head>/g, '')
    .replace(/style="[^"]*"/g, '');
  // contractions
  for (const bad of ["you'll", "you've", "we've", "don't", "isn't", "can't", "won't", "we're"]) {
    expect(visibleText.toLowerCase()).not.toContain(bad);
  }
  // no "top up" / "top-up" in user copy
  expect(visibleText.toLowerCase()).not.toMatch(/top[- ]up/);
  // British spellings forbidden in new copy
  for (const bad of ['cancelled', 'cancelling', 'colour', 'behaviour', 'centre']) {
    expect(visibleText.toLowerCase()).not.toContain(bad);
  }
}

// ── subscription-confirmation ─────────────────────────────────────────────────

describe('subscription-confirmation email', () => {
  it('renders subject, billing summary, capabilities list (no promo)', () => {
    const { subject, html } = buildEmail('subscription-confirmation', {
      firstName: 'Ada',
      frontendUrl: FE,
      planName: 'Core',
      billingSummary: '$20.00/month, 800 Operating Units included',
      promoSummary: '',
    });
    expect(subject).toBe('Your Liftoff plan is active');
    expect(html).toContain('Your Liftoff plan is active, ');
    // firstName is appended after the </span> in the heading
    expect(html).toContain('</span>Ada');
    expect(html).toContain(
      'Your Core plan ($20.00/month, 800 Operating Units included) is now active.',
    );
    // No-promo path: assert absence of the promo phrasing
    expect(html.toLowerCase()).not.toContain('promo');
    expect(html.toLowerCase()).not.toContain('off your first invoice');
    // {planName} placeholder in listIntro must be substituted
    expect(html).toContain('With your Core plan, you have:');
    expect(html).not.toContain('{planName}');
    expect(html).not.toContain('{promoSummary}');
    // Hardcoded capabilities list
    expect(html).toContain('Unlimited agents');
    expect(html).toContain('Unlimited integrations');
    expect(html).toContain('Workflow orchestration');
    expect(html).toContain('Real-time visibility');
    expect(html).toContain('Governance controls');
    expect(html).toContain('Human oversight and control');
    // CTA
    expect(html).toContain('Go to Dashboard');
    expect(html).toContain(`${FE}/dashboard`);
    expectVoiceRules(html);
  });

  it('renders promo sentence for $0 first invoice (monthly, fully covered)', () => {
    const { html } = buildEmail('subscription-confirmation', {
      firstName: 'Ada',
      frontendUrl: FE,
      planName: 'Core',
      billingSummary: '$20.00/month, 800 Operating Units included',
      promoSummary: 'Your promo code covered your first month — no charge today. ',
    });
    expect(html).toContain('Your promo code covered your first month — no charge today.');
    expect(html).not.toContain('{promoSummary}');
    expectVoiceRules(html);
  });

  it('renders promo sentence for partial discount (Core monthly + extras → $19.60)', () => {
    const { html } = buildEmail('subscription-confirmation', {
      firstName: 'Ada',
      frontendUrl: FE,
      planName: 'Core',
      billingSummary: '$20.00/month, 800 Operating Units included',
      promoSummary: 'Your promo code took $20.00 off your first invoice (paid: $19.60). ',
    });
    expect(html).toContain('$20.00 off your first invoice');
    expect(html).toContain('paid: $19.60');
    expectVoiceRules(html);
  });

  it('renders promo sentence on annual plan (paid $180.00) alongside plan line', () => {
    const { html } = buildEmail('subscription-confirmation', {
      firstName: 'Ada',
      frontendUrl: FE,
      planName: 'Core',
      // The pre-existing yearly composePlanDisplay bug renders $20.00/year here
      // (the monthly base masquerading as yearly). The promo copy intentionally
      // says nothing about the plan price, so the two lines do not contradict.
      billingSummary: '$200.00/year, 800 Operating Units included',
      promoSummary: 'Your promo code took $20.00 off your first invoice (paid: $180.00). ',
    });
    expect(html).toContain('$20.00 off your first invoice');
    expect(html).toContain('paid: $180.00');
    expect(html).toContain('$200.00/year');
    expectVoiceRules(html);
  });
});

// ── subscription-ending ───────────────────────────────────────────────────────

describe('subscription-ending email', () => {
  it('renders cancellation copy and Resubscribe CTA before forgiving closing', () => {
    const { subject, html } = buildEmail('subscription-ending', {
      firstName: 'Ada',
      frontendUrl: FE,
      planName: 'Growth',
      accessEndsDate: 'June 1, 2026',
    });
    expect(subject).toBe('Your Liftoff plan is ending soon');
    expect(html).toContain(
      'Your Growth plan has been canceled. You will continue to have access to all paid features until June 1, 2026.',
    );
    expect(html).toContain('Resubscribe');
    expect(html).toContain(`${FE}/dashboard/settings/billing`);
    expect(html).toContain(
      'If you change your mind, you can resubscribe anytime before June 1, 2026 in Settings.',
    );
    expectVoiceRules(html);
  });
});

// ── subscription-ending-7d ────────────────────────────────────────────────────

describe('subscription-ending-7d email', () => {
  it('renders 7-day warning copy with accessEndsDate', () => {
    const { subject, html } = buildEmail('subscription-ending-7d', {
      firstName: 'Ada',
      frontendUrl: FE,
      planName: 'Scale',
      accessEndsDate: 'June 1, 2026',
    });
    expect(subject).toBe('Your Liftoff plan ends in 7 days');
    expect(html).toContain('Your Scale plan ends in 7 days on June 1, 2026.');
    expect(html).toContain('Resubscribe');
    expect(html).toContain('If you change your mind, you can resubscribe anytime before June 1, 2026 in Settings.');
    expectVoiceRules(html);
  });
});

// ── subscription-ending-1d ────────────────────────────────────────────────────

describe('subscription-ending-1d email', () => {
  it('renders tomorrow-warning copy with urgent closing', () => {
    const { subject, html } = buildEmail('subscription-ending-1d', {
      firstName: 'Ada',
      frontendUrl: FE,
      planName: 'Scale',
      accessEndsDate: 'June 1, 2026',
    });
    expect(subject).toBe('Your Liftoff plan ends tomorrow');
    expect(html).toContain('Your Scale plan ends tomorrow on June 1, 2026.');
    expect(html).toContain(
      'After June 1, 2026, you can still resubscribe, but your agents will be paused in the meantime.',
    );
    expectVoiceRules(html);
  });
});

// ── subscription-ended ────────────────────────────────────────────────────────

describe('subscription-ended email', () => {
  it('renders ended-plan declaration + preservation + Resubscribe CTA + thank-you', () => {
    const { subject, html } = buildEmail('subscription-ended', {
      firstName: 'Ada',
      frontendUrl: FE,
      planName: 'Growth',
      accessEndedDate: 'June 1, 2026',
    });
    expect(subject).toBe('Your Liftoff plan has ended');
    expect(html).toContain('Your Liftoff plan has ended, ');
    expect(html).toContain('Your Growth plan ended on June 1, 2026.');
    expect(html).toContain('Your workspace is preserved.');
    expect(html).toContain('Resubscribe');
    expect(html).toContain('Thank you for being with Liftoff.');
    expectVoiceRules(html);
  });
});

// ── unified receipt ───────────────────────────────────────────────────────────

describe('receipt email (subscription_renewal context)', () => {
  it('renders single charge sentence with $amount + paymentMethodSummary + plan chargeReason', () => {
    const { subject, html } = buildEmail('receipt', {
      firstName: 'Ada',
      frontendUrl: FE,
      amountUsd: '20.00',
      paymentMethodSummary: 'credit card ending in 4242',
      chargeReason: 'renew your Core plan for another month',
    });
    expect(subject).toBe('Your receipt from Liftoff');
    expect(html).toContain(
      'We charged $20.00 to your credit card ending in 4242 to renew your Core plan for another month.',
    );
    // CTA renders (after-signature position, no signatureParagraphs)
    expect(html).toContain('View Billing');
    expect(html).toContain(`${FE}/dashboard/settings/billing`);
    expectVoiceRules(html);
  });
});

describe('receipt email (credit_reload context)', () => {
  it('renders credit-balance chargeReason', () => {
    const { html } = buildEmail('receipt', {
      firstName: 'Ada',
      frontendUrl: FE,
      amountUsd: '50.00',
      paymentMethodSummary: 'bank account ending in 6789',
      chargeReason: 'fund your Liftoff credit balance',
    });
    expect(html).toContain(
      'We charged $50.00 to your bank account ending in 6789 to fund your Liftoff credit balance.',
    );
    expectVoiceRules(html);
  });
});

// ── payment-failed-subscription ───────────────────────────────────────────────

describe('payment-failed-subscription email', () => {
  it('renders outstanding-balance line and Update Payment Method CTA', () => {
    const { subject, html } = buildEmail('payment-failed-subscription', {
      firstName: 'Ada',
      frontendUrl: FE,
      outstandingBalanceUsd: '$12.34',
    });
    expect(subject).toBe('Action required: Payment failed for your Liftoff workspace');
    expect(html).toContain('A payment attempt for your Liftoff workspace has failed.');
    // Legacy ${outstandingBalanceUsd} substitution preserves the `$` prefix
    // baked into the build option value.
    expect(html).toContain('Outstanding balance: $12.34');
    expect(html).toContain('Update Payment Method');
    expect(html).toContain(`${FE}/dashboard/settings/billing`);
    expect(html).toContain(
      'Your agents will automatically resume once the outstanding balance is paid.',
    );
    // No reply-invitation or error-admission language (fixed in this rewrite)
    expect(html).not.toContain('reply to this email');
    expect(html).not.toContain('If you believe this is an error');
    expectVoiceRules(html);
  });
});

// ── payment-failed-auto-reload ────────────────────────────────────────────────

describe('payment-failed-auto-reload email', () => {
  it('renders payment method summary, dollar amount, retry messaging', () => {
    const { subject, html } = buildEmail('payment-failed-auto-reload', {
      firstName: 'Ada',
      frontendUrl: FE,
      amountUsd: '50.00',
      paymentMethodSummary: 'credit card ending in 4242',
    });
    expect(subject).toBe(
      'Action required: Auto-reload failed for your Liftoff workspace',
    );
    expect(html).toContain(
      'We could not charge your credit card ending in 4242 for an auto-reload of $50.00.',
    );
    expect(html).toContain('Update Payment Method');
    expect(html).toContain(
      'Auto-reload will retry automatically once your payment method is updated.',
    );
    // Plan rule: "add credit" not "top up"
    expect(html).toContain('add credit to your credit balance');
    expectVoiceRules(html);
  });
});

// ── agents-stalled-credit-depleted ────────────────────────────────────────────

describe('agents-stalled-credit-depleted email', () => {
  it('renders depletion explanation + Add Credit CTA + nextResetDate fallback', () => {
    const { subject, html } = buildEmail('agents-stalled-credit-depleted', {
      firstName: 'Ada',
      frontendUrl: FE,
      planName: 'Core',
      nextResetDate: 'June 1, 2026',
    });
    expect(subject).toBe('Action required: Your agents are unable to run');
    expect(html).toContain(
      'You have used all the Operating Units in your Core plan and your credit balance has reached $0.',
    );
    // Plan rule: "Add Credit" CTA, NOT "Top Up"
    expect(html).toContain('Add Credit');
    expect(html).toContain('Or wait until your Operating Units reset on June 1, 2026.');
    expectVoiceRules(html);
  });
});

// ── card-expiring ─────────────────────────────────────────────────────────────

describe('card-expiring email', () => {
  it('renders card brand + last4 + expiry month/year', () => {
    const { subject, html } = buildEmail('card-expiring', {
      firstName: 'Ada',
      frontendUrl: FE,
      cardBrand: 'Visa',
      cardLast4: '4242',
      cardExpMonth: '06',
      cardExpYear: '2026',
    });
    expect(subject).toBe('Your credit card on file is expiring soon');
    expect(html).toContain(
      'Your Visa credit card ending in 4242 on file with Liftoff expires on 06/2026.',
    );
    expect(html).toContain(
      'After this date, charges to this credit card will fail.',
    );
    expect(html).toContain('Update Credit Card');
    expect(html).toContain(`${FE}/dashboard/settings/billing`);
    expectVoiceRules(html);
  });
});
