-- Cache of the LLM-derived capability specs for an agent's public-data prior-art
-- discovery. Derived off the hot path (at authoring, when role/responsibilities/
-- integrations change) and read by the distillation prefetch, which cannot afford
-- an LLM call under its summary-wave budget. The source hash gates staleness: the
-- prefetch uses the cache only when it matches the current text, else it falls
-- back to the keyword heuristic. Both nullable — absent cache is the heuristic
-- path, never an error.
ALTER TABLE internal_agents
  ADD COLUMN IF NOT EXISTS capability_specs jsonb,
  ADD COLUMN IF NOT EXISTS capability_specs_source_hash text;
