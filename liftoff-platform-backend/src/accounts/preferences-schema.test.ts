// The account preferences write contract.
//
// This exists because of a real failure: notificationDelivery was added to the
// frontend, to the AccountPreferences type and to enqueueNotification's read
// path, but not here. The schema is .strict(), so the PATCH did not drop the
// unknown key — it rejected the entire request with a 400. Enabling browser
// notifications appeared to work (the browser prompted, a token registered) and
// the preference never persisted, so the backend never pushed and Settings kept
// showing the channel as off.
//
// Every key the frontend can send needs a case here.

import { accountPreferencesSchema } from './router';

describe('accountPreferencesSchema', () => {
  it('accepts notificationDelivery, which gates browser push', () => {
    const r = accountPreferencesSchema.safeParse({
      notificationDelivery: { email: true, browser: true },
    });
    expect(r.success).toBe(true);
  });

  it('accepts either delivery channel on its own', () => {
    expect(accountPreferencesSchema.safeParse({ notificationDelivery: { browser: true } }).success).toBe(true);
    expect(accountPreferencesSchema.safeParse({ notificationDelivery: { email: false } }).success).toBe(true);
  });

  it('still accepts the preferences that predate it', () => {
    const r = accountPreferencesSchema.safeParse({
      notificationTypes: { taskUpdates: true, weeklyDigest: false },
      notificationFrequency: 'daily',
      newsletter: true,
      gettingStartedHidden: true,
    });
    expect(r.success).toBe(true);
  });

  // The strictness is deliberate and worth keeping: it is what turns a typo
  // into a visible 400 rather than a preference that silently never applies.
  it('rejects an unknown preference key outright', () => {
    expect(accountPreferencesSchema.safeParse({ notificationDeliveryTypo: {} }).success).toBe(false);
  });

  it('rejects an unknown key inside notificationDelivery', () => {
    expect(
      accountPreferencesSchema.safeParse({ notificationDelivery: { sms: true } }).success,
    ).toBe(false);
  });

  it('rejects a non-boolean delivery channel', () => {
    expect(
      accountPreferencesSchema.safeParse({ notificationDelivery: { browser: 'yes' } }).success,
    ).toBe(false);
  });
});
