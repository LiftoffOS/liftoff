-- A workspace that funds itself with credit could not be credited.
--
-- ensurePayAsYouGoControlsRow seeds billing_controls at tenant activation, and
-- only subscription activation ever wrote stripe_customer_id. liftoff-billing
-- addresses every internal call by Stripe customer id
-- (/controls/cus_.../prepaid-topped-up), and that router's :accountId resolver
-- looks the id up in THIS column first. With no row to find and no tenantId in
-- the body, the resolver answers 404 account_not_found_for_customer, so the
-- first top-up on a workspace that never subscribed credited nothing.
--
-- The account's Stripe customer exists from signup, so the value is already
-- there to copy. Idempotent, and scoped to rows that have none: a row whose
-- pointer was set by a subscription keeps it.

UPDATE billing_controls bc
   SET stripe_customer_id = a.stripe_customer_id,
       updated_at         = NOW()
  FROM accounts a
 WHERE a.id = bc.account_id
   AND bc.stripe_customer_id IS NULL
   AND a.stripe_customer_id IS NOT NULL;
