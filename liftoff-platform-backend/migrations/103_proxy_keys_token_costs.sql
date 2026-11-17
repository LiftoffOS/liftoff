-- Migration 103: Add per-token cost columns to claude_code_proxy_keys
-- Replaces plan_type + cost_per_month metadata with direct per-million-token cost fields.
-- These are user-entered attribution costs, not the actual Anthropic billing prices.

ALTER TABLE claude_code_proxy_keys
  ADD COLUMN IF NOT EXISTS cost_per_million_input_tokens  NUMERIC CHECK (cost_per_million_input_tokens  >= 0),
  ADD COLUMN IF NOT EXISTS cost_per_million_output_tokens NUMERIC CHECK (cost_per_million_output_tokens >= 0);
