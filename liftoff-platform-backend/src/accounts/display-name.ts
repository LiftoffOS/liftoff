// The name a person is shown as, from their account.
//
// First and last name joined, falling back to the email address, which is the
// one thing every account has. Written once so the chat surfaces that carry
// the person's name into a turn (Liftoff's, the Insights Manager's, the Chief
// AI Officer's through its proxy) cannot drift into three spellings of who is
// speaking: a colleague brought in attributes the message to this name.

/** `first last`, or the email, or '' for an account with neither. */
export function accountDisplayName(account: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}): string {
  const full = [account.firstName, account.lastName].filter(Boolean).join(' ').trim();
  return full || account.email?.trim() || '';
}
