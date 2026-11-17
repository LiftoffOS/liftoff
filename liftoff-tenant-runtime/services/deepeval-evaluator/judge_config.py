"""Judge model configuration — mirrors the tenant-runtime ``LLMClient`` approach.

We choose the judge PROVIDER and MODEL exactly the way LLMClient does: a
provider key + a tier (large/medium/small) resolved against per-provider
tables, with an explicit-model override. Same provider set, same default
priority, same tier vocabulary. No provider is special-cased or excluded.

These tables MIRROR the platform's source of truth so the judge stays in lockstep
with the rest of the stack — keep them in sync on a model bump there:
  openai           → src/llm/providers/openai.ts
  anthropic        → src/llm/providers/anthropic.ts
  google           → src/llm/providers/google.ts
(or override per-deploy with DEEPEVAL_MODEL / DEEPEVAL_TIER.)
"""

from __future__ import annotations

import os
from typing import Dict

# Supported providers (same set as LLMClient's GLOBAL_PROVIDER_PRIORITY).
PROVIDER_PRIORITY = ("anthropic", "openai", "google")
# The judge defaults to OpenAI (deliberate choice). Override per-deploy with
# DEEPEVAL_PROVIDER.
DEFAULT_PROVIDER = "openai"

# tier → concrete model id, per provider. `self-hosted` has no table (the served
# model id must be given explicitly via DEEPEVAL_MODEL).
TIER_MODELS: Dict[str, Dict[str, str]] = {
    # `large` is a generation behind the runtime's own map (claude-opus-5-5) and
    # has been since that swap; left as it is rather than changed in passing,
    # because a judge model is what past scores were measured against.
    "anthropic": {"large": "claude-opus-4-6", "medium": "claude-sonnet-5-5", "small": "claude-haiku-4-5"},
    "openai": {"large": "gpt-5.5", "medium": "gpt-5.5-mini", "small": "gpt-5.5-nano"},
    "google": {"large": "gemini-3.1-pro-preview", "medium": "gemini-3.5-flash", "small": "gemini-3.1-flash-lite"},
}


def resolve_model(provider: str) -> str:
    """DEEPEVAL_MODEL overrides; otherwise resolve DEEPEVAL_TIER via TIER_MODELS."""
    explicit = os.environ.get("DEEPEVAL_MODEL")
    if explicit:
        return explicit
    table = TIER_MODELS.get(provider)
    if not table:
        raise RuntimeError(f"provider '{provider}' has no tier table — set DEEPEVAL_MODEL explicitly")
    # Default to large: a judge's reliability gates how much the scores can be
    # trusted (DeepEval itself defaults to the full gpt-4.1, not a mini/nano).
    tier = os.environ.get("DEEPEVAL_TIER", "large")
    # 'flagship' is the top tier's retired name; deploy config can still carry
    # it (the tenant-runtime normalises the same way, see normalizeTier).
    if tier == "flagship":
        tier = "large"
    return table.get(tier) or table.get("large")
