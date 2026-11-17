"""Contract tests for the deepeval-evaluator.

Guarantees a DeepEval version bump stays a `rebuild → run → ship`:

  1. PROVIDER/MODEL SELECTION — DEEPEVAL_PROVIDER + DEEPEVAL_TIER/DEEPEVAL_MODEL
     resolve to the expected model id for every provider (LLMClient parity).
  2. RESPONSE SHAPE — /evaluate keeps the schema the TS harness depends on
     (per-dimension {score,success,reason} | {error}), regardless of DeepEval
     internals. Exact scores are not asserted (they move with model/version).

Resolution tests import only ``judge_config`` and run anywhere. The /evaluate
tests need DeepEval + FastAPI installed and skip otherwise (they run in the
service image / CI).
"""

from __future__ import annotations

import pytest

import judge_config


# ---------------------------------------------------------------------------
# Provider/model resolution (runs without DeepEval) — LLMClient parity.
# ---------------------------------------------------------------------------
def test_default_provider_is_openai():
    assert judge_config.DEFAULT_PROVIDER == "openai"
    assert judge_config.PROVIDER_PRIORITY == ("anthropic", "openai", "google")


@pytest.mark.parametrize(
    "provider,tier,expected",
    [
        ("anthropic", "large", "claude-opus-4-6"),
        ("anthropic", "medium", "claude-sonnet-5-5"),
        ("anthropic", "small", "claude-haiku-4-5"),
        ("openai", "large", "gpt-5.5"),
        ("openai", "medium", "gpt-5.5-mini"),
        ("openai", "small", "gpt-5.5-nano"),
        ("google", "large", "gemini-3.1-pro-preview"),
        ("google", "medium", "gemini-3.5-flash"),
        ("google", "small", "gemini-3.1-flash-lite"),
        # The retired name for the top tier still resolves it.
        ("anthropic", "flagship", "claude-opus-4-6"),
    ],
)
def test_tier_resolution(monkeypatch, provider, tier, expected):
    monkeypatch.delenv("DEEPEVAL_MODEL", raising=False)
    monkeypatch.setenv("DEEPEVAL_TIER", tier)
    assert judge_config.resolve_model(provider) == expected


def test_explicit_model_overrides_tier(monkeypatch):
    monkeypatch.setenv("DEEPEVAL_MODEL", "my-finetuned-judge")
    monkeypatch.setenv("DEEPEVAL_TIER", "large")
    assert judge_config.resolve_model("openai") == "my-finetuned-judge"


def test_self_hosted_requires_explicit_model(monkeypatch):
    monkeypatch.delenv("DEEPEVAL_MODEL", raising=False)
    with pytest.raises(RuntimeError):
        judge_config.resolve_model("self-hosted")  # no tier table


def test_make_judge_rejects_unknown_provider(monkeypatch):
    # NOT an in-boundary policy — just a "is this a real provider key" guard.
    pytest.importorskip("deepeval")
    import judge_models

    monkeypatch.setenv("DEEPEVAL_PROVIDER", "not-a-provider")
    with pytest.raises(RuntimeError):
        judge_models.make_judge()


# ---------------------------------------------------------------------------
# /evaluate response-shape contract (needs DeepEval + FastAPI installed).
# A FAKE judge keeps the run offline + deterministic.
# ---------------------------------------------------------------------------
GOLDEN_CASES = [
    {
        "input": "How are my agents performing this week?",
        "actualOutput": "Your 3 agents ran 142 tasks at 96% success.",
        "toolsCalled": ["get_agent_performance"],
        "expectedTools": ["get_agent_performance", "get_cost_breakdown"],
        "spec": "Insights agent: answer using read-only insights tools; render visualization blocks.",
        "dimensions": ["task_completion", "tool_correctness", "conformance"],
    },
    {
        "input": "Draft and approve a workforce plan for a 2-person finance team.",
        "actualOutput": "Drafted, committed, and approved plan #42.",
        "toolsCalled": ["workforce_plan__draft", "workforce_plan__commit", "workforce_plan__approve"],
        "expectedTools": ["workforce_plan__draft", "workforce_plan__commit", "workforce_plan__approve"],
        "spec": "CAIO: gather -> draft -> commit -> approve.",
        "dimensions": ["task_completion", "conformance"],
    },
]


def _make_client(monkeypatch):
    pytest.importorskip("deepeval")
    pytest.importorskip("fastapi")
    from deepeval.models import DeepEvalBaseLLM
    from fastapi.testclient import TestClient
    import app as app_module

    class FakeJudge(DeepEvalBaseLLM):
        def load_model(self):
            return self

        def generate(self, prompt: str, *args, **kwargs) -> str:
            return '{"score": 0.9, "reason": "contract-test stub", "verdict": "yes"}'

        async def a_generate(self, prompt: str, *args, **kwargs) -> str:
            return self.generate(prompt)

        def get_model_name(self) -> str:
            return "fake-judge"

    monkeypatch.setattr(app_module, "_judge", FakeJudge())
    return TestClient(app_module.app)


def _assert_dimension_shape(d: dict):
    assert isinstance(d, dict)
    if "error" in d:
        assert isinstance(d["error"], str)
        return
    assert isinstance(d.get("score"), (int, float))
    assert 0.0 <= float(d["score"]) <= 1.0
    assert isinstance(d.get("success"), bool)
    # `reason` is optional — deterministic dimensions (toolCorrectness) omit it.
    if "reason" in d:
        assert isinstance(d["reason"], str)


def test_health(monkeypatch):
    client = _make_client(monkeypatch)
    assert client.get("/health").json() == {"ok": True}


@pytest.mark.parametrize("case", GOLDEN_CASES)
def test_evaluate_contract_shape(monkeypatch, case):
    client = _make_client(monkeypatch)
    resp = client.post("/evaluate", json=case)
    assert resp.status_code == 200
    body = resp.json()
    name_map = {"task_completion": "taskCompletion", "tool_correctness": "toolCorrectness", "conformance": "conformance"}
    for dim in case["dimensions"]:
        if dim == "tool_correctness" and not case.get("expectedTools"):
            continue
        key = name_map[dim]
        assert key in body, f"missing dimension {key}"
        _assert_dimension_shape(body[key])
