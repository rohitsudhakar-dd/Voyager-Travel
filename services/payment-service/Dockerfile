# payment-service -- Python 3.12 / FastAPI. Authorizations, captures, refunds.

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
EXPOSE 4040

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "4040"]
