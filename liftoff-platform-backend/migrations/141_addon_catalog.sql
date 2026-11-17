-- Add-on management.
--
-- addon_catalog defines the purchasable add-ons CS sells via Stripe.
-- stripe_price_id populated in Phase 5 after Stripe products are created.
-- entitlement_field references the boolean column name in the entitlements table
-- that this add-on controls. Validated against a whitelist in addon-service.ts
-- before any dynamic SQL is constructed.

CREATE TABLE addon_catalog (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key               TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  description       TEXT,
  price_cents       INTEGER NOT NULL,
  billing_period    TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_period IN ('monthly', 'one_time')),
  stripe_price_id   TEXT,                    -- set in Phase 5; NULL until then
  entitlement_field TEXT NOT NULL,           -- column name in entitlements table
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- price_cents are $0 until pricing is finalised — same approach as platform_fee_catalog.
-- entitlement_field values map to boolean columns on the entitlements table.
INSERT INTO addon_catalog (key, name, description, price_cents, entitlement_field) VALUES
  ('sso',               'SSO / SAML',          'SAML/OIDC single sign-on',                      0, 'sso_enabled'),
  ('audit_logs',        'Audit Log Export',    'Full audit log export to S3/GCS',               0, 'audit_log_export'),
  ('scim_saml',         'SCIM Provisioning',   'Auto-provision users from your IdP',            0, 'scim_enabled'),
  ('advanced_reporting','Advanced Reporting',  'Custom cost reports and data exports',          0, 'advanced_reporting'),
  ('priority_support',  'Priority Support',    'SLA-backed support with 4-hour response time',  0, 'priority_support_enabled');
