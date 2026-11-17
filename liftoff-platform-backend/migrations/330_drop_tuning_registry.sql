-- Migration 330: drop the tuned-model registry and promotion ledger (migration 300).
--
-- The self-tuning flywheel is removed. It needs a per-agent trajectory volume
-- (a 50-row training minimum) that typical agents do not reach.
--
-- The deciding fact is capability, not volume: of the seven vendors the product
-- offers, only Google can be fine-tuned at all. OpenAI has closed its fine-tuning
-- platform to new users; Anthropic offers it only for Claude 3 Haiku on Bedrock,
-- which is not how we call Anthropic; the four OpenRouter-served open-weights
-- vendors would require running our own training stack. And Vertex tunes Gemini
-- 2.5.x while we serve Gemini 3.x — so a tuned agent would have run a generation
-- behind its own untuned default, and would have had to beat it to be worth
-- anything.
--
-- That also made the precedence rule wrong-shaped: because Google was the only
-- tunable path, "a tuned model beats the customer's vendor choice" could only ever
-- mean "silently move them onto Google." That rule and its machinery are gone with
-- these tables.
--
-- The learning loop this belonged to is NOT removed. Preference recall — HITL
-- approvals, chat corrections and late feedback landing as recallable 'preference'
-- memories — needs no training, no per-agent volume threshold and no Vertex spend,
-- and is what actually makes a team member better at one company's way of working.
--
-- Safe to drop in either order: tuning_promotions FKs tenant_tuned_models, so the
-- child goes first. Any remaining rows are discarded.

DROP TABLE IF EXISTS tuning_promotions;
DROP TABLE IF EXISTS tenant_tuned_models;
