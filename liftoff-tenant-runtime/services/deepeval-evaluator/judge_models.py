"""Judge-model registry — the DeepEval analogue of tenant-runtime's LLMClient.

Switch provider/model/tier by configuration, across the SAME provider set
LLMClient supports: ``anthropic`` (direct), ``openai``,
``google`` (Gemini on Vertex), plus ``self-hosted`` (any OpenAI-compatible
endpoint). The provider + model are whatever WE configure — no provider is
defaulted to or excluded. Stock DeepEval is never patched; we only use its
official model classes + the ``DeepEvalBaseLLM`` seam.

Config (env): DEEPEVAL_PROVIDER (default ``openai``), DEEPEVAL_TIER
(large|medium|small), DEEPEVAL_MODEL (exact id;
overrides tier; required for self-hosted), DEEPEVAL_BASE_URL (self-hosted),
DEEPEVAL_API_KEY (self-hosted / custom). Provider creds come from the standard
env keys each DeepEval model class reads (OPENAI_API_KEY, ANTHROPIC_API_KEY) or
ADC for the Vertex providers.
"""

from __future__ import annotations

import os
from typing import Callable, Dict

# Top-level public import (not deepeval.models.base_model) to avoid coupling to
# DeepEval's internal module layout — keeps upgrades clean.
from deepeval.models import DeepEvalBaseLLM

import judge_config


def _project() -> str:
    project = os.environ.get("GCP_PROJECT_ID")
    if not project:
        raise RuntimeError("GCP_PROJECT_ID is required for the Vertex providers")
    return project


def _location() -> str:
    return os.environ.get("GCP_LOCATION", "global")


# --- provider builders (one per LLMClient provider) -------------------------

def _build_anthropic(model: str) -> DeepEvalBaseLLM:
    # Anthropic direct (ANTHROPIC_API_KEY). DeepEval built-in.
    from deepeval.models import AnthropicModel

    return AnthropicModel(model=model, temperature=0)


def _build_openai(model: str) -> DeepEvalBaseLLM:
    # OpenAI direct (OPENAI_API_KEY). DeepEval built-in. base_url optional for
    # OpenAI-compatible gateways.
    from deepeval.models import GPTModel

    kwargs = {"model": model, "temperature": 0}
    base_url = os.environ.get("DEEPEVAL_BASE_URL")
    if base_url:
        kwargs["base_url"] = base_url
    return GPTModel(**kwargs)


def _build_google(model: str) -> DeepEvalBaseLLM:
    # Gemini on Vertex (ADC, project/location). DeepEval built-in.
    from deepeval.models import GeminiModel

    return GeminiModel(model=model, project=_project(), location=_location(), temperature=0)


def _build_self_hosted(model: str) -> DeepEvalBaseLLM:
    # Any OpenAI-compatible endpoint we point at (vLLM / Ollama / a fine-tuned
    # judge / a gateway). The endpoint is whatever we configure.
    base_url = os.environ.get("DEEPEVAL_BASE_URL")
    if not base_url:
        raise RuntimeError("DEEPEVAL_BASE_URL is required for the 'self-hosted' provider")
    from deepeval.models import LocalModel

    return LocalModel(model=model, base_url=base_url, api_key=os.environ.get("DEEPEVAL_API_KEY", "not-required"), temperature=0)


_BUILDERS: Dict[str, Callable[[str], DeepEvalBaseLLM]] = {
    "anthropic": _build_anthropic,
    "openai": _build_openai,
    "google": _build_google,
    "self-hosted": _build_self_hosted,
}


def make_judge() -> DeepEvalBaseLLM:
    """Build the configured judge — provider + model chosen by config."""
    provider = os.environ.get("DEEPEVAL_PROVIDER", judge_config.DEFAULT_PROVIDER)
    if provider not in _BUILDERS:
        raise RuntimeError(f"unknown DEEPEVAL_PROVIDER='{provider}'; known providers: {sorted(_BUILDERS)}")
    model = judge_config.resolve_model(provider)
    return _BUILDERS[provider](model)
