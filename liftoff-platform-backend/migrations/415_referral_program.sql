-- The referral programme's control-plane half.
--
-- A workspace shares one link. Somebody who arrives on it and subscribes earns
-- the referrer $20 of account credit and lands 800 bonus Operating Units in
-- their own first billing period. This repo decides WHETHER a referral counts —
-- who is eligible, who was attributed to whom, who may send mail. What it is
-- worth and when it can be spent lives in liftoff-billing, which is the only
-- side that touches Stripe (INV-PB-010: billing is the one money authority).
--
-- Three tables, and the reason each one exists is a rule that has to be
-- enforceable rather than merely written down.

-- ── referral_codes ───────────────────────────────────────────────────────────
--
-- One per tenant, issued lazily the first time the workspace opens the page.
--
-- `code` is IMMUTABLE for the life of the workspace. Links already sitting in
-- somebody's inbox have to keep working, so renaming a workspace must not
-- rotate it — which is why the code is a column of its own rather than derived
-- from `tenants.name` at read time.

CREATE TABLE referral_codes (
  tenant_id  UUID        PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  code       TEXT        NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE referral_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON referral_codes
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE referral_codes IS
  'One immutable share code per workspace. A rename must never rotate it: links already sent have to keep working.';

-- ── referrals ────────────────────────────────────────────────────────────────
--
-- One row per attributed signup, written when the ACCOUNT is created rather
-- than when the link is clicked. That is what makes a 30 day attribution window
-- survive a signup that happens on a different device from the click: a cookie
-- cannot cross devices, and a row bound at account creation does not have to.
--
-- `referred_tenant_id` is UNIQUE because a workspace can be referred once,
-- ever. That single constraint enforces "previously referred by anyone" for
-- free. It is NULLABLE because the account exists before its first workspace
-- does — the column is filled when that workspace is provisioned, and Postgres
-- allows many NULLs under a UNIQUE constraint, which is exactly the behaviour
-- wanted while the rows are waiting.
--
-- `ineligible_reason` sits on the CREDIT, not on the funnel `status`. Somebody
-- can be `subscribed` and still earn nothing because they already had a Liftoff
-- account, and folding that into the status would lose the fact that they did
-- subscribe. Every reason is printed to the referrer, because every exclusion
-- in the terms is something they neither control nor can see, and a row that
-- signed up, subscribed and silently paid nothing reads as the programme not
-- working.

CREATE TABLE referrals (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_tenant_id  UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Filled when the referred account provisions its first workspace.
  referred_tenant_id  UUID        UNIQUE REFERENCES tenants(id) ON DELETE SET NULL,
  referred_account_id UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- The code as it was bound. Kept literally rather than joined through
  -- referral_codes so the attribution record survives the referrer's workspace
  -- being deleted and re-created.
  code                TEXT        NOT NULL,
  -- When the link was followed, as reported by the browser that held the code.
  -- NULL when the signup carried no click time. The 30 day window is checked
  -- against it at binding, never after.
  clicked_at          TIMESTAMPTZ,
  signed_up_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  subscribed_at       TIMESTAMPTZ,
  status              TEXT        NOT NULL DEFAULT 'signed_up'
    CHECK (status IN ('signed_up', 'subscribed', 'expired')),
  ineligible_reason   TEXT
    CHECK (ineligible_reason IN (
      'existing_account', 'already_referred', 'self_referral', 'discounted_signup'
    )),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Makes binding idempotent: a retried signup re-binds the same pair rather
  -- than adding a second row to the referrer's list.
  UNIQUE (referrer_tenant_id, referred_account_id)
);

-- The list's exact order, so cursor pagination reads an index rather than a
-- sort. Newest signup first, ties broken on id — an undefined order makes
-- Load more duplicate and skip rows.
CREATE INDEX idx_referrals_referrer_page
  ON referrals (referrer_tenant_id, signed_up_at DESC, id DESC);

-- Binding looks the account up before it writes; earning looks the tenant up.
CREATE INDEX idx_referrals_referred_account ON referrals (referred_account_id);

ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals FORCE ROW LEVEL SECURITY;
-- Scoped to the REFERRER: this row is the referrer's record of what their link
-- earned. The referred workspace has no read of its own here — the only thing
-- it is told is the larger Operating Unit allowance on its billing tab.
CREATE POLICY tenant_isolation ON referrals
  USING (referrer_tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (referrer_tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE referrals IS
  'One attributed signup. Bound at account creation (last touch, 30 day window); referred_tenant_id is UNIQUE because a workspace can be referred once, ever.';

-- ── referral_invites ─────────────────────────────────────────────────────────
--
-- The record behind the two controls on POST /api/referrals/invites.
--
-- A daily cap of 30 is the blunt half. The sharper half is the acceptance
-- ratio: spam has a near-zero acceptance rate, so a workspace that has sent
-- many invitations and had few accepted loses `canSendInvites`, which targets
-- the behaviour rather than punishing a referrer who happens to be effective.
-- A fixed cap alone lets a spammer send 30 a day forever.
--
-- Both exist because this endpoint is a mail relay wearing Liftoff's sending
-- reputation: it sends from a Liftoff domain, passing our SPF, DKIM and DMARC,
-- to addresses the caller supplies. The damage from abusing it lands on
-- password resets and verification emails, not on the programme.

CREATE TABLE referral_invites (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Lower-cased at write time so `already_invited` cannot be defeated by case.
  email       TEXT        NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set when an account is created for this address and bound to this tenant's
  -- code. The numerator of the acceptance ratio.
  accepted_at TIMESTAMPTZ,

  UNIQUE (tenant_id, email)
);

-- The daily-cap count is "rows for this tenant since midnight".
CREATE INDEX idx_referral_invites_tenant_sent ON referral_invites (tenant_id, sent_at DESC);

-- Acceptance marking arrives keyed by address, across every tenant that
-- invited it.
CREATE INDEX idx_referral_invites_email ON referral_invites (email);

ALTER TABLE referral_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_invites FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON referral_invites
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE referral_invites IS
  'Sent referral invitations. Backs the 30-per-day cap, the already_invited rejection, and the acceptance-ratio throttle behind canSendInvites.';

-- ── The referee bonus lands in the allowance the billing tab already reads ───
--
-- 800 Operating Units on the referred workspace's FIRST billing period, granted
-- on the qualifying paid invoice and never on signup: at signup it costs an
-- attacker one email address and the programme becomes a free-compute faucet.
--
-- It is deliberately not a dollar discount. A $20 discount would zero a $20
-- Core invoice, which would disqualify the referral under the full-price rule
-- AND halve the cost of manufacturing one, because vesting would then need one
-- paid month instead of two. Granting compute leaves the invoice full-priced
-- and the fraud arithmetic unchanged.
--
-- Its own column rather than an addition to `precommit_extra_ous`, for two
-- reasons: the period reset has to take it away again (bonus units do not roll
-- over, matching how plan allowance already behaves), and a grant that is
-- indistinguishable from purchased capacity cannot be audited afterwards. The
-- OU bucket split and the allowance the billing tab reports both add it to the
-- precommit end, so the referred workspace actually sees the larger number —
-- which is the ONLY surface the referred party gets, by decision.
ALTER TABLE billing_controls
  ADD COLUMN referral_bonus_ous BIGINT NOT NULL DEFAULT 0
    CHECK (referral_bonus_ous >= 0),
  -- One bonus per account, ever. Kept across period resets (which zero the OUs
  -- but not this) so a webhook redelivery after the period rolls cannot grant
  -- a second one.
  ADD COLUMN referral_bonus_referral_id UUID;

COMMENT ON COLUMN billing_controls.referral_bonus_ous IS
  'Operating Units granted by the referral programme for the current period only. Added to the precommit end of the bucket split and to the allowance the billing tab reports; zeroed by the period reset because bonus units do not roll over.';
COMMENT ON COLUMN billing_controls.referral_bonus_referral_id IS
  'The referrals.id that earned the bonus. Survives the period reset so a redelivered invoice cannot grant a second one.';
