// What of a Stagehand step is kept for the record, per tool: the value the
// step entered where the policy allows it, the class where it does not, the
// safe URL, the two-pass grouping per page, the outcome pass over the
// closing message, and the flags that keep a partial or redacted trail from
// reading as exact.

import {
  projectStagehandSteps,
  projectStagehandTrail,
  sanitizeStagehandOutcome,
  STEP_ACTION_CAP,
  STEP_TYPE_CAP,
} from '../step-policy';

const act = (description: string, method: string, args: string[], pageUrl = 'https://a.example/issues') => ({
  type: 'act', action: `${method} ${description}`, reasoning: 'why', pageUrl,
  playwrightArguments: { method, description, arguments: args, selector: 'xpath=//x' },
});

describe('act by shape', () => {
  it('keeps the entered value for a value-bearing method on an ordinary page: fill, type, selectOptionFromDropdown', () => {
    const { steps } = projectStagehandSteps([
      act('the search box', 'fill', ['browser']),
      act('the search box', 'type', ['quarterly report']),
      act('the status dropdown', 'selectOptionFromDropdown', ['Open']),
    ]);
    expect(steps.map((s) => s.action)).toEqual([
      'fill · the search box · "browser"',
      'type · the search box · "quarterly report"',
      'selectOptionFromDropdown · the status dropdown · "Open"',
    ]);
    for (const step of steps) expect(step).toMatchObject({ protectedDataOmitted: false, protectedKind: '', pageUrl: 'https://a.example/issues' });
  });

  it('a press argument is a key action, not entered text', () => {
    const { steps } = projectStagehandSteps([act('the search box', 'press', ['Enter'])]);
    expect(steps[0].action).toBe('press · the search box · Enter');
  });

  it('a click by shape keeps what was clicked, and a shape with one of method or description keeps that one', () => {
    expect(projectStagehandSteps([act('the About section', 'click', [])]).steps[0].action).toBe('click · the About section');
    expect(projectStagehandSteps([{ type: 'act', action: 'x', playwrightArguments: { description: 'the search box' } }]).steps[0].action)
      .toBe('the search box');
    expect(projectStagehandSteps([{ type: 'act', action: 'x', playwrightArguments: { method: 'press' } }]).steps[0].action).toBe('press');
  });

  it('omits the value of a protected description and names the class: password, card, SSN', () => {
    const { steps, protectedLiterals } = projectStagehandSteps([
      act('the password field', 'fill', ['hunter2-secret'], 'https://a.example/account/security'),
      act('the card number field', 'fill', ['4111 1111 1111 1111'], 'https://shop.example/checkout'),
      act('the SSN field', 'type', ['123-45-6789'], 'https://hr.example/onboarding'),
    ]);
    expect(steps.map((s) => s.action)).toEqual([
      'fill · the password field · (authentication value not recorded)',
      'fill · the card number field · (payment value not recorded)',
      'type · the SSN field · (sensitive_identity value not recorded)',
    ]);
    expect(steps.map((s) => s.protectedKind)).toEqual(['authentication', 'payment', 'sensitive_identity']);
    expect(steps.every((s) => s.protectedDataOmitted)).toBe(true);
    expect([...protectedLiterals]).toEqual(['hunter2-secret', '4111 1111 1111 1111', '123-45-6789']);
    expect(JSON.stringify(steps)).not.toMatch(/hunter2|4111|123-45/);
  });

  it('classifies from the ORIGINAL page URL: a sign-in page omits every value on it, the username included', () => {
    const { steps } = projectStagehandSteps([
      act('the email field', 'fill', ['jane@acme.example'], 'https://a.example/login'),
      act('the password field', 'fill', ['hunter2'], 'https://a.example/login'),
    ]);
    expect(steps[0].action).toBe('fill · the email field · (authentication value not recorded)');
    expect(steps[1].action).toBe('fill · the password field · (authentication value not recorded)');
  });

  it('a failed act has no structured shape: its phrase is kept, with a literal the policy already named removed', () => {
    const { steps } = projectStagehandSteps([
      act('the password field', 'fill', ['hunter2-secret'], 'https://a.example/account'),
      { type: 'act', action: 'retry typing hunter2-secret into the password field', pageUrl: 'https://a.example/account' },
    ]);
    expect(steps[1].action).toBe('retry typing [redacted] into the password field');
    expect(steps[1]).toMatchObject({ protectedDataOmitted: true, protectedKind: 'sensitive_text' });
  });

  it('a phrase that carries a labelled protected value with no structured shape is caught by the text sanitizer', () => {
    const { steps } = projectStagehandSteps([{ type: 'act', action: 'enter OTP 123456 in the box', pageUrl: 'https://a.example/x' }]);
    expect(steps[0].action).toBe('enter OTP [redacted] in the box');
    expect(steps[0].protectedDataOmitted).toBe(true);
  });
});

describe('fillForm, two passes per page', () => {
  it('keeps each non-protected value beside its action', () => {
    const { steps } = projectStagehandSteps([{
      type: 'fillForm', pageUrl: 'https://a.example/new-issue',
      fields: [
        { action: 'fill the title field', value: 'Search does not find archived issues' },
        { action: 'fill the labels field', value: 'bug' },
      ],
    }]);
    expect(steps[0].action).toBe('fill the title field "Search does not find archived issues"; fill the labels field "bug"');
    expect(steps[0].protectedDataOmitted).toBe(false);
  });

  it('an authentication field protects every value in the fillForm and every sibling value-bearing act on that page', () => {
    const { steps } = projectStagehandSteps([
      act('the company field', 'fill', ['Acme'], 'https://a.example/register'),
      {
        type: 'fillForm', pageUrl: 'https://a.example/register',
        fields: [
          { action: 'fill the email field', value: 'jane@acme.example' },
          { action: 'fill the password field', value: 'hunter2' },
        ],
      },
      act('the search box', 'fill', ['browser'], 'https://a.example/issues'),
    ]);
    expect(steps[0].action).toBe('fill · the company field · (authentication value not recorded)');
    expect(steps[1].action).toBe('fill the email field (authentication value not recorded); fill the password field (authentication value not recorded)');
    // A different page is not touched by the first page's sign-in.
    expect(steps[2].action).toBe('fill · the search box · "browser"');
    expect(JSON.stringify(steps)).not.toMatch(/hunter2|jane@acme|Acme/);
  });

  it('payment and high-risk identity protect only the matching fields: a billing address survives beside an omitted card', () => {
    const { steps } = projectStagehandSteps([{
      type: 'fillForm', pageUrl: 'https://shop.example/checkout',
      fields: [
        { action: 'fill the name on card field', value: 'Jane Doe' },
        { action: 'fill the card number field', value: '4111 1111 1111 1111' },
        { action: 'fill the CVV field', value: '123' },
        { action: 'fill the street address field', value: '221B Baker Street' },
        { action: 'fill the city field', value: 'London' },
      ],
    }]);
    expect(steps[0].action).toBe(
      'fill the name on card field (payment value not recorded); fill the card number field (payment value not recorded); '
      + 'fill the CVV field (payment value not recorded); fill the street address field "221B Baker Street"; fill the city field "London"',
    );
    expect(steps[0]).toMatchObject({ protectedDataOmitted: true, protectedKind: 'payment' });
  });

  it('removes the exact structured value from the action phrase too, without relying on a quoted-value regex', () => {
    const { steps } = projectStagehandSteps([{
      type: 'fillForm', pageUrl: 'https://a.example/account',
      fields: [{ action: 'type hunter2 into the password field', value: 'hunter2' }],
    }]);
    expect(steps[0].action).toBe('type [redacted] into the password field (authentication value not recorded)');
  });
});

describe('the other tools', () => {
  it('goto: the safe destination URL, resource ids and query kept, a token replaced with its flag', () => {
    const { steps } = projectStagehandSteps([
      { type: 'goto', url: 'https://a.example/orders/3f2a91b8c07d4e65/edit?tab=1' },
      { type: 'goto', url: 'https://a.example/reset-password/3f2a91b8c07d4e659a1b0d3e5f7a9b1c?token=abc' },
    ]);
    expect(steps[0].action).toBe('https://a.example/orders/3f2a91b8c07d4e65/edit?tab=1');
    expect(steps[0].protectedDataOmitted).toBe(false);
    expect(steps[1].action).toBe('https://a.example/reset-password/[redacted]?token=[redacted]');
    expect(steps[1].protectedDataOmitted).toBe(true);
  });

  it('pageUrl is the safe projection with its own flags', () => {
    const { steps } = projectStagehandSteps([act('the box', 'click', [], 'https://a.example/oauth/callback?code=abc&state=s')]);
    expect(steps[0].pageUrl).toBe('https://a.example/oauth/callback?code=[redacted]&state=[redacted]');
    expect(steps[0].pageUrlProtectedDataOmitted).toBe(true);
    expect(projectStagehandSteps([{ type: 'act', action: 'x', pageUrl: 42 }]).steps[0].pageUrl).toBe('');
  });

  it('extract: the instruction, bounded; the schema is not copied', () => {
    const { steps } = projectStagehandSteps([{ type: 'extract', instruction: 'read the total ' + 'x'.repeat(3000), schema: { type: 'object' } }]);
    expect(steps[0].action).toHaveLength(STEP_ACTION_CAP);
    expect(steps[0].actionTruncated).toBe(true);
    expect(steps[0].action).not.toContain('object');
  });

  it('navback, scroll, wait, screenshot, ariaTree, close: the operation plus a short non-content status', () => {
    const one = (a: Record<string, unknown>) => projectStagehandSteps([a as { type: string }]).steps[0].action;
    expect(one({ type: 'navback', reasoning: 'wrong page' })).toBe('navback');
    expect(one({ type: 'scroll', pixels: 400, direction: 'down' })).toBe('scroll down');
    expect(one({ type: 'scroll', pixels: 400 })).toBe('scroll');
    expect(one({ type: 'wait', timeMs: 1500 })).toBe('wait 1500ms');
    expect(one({ type: 'wait' })).toBe('wait');
    expect(one({ type: 'screenshot' })).toBe('screenshot');
    expect(one({ type: 'ariaTree' })).toBe('ariaTree');
    expect(one({ type: 'close', reasoning: 'done', success: true })).toBe('close');
  });

  it('an unknown future tool: the bounded type and an empty action, its arguments not copied', () => {
    const { steps } = projectStagehandSteps([{ type: 'upload' + 'x'.repeat(100), path: '/tmp/secret.pdf', action: 'phrase' }]);
    expect(steps[0].type).toHaveLength(STEP_TYPE_CAP);
    expect(steps[0].action).toBe('');
  });

  it('never copies reasoning, and reports every step with the five completeness fields and a null time', () => {
    const { steps } = projectStagehandSteps([act('the box', 'click', [])]);
    expect(JSON.stringify(steps)).not.toContain('why');
    expect(steps[0]).toEqual({
      type: 'act', action: 'click · the box', pageUrl: 'https://a.example/issues',
      actionTruncated: false, pageUrlTruncated: false, protectedDataOmitted: false, protectedKind: '', pageUrlProtectedDataOmitted: false, at: null,
    });
  });

  it('a repeated identical non-protected action remains repeated', () => {
    const { steps } = projectStagehandSteps([act('the Next button', 'click', []), act('the Next button', 'click', [])]);
    expect(steps).toHaveLength(2);
    expect(steps[0].action).toBe(steps[1].action);
  });
});

describe('sanitizeStagehandOutcome', () => {
  it('removes every protected literal from the closing message, then the labelled and canonical passes', () => {
    const out = sanitizeStagehandOutcome(
      'Signed in as jane@acme.example with hunter2-secret; token=ghp_' + 'a'.repeat(36) + '; done',
      new Set(['hunter2-secret']),
    );
    expect(out.text).toBe('Signed in as jane@acme.example with [redacted]; token=[redacted]; done');
    expect(out.protectedDataOmitted).toBe(true);
  });

  it('leaves an ordinary message alone', () => {
    expect(sanitizeStagehandOutcome('Found 18 open pull requests for microsoft/playwright', new Set()))
      .toEqual({ text: 'Found 18 open pull requests for microsoft/playwright', truncated: false, protectedDataOmitted: false });
  });

  it('a one- or two-character literal is not hunted across other text, which would cut ordinary words apart', () => {
    expect(sanitizeStagehandOutcome('Filed 12 tickets in 2012', new Set(['12'])))
      .toEqual({ text: 'Filed 12 tickets in 2012', truncated: false, protectedDataOmitted: false });
    expect(sanitizeStagehandOutcome('Entered 123 and moved on', new Set(['123'])).text).toBe('Entered [redacted] and moved on');
  });
});

describe('projectStagehandTrail', () => {
  it('keeps every step in order beside the sanitized message, with the completeness fields the caller sets', () => {
    const trail = projectStagehandTrail(
      [{ type: 'goto', url: 'https://a.example/' }, act('the password field', 'fill', ['hunter2'], 'https://a.example/account'), { type: 'close' }],
      'Signed in with hunter2 and closed',
    );
    expect(trail.message).toBe('Signed in with [redacted] and closed');
    expect(trail.steps.map((s) => s.type)).toEqual(['goto', 'act', 'close']);
    expect(trail).toMatchObject({ captureGap: false, gapReason: null, stepsTruncated: false });
    expect([...trail.protectedLiterals]).toEqual(['hunter2']);
  });
});
