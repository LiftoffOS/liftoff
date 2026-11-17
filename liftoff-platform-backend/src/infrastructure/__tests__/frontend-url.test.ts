// One base URL for every link this service sends a person.
//
// This exists because the codebase had two and only one of them was real:
// notifications/router.ts read DASHBOARD_BASE_URL, which is set in neither
// Cloud Run service and appears nowhere in Terraform, so every escalation email
// shipped with no link and nothing ever failed.

import { frontendUrl, frontendOrigin } from '../frontend-url';

const ORIGINAL = process.env.FRONTEND_URL;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = ORIGINAL;
});

describe('frontendUrl', () => {
  it('uses FRONTEND_URL, the variable that is actually set in both environments', () => {
    process.env.FRONTEND_URL = 'https://staging.example';
    expect(frontendUrl()).toBe('https://staging.example');
  });

  // There is no default, and the absence is the point. A default is a link
  // that resolves against a host this deployment does not own: well formed,
  // sent, and reaching nothing — in an email nobody here will ever read, so
  // nothing reports it. Unset is a configuration error and says so.
  it('throws rather than defaulting to a host this deployment may not own', () => {
    delete process.env.FRONTEND_URL;
    expect(() => frontendUrl()).toThrow(/FRONTEND_URL is unset/);
  });

  it('treats whitespace as unset', () => {
    process.env.FRONTEND_URL = '   ';
    expect(() => frontendUrl()).toThrow(/FRONTEND_URL is unset/);
  });

  // A trailing slash would produce //notification/<id>, which is a different
  // path and 404s on the SPA route allowlist.
  it('strips a trailing slash so callers can always append a path', () => {
    process.env.FRONTEND_URL = 'https://app.example/';
    expect(frontendUrl()).toBe('https://app.example');
    expect(`${frontendUrl()}/notification/abc`).toBe('https://app.example/notification/abc');
  });

  // Read at call time, not at module load: tests override per call, and a value
  // that arrives after import cannot be captured as an empty string.
  it('re-reads the environment on every call', () => {
    process.env.FRONTEND_URL = 'https://one.example';
    expect(frontendUrl()).toBe('https://one.example');
    process.env.FRONTEND_URL = 'https://two.example';
    expect(frontendUrl()).toBe('https://two.example');
  });
});

describe('frontendOrigin', () => {
  it('reduces the base URL to an origin for push token scoping', () => {
    process.env.FRONTEND_URL = 'https://staging.example';
    expect(frontendOrigin()).toBe('https://staging.example');
  });

  // Two deployments sharing one Firebase project mint indistinguishable push
  // tokens, so the origin is what stops one reaching a device that registered
  // against the other.
  it('separates two deployments', () => {
    process.env.FRONTEND_URL = 'https://staging.example';
    const dev = frontendOrigin();
    process.env.FRONTEND_URL = 'https://app.example';
    expect(frontendOrigin()).not.toBe(dev);
  });

  it('returns null for an unusable value rather than guessing an origin', () => {
    process.env.FRONTEND_URL = 'not a url';
    expect(frontendOrigin()).toBeNull();
  });

  // Push is disabled rather than scoped to a guess. This is the one caller that
  // degrades instead of throwing, because a token with no origin recorded is
  // worse than no push at all.
  it('returns null when FRONTEND_URL is unset', () => {
    delete process.env.FRONTEND_URL;
    expect(frontendOrigin()).toBeNull();
  });
});
