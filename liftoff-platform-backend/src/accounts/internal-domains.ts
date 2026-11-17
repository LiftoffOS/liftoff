// Email domains whose accounts auto-derive `is_internal = true` on write
// (account creation + email-change confirmation). Used to gate the
// $internal_or_test_user PostHog marker on the frontend so operator staff
// don't inflate product-analytics metrics.
//
// The column is stored, not computed — overrides via manual UPDATE remain
// possible for contractors / staff on personal emails. Adding a domain here
// only changes the default-on-write; existing rows are unaffected until
// either a re-backfill migration or the next email-change confirmation.
// Empty by default: "internal" means staff of whoever runs this deployment,
// which no value in this file can know. Set INTERNAL_EMAIL_DOMAINS
// (comma-separated) to populate it. Empty means nobody is flagged internal,
// which is the honest answer rather than flagging the wrong people.
export const INTERNAL_EMAIL_DOMAINS: readonly string[] = (
  process.env.INTERNAL_EMAIL_DOMAINS ?? ''
)
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

export function isInternalEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  return INTERNAL_EMAIL_DOMAINS.some((d) => normalized.endsWith('@' + d));
}
