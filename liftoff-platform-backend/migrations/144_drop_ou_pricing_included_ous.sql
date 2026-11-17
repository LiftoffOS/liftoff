-- Every OU is billable from the first one — there is no included allotment.
-- The included_ous column was vestigial from an earlier pricing model and was
-- never non-zero in any environment. Drop it to align schema with pricing reality.
ALTER TABLE ou_pricing DROP COLUMN IF EXISTS included_ous;
