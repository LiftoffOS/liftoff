# deepeval-evaluator — in-boundary DeepEval scoring service (Cloud Run).
# Judges via Vertex Gemini only; no external LLM. Scales to zero.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    GCP_LOCATION=global

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY judge_config.py judge_models.py app.py ./

# Cloud Run sets $PORT; default 8080 for local runs.
ENV PORT=8080
EXPOSE 8080
CMD exec uvicorn app:app --host 0.0.0.0 --port ${PORT}
