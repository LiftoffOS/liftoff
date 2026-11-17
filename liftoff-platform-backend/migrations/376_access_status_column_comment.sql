-- What does `accounts.access_status = 'pending'` actually mean?
--
-- Not "this person is waiting for approval". It means "no per-person decision
-- was ever needed", and for most granted users that is its permanent resting
-- value. Nothing in this migration changes behaviour; it records the semantics
-- on the column so the next reader does not have to derive them from
-- `computeAccess`.
--
-- `computeAccess` (src/accounts/service.ts) grants in this order, returning at
-- the first hit:
--
--   1. the email domain is on the Firebase Remote Config allow-list
--   2. access_status = 'approved'
--   3. non-owner tenant membership (an accepted invitation)
--
-- A whitelisted-domain user short-circuits at (1) and never reaches (2), and
-- nothing on that path writes the column — so they sit at 'pending' forever
-- while being fully granted. For example, the owner of a paying workspace on
-- an allow-listed domain: onboarded, paying, never once refused by the access
-- gate, and 'pending' the whole time. That is correct.
--
-- It is correct because the two mechanisms have different lifetimes. The
-- domain list is live and mutable — polled every 5 minutes and re-evaluated on
-- every request — whereas access_status is a permanent row write. If adding a
-- domain also stamped 'approved' on its users, REMOVING that domain would no
-- longer revoke them: check (1) would fail and check (2) would now pass. A
-- revocable policy-level grant would have been silently converted into an
-- irreversible per-person one, for every account on the domain at once. Leaving
-- the column untouched is what keeps domain access exactly as revocable as the
-- list that grants it.
--
-- THE TRAP: do not filter on this column to find people awaiting a decision.
-- `WHERE access_status = 'pending'` returns every domain-whitelisted user,
-- including paying customers, and the first admin queue built that way will
-- invite someone to click Waitlist on a live account. "Genuinely waiting for a
-- human" is `computeAccess(...).accessGranted === false` — already computed,
-- already correct, and already what the admin endpoints use.

BEGIN;

COMMENT ON COLUMN accounts.access_status IS
  'Was an explicit per-PERSON access decision recorded for this account? NOT "does this account have access" — read computeAccess() for that. pending = no decision was ever needed (the permanent resting value for anyone granted by whitelisted domain or by invitation, paying customers included), approved = an admin pressed Approve or the signup spent a signup_preapprovals entry, waitlisted = an admin pressed Waitlist. Adding a domain to the allow-list deliberately does NOT write this column: the domain list is live and revocable, this column is permanent, and stamping it would make removing the domain fail to revoke. Never filter on pending to build an approval queue — use computeAccess().accessGranted = false.';

COMMENT ON COLUMN accounts.access_decided_by IS
  'The admin behind an approved/waitlisted value; NULL whenever access_status is pending, and nullable besides so a caller with no resolvable admin id cannot fail the write on the UUID FK. Set by both writers: the Approve/Waitlist buttons and the born-approved signup_preapprovals path (migration 341), which carries the admin who cleared the address so the column means the same thing on both.';

COMMENT ON COLUMN accounts.access_decided_at IS
  'When the per-person decision was recorded. NULL means no decision was made, which is the normal state for a domain- or invitation-granted account and is not a data gap.';

COMMIT;
