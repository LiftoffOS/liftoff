ALTER TABLE billing_controls
  ADD COLUMN billing_mode               TEXT    NOT NULL DEFAULT 'post_pay'
    CHECK (billing_mode IN ('pre_pay', 'post_pay')),
  -- NOTE: column default is 'post_pay' as a DB-level fallback only.
  -- Application provisioning reads BILLING_DEFAULT_MODE env var (see billing-controls-internal-router.ts /init).

  ADD COLUMN plan_type                  TEXT    NULL
    CHECK (plan_type IN ('core', 'growth', 'scale')),
  -- NULL = post-pay account.

  ADD COLUMN monthly_allocation_usd     NUMERIC(18,6) NOT NULL DEFAULT 0,
  -- USD value of OUs allocated each billing period (e.g. $55 for growth = 2,200 OUs).
  -- Set at subscription activation; reloaded into prepaid_balance_usd at every period reset.

  ADD COLUMN topup_balance_usd          NUMERIC(18,6) NOT NULL DEFAULT 0,
  -- Separately purchased top-up balance; carries over across period resets.
  -- prepaid_balance_usd (existing column) = allocation remaining + topup_balance_usd.

  ADD COLUMN is_annual_plan             BOOLEAN NOT NULL DEFAULT FALSE,
  -- TRUE when the active subscription uses one of the 6 annual price IDs.
  -- Set at subscription-activated time. Used by the annual-reset cron to identify
  -- accounts that need monthly allocation resets (annual invoice only fires once/year).

  ADD COLUMN auto_topup_enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN auto_topup_threshold_usd   NUMERIC(18,6) NULL
    CHECK (auto_topup_threshold_usd IS NULL OR auto_topup_threshold_usd >= 10),
  ADD COLUMN auto_topup_amount_usd      NUMERIC(18,6) NULL,
  ADD COLUMN last_auto_topup_triggered_at TIMESTAMPTZ NULL,
  ADD COLUMN suspended_reason           TEXT    NULL
    CHECK (suspended_reason IN ('auto_topup_failed', 'payment_failed', 'subscription_cancelled',
                                'no_payment_method', 'zero_prepaid_balance'));
