# Seeder -- one-shot bulk loader. Not part of `make up`; see the `tools`
# profile in docker-compose.yml.

FROM python:3.12-slim AS builder

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r /tmp/requirements.txt


FROM python:3.12-slim

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN useradd --system --uid 10001 --create-home --shell /usr/sbin/nologin voyager

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
COPY --chown=voyager:voyager . /app

USER voyager

ENTRYPOINT ["python", "seed.py"]
CMD ["--yes"]
