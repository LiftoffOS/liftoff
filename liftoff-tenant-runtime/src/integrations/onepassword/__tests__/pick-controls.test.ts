// Which box takes what, over the authentication-class controls the walk
// returns.
//
// The class is wide on purpose: the classifier marks every editable control
// on a recognised sign-in route as authentication, so a header search box on
// a /login page is in the set. What is pinned here is that the username is
// taken on EVIDENCE - the page's own `autocomplete` declaration, the form the
// password is in, a name that reads as an identifier - and never on position
// alone, and that a one-time-code box is found however the page spells the
// token, because `autocomplete` is a token list.

import { pickControls } from '../autofill';
import type { LoginControl } from '../../../browser-sessions/pane-actions';

const control = (over: Partial<LoginControl> & { name: string }): LoginControl => ({
  role: 'textbox', nth: 0, frameId: null, tag: 'input', inputType: 'text', autocomplete: '',
  formKey: '', protectedKind: 'authentication', offscreen: false, ...over,
});
const named = (picked: ReturnType<typeof pickControls>) => ({
  password: picked.password?.name ?? null,
  otp: picked.otp?.name ?? null,
  username: picked.username?.name ?? null,
  ambiguous: picked.usernameAmbiguous,
});

describe('the one-time-code box', () => {
  it('is found whatever else the token list carries: `autocomplete` is a token list, not one value', () => {
    for (const autocomplete of ['one-time-code', 'one-time-code webauthn', 'section-login one-time-code', 'ONE-TIME-CODE']) {
      const picked = named(pickControls([control({ name: 'One-time code', autocomplete })]));
      expect(picked).toEqual({ password: null, otp: 'One-time code', username: null, ambiguous: false });
    }
  });

  it('is found by its name when the page declares no token at all, and never taken for the username', () => {
    for (const name of ['One-time code', 'Verification code', 'Authenticator code', '2FA code', 'Security code', 'Passcode']) {
      expect(named(pickControls([control({ name })]))).toEqual({ password: null, otp: name, username: null, ambiguous: false });
    }
  });

  it('a discount or postal code is not a one-time code', () => {
    expect(named(pickControls([control({ name: 'Promo code' }), control({ name: 'Email', autocomplete: 'username' })])))
      .toEqual({ password: null, otp: null, username: 'Email', ambiguous: false });
  });
});

describe('the username box', () => {
  it('follows the page\'s own declaration before anything else', () => {
    const picked = pickControls([
      control({ name: 'Search' }),
      control({ name: 'Email', inputType: 'email', autocomplete: 'section-login username' }),
      control({ name: 'Password', inputType: 'password', formKey: 'f0' }),
    ]);
    expect(named(picked)).toEqual({ password: 'Password', otp: null, username: 'Email', ambiguous: false });
  });

  it('keeps to the form the password is in: a header search box on a sign-in route never takes it', () => {
    // Every editable control on a /login route is authentication-class, and
    // the search box comes FIRST in document order.
    const picked = pickControls([
      control({ name: 'Search', formKey: '' }),
      control({ name: 'Email address', inputType: 'email', formKey: '#f0' }),
      control({ name: 'Password', inputType: 'password', formKey: '#f0' }),
    ]);
    expect(named(picked)).toEqual({ password: 'Password', otp: null, username: 'Email address', ambiguous: false });
  });

  it('within the password\'s form, prefers a box whose name reads as an identifier, else the one nearest the password', () => {
    expect(named(pickControls([
      control({ name: 'Company', formKey: '#f0' }),
      control({ name: 'Username', formKey: '#f0' }),
      control({ name: 'Password', inputType: 'password', formKey: '#f0' }),
    ]))).toMatchObject({ username: 'Username' });
    // Nothing named an identifier: the box beside the password, not the first.
    expect(named(pickControls([
      control({ name: 'Box one', formKey: '#f0' }),
      control({ name: 'Box two', formKey: '#f0' }),
      control({ name: 'Password', inputType: 'password', formKey: '#f0' }),
    ]))).toMatchObject({ username: 'Box two' });
  });

  it('a named box outside the password\'s form loses to the form, and wins when the password is in none', () => {
    expect(named(pickControls([
      control({ name: 'Email', inputType: 'email', formKey: '#f9' }),
      control({ name: 'Account', formKey: '#f0' }),
      control({ name: 'Password', inputType: 'password', formKey: '#f0' }),
    ]))).toMatchObject({ username: 'Account' });
    expect(named(pickControls([
      control({ name: 'Search' }),
      control({ name: 'Email', inputType: 'email' }),
      control({ name: 'Password', inputType: 'password' }),
    ]))).toMatchObject({ username: 'Email' });
  });

  it('username-first: the only candidate on the page takes it', () => {
    expect(named(pickControls([control({ name: 'Email address', inputType: 'text' })])))
      .toEqual({ password: null, otp: null, username: 'Email address', ambiguous: false });
  });

  it('username-first with several unnamed candidates and no evidence: nothing is typed', () => {
    const picked = pickControls([control({ name: 'Box one' }), control({ name: 'Box two' })]);
    expect(named(picked)).toEqual({ password: null, otp: null, username: null, ambiguous: true });
  });

  it('with a password box present, an unidentifiable candidate is simply left: the password is still worth filling', () => {
    const picked = pickControls([
      control({ name: 'Search', formKey: '' }),
      control({ name: 'Password', inputType: 'password', formKey: '#f0' }),
    ]);
    expect(named(picked)).toEqual({ password: 'Password', otp: null, username: null, ambiguous: false });
  });

  it('prefers a box the person can see when several are equally named', () => {
    expect(named(pickControls([
      control({ name: 'Email', offscreen: true }),
      control({ name: 'Email', nth: 1 }),
    ]))).toMatchObject({ username: 'Email' });
    expect(pickControls([
      control({ name: 'Email', offscreen: true }),
      control({ name: 'Email', nth: 1 }),
    ]).username?.nth).toBe(1);
  });
});

describe('the password box', () => {
  it('is the type when the page uses it', () => {
    expect(named(pickControls([control({ name: 'Password', inputType: 'password' })])))
      .toEqual({ password: 'Password', otp: null, username: null, ambiguous: false });
  });

  it('is found through the show-password swap, where the page turns it into a text box', () => {
    // By the token the page kept...
    expect(named(pickControls([
      control({ name: 'Email', inputType: 'email', autocomplete: 'username', formKey: '#f0' }),
      control({ name: 'Your secret', inputType: 'text', autocomplete: 'current-password', formKey: '#f0' }),
    ]))).toEqual({ password: 'Your secret', otp: null, username: 'Email', ambiguous: false });
    // ...else by its name, and it is never taken for the username.
    expect(named(pickControls([
      control({ name: 'Password', inputType: 'text', formKey: '#f0' }),
      control({ name: 'Email', inputType: 'email', formKey: '#f0' }),
    ]))).toEqual({ password: 'Password', otp: null, username: 'Email', ambiguous: false });
  });
});

describe('what a sign-in page is not', () => {
  it('no candidate at all is no answer, not an ambiguity', () => {
    expect(named(pickControls([]))).toEqual({ password: null, otp: null, username: null, ambiguous: false });
  });
});
