-- Stripe sandbox price IDs.
-- Prices are $0 — amounts will be updated when pricing is finalized.
-- AI Operating Unit uses meter event_name: 'ai_operating_unit' (mtr_test_61UaShXfA6AcTwKLR41DMiih7A2ooLyK)

UPDATE platform_fee_catalog SET stripe_price_id = 'price_YOUR_STRIPE_ID' WHERE tier_key = 'starter';
UPDATE platform_fee_catalog SET stripe_price_id = 'price_YOUR_STRIPE_ID' WHERE tier_key = 'growth';
UPDATE platform_fee_catalog SET stripe_price_id = 'price_YOUR_STRIPE_ID' WHERE tier_key = 'scale';
UPDATE platform_fee_catalog SET stripe_price_id = 'price_YOUR_STRIPE_ID' WHERE tier_key = 'enterprise';

UPDATE addon_catalog SET stripe_price_id = 'price_YOUR_STRIPE_ID' WHERE key = 'sso';
UPDATE addon_catalog SET stripe_price_id = 'price_YOUR_STRIPE_ID' WHERE key = 'audit_logs';
UPDATE addon_catalog SET stripe_price_id = 'price_YOUR_STRIPE_ID' WHERE key = 'scim_saml';
UPDATE addon_catalog SET stripe_price_id = 'price_YOUR_STRIPE_ID' WHERE key = 'advanced_reporting';
UPDATE addon_catalog SET stripe_price_id = 'price_YOUR_STRIPE_ID' WHERE key = 'priority_support';
