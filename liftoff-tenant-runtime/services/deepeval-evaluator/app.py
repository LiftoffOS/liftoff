"""deepeval-evaluator — in-boundary DeepEval scoring service.

The TypeScript diagnostics harness (tenant-runtime) cannot import DeepEval (a
Python library) in-process, so the SEMANTIC metrics run here and are called over
HTTP. The harness keeps the DETERMINISTIC metrics (ToolCorrectness /
StepEfficiency) native in TS — they need no LLM and benefit nothing from a
Python hop — but ToolCorrectness is also exposed here for parity / cross-check.

Contract:
  POST /evaluate
    { "input", "actualOutput", "toolsCalled"[], "expectedTools"[], "spec",
      "dimensions"?: ["task_completion","tool_correctness","conformance"] }
  -> { "taskCompletion": {score,success,reason}|{error},
       "toolCorrectness": {...}, "conformance": {...} }

The judge provider + model are whatever we configure (see judge_models.py /
judge_config.py), exactly like tenant-runtime's LLMClient.
"""

from __future__ import annotations

from typing import List, Optional

from fastapi import FastAPI
from pydantic import BaseModel

from deepeval.metrics import GEval, TaskCompletionMetric, ToolCorrectnessMetric
from deepeval.test_case import LLMTestCase, LLMTestCaseParams, ToolCall

from deepeval.models import DeepEvalBaseLLM  # top-level public import

from judge_models import make_judge

app = FastAPI(title="deepeval-evaluator")

# Lazily construct the configured in-boundary judge once per process (model init
# is not free). Provider/model/tier are selected by env (see judge_models.py).
_judge: Optional[DeepEvalBaseLLM] = None


def judge() -> DeepEvalBaseLLM:
    global _judge
    if _judge is None:
        _judge = make_judge()
    return _judge


class EvalRequest(BaseModel):
    input: str
    actualOutput: str = ""
    toolsCalled: List[str] = []
    expectedTools: List[str] = []
    spec: str = ""
    dimensions: List[str] = ["task_completion", "conformance"]


def _test_case(req: EvalRequest) -> LLMTestCase:
    return LLMTestCase(
        input=req.input,
        actual_output=req.actualOutput,
        tools_called=[ToolCall(name=n) for n in req.toolsCalled],
        expected_tools=[ToolCall(name=n) for n in req.expectedTools],
    )


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/evaluate")
def evaluate(req: EvalRequest) -> dict:
    tc = _test_case(req)
    out: dict = {}

    if "task_completion" in req.dimensions:
        try:
            m = TaskCompletionMetric(threshold=0.7, model=judge(), include_reason=True)
            m.measure(tc)
            out["taskCompletion"] = {"score": m.score, "success": bool(m.is_successful()), "reason": m.reason}
        except Exception as exc:  # noqa: BLE001 — surface, never crash the request
            out["taskCompletion"] = {"error": str(exc)}

    if "tool_correctness" in req.dimensions and req.expectedTools:
        try:
            # Deterministic (called-vs-expected). include_reason=False keeps it
            # LLM-free; model=judge() avoids DeepEval's default OpenAI model so
            # it works regardless of the configured provider.
            m = ToolCorrectnessMetric(model=judge(), include_reason=False)
            m.measure(tc)
            out["toolCorrectness"] = {"score": m.score, "success": bool(m.is_successful())}
        except Exception as exc:  # noqa: BLE001
            out["toolCorrectness"] = {"error": str(exc)}

    if "conformance" in req.dimensions:
        try:
            g = GEval(
                name="SpecConformance",
                model=judge(),
                criteria=(
                    "Decide whether the agent's actual_output and tool usage CONFORM to its SPEC "
                    "(it stayed on-task, respected its responsibilities, and did nothing outside its "
                    f"remit). SPEC:\n{req.spec}"
                ),
                # TOOLS_CALLED is REQUIRED here: the criteria judges "tool usage",
                # and for tool-only agents (HRBP — a backend provisioning saga with
                # no chat prose) the entire behavior lives in the tool sequence. With
                # only INPUT+ACTUAL_OUTPUT the GEval saw a terse synthesized summary
                # and scored every HRBP run 0; chat agents (Insights/CAIO) carried
                # enough signal in actual_output to pass, masking the omission.
                evaluation_params=[
                    LLMTestCaseParams.INPUT,
                    LLMTestCaseParams.ACTUAL_OUTPUT,
                    LLMTestCaseParams.TOOLS_CALLED,
                ],
            )
            g.measure(tc)
            out["conformance"] = {"score": g.score, "success": bool(g.is_successful()), "reason": g.reason}
        except Exception as exc:  # noqa: BLE001
            out["conformance"] = {"error": str(exc)}

    return out
