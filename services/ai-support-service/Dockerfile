# ai-support-service -- Python 3.12 / FastAPI. Support chat and LLM orchestration.

FROM python:3.12-slim AS builder

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r /tmp/requirements.txt


FROM python:3.12-slim

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app

RUN useradd --system --uid 10001 --create-home --shell /usr/sbin/nologin voyager

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
COPY --chown=voyager:voyager . /app

USER voyager
EXPOSE 4070

# Source Code Integration. Baked at build time because the running container
# has no git: without these two, an Error Tracking stack frame is text rather
# than a link to the line on the default branch.
ARG DD_GIT_REPOSITORY_URL=""
ARG DD_GIT_COMMIT_SHA=""
ENV DD_GIT_REPOSITORY_URL=$DD_GIT_REPOSITORY_URL \
    DD_GIT_COMMIT_SHA=$DD_GIT_COMMIT_SHA

# ddtrace-run, not a sitecustomize import: it sets up the import hooks before
# the interpreter loads app code, so fastapi, asyncpg, aiokafka and httpx are
# all patched. Call uvicorn directly and the patching races module import --
# typically leaving the database and Kafka spans missing while HTTP still
# works, which looks like a partial outage rather than a config mistake.
CMD ["ddtrace-run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "4070"]
