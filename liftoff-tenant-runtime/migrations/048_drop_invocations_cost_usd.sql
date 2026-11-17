-- Drop redundant cost_usd column from invocations.
-- Cost is now derived: (input_tokens * input_price_per_million + output_tokens * output_price_per_million) / 1e6
-- The price snapshot columns (input_price_per_million, output_price_per_million) remain
-- as the immutable point-in-time rates; cost is computed from those on read.

ALTER TABLE invocations DROP COLUMN cost_usd;

-- Remove stale comment referencing the dropped column
COMMENT ON COLUMN invocations.input_price_per_million IS 'Price per million input tokens at invocation time (snapshot for historical accuracy).';
COMMENT ON COLUMN invocations.output_price_per_million IS 'Price per million output tokens at invocation time (snapshot for historical accuracy).';
