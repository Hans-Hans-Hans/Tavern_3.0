FROM python:3.12-slim-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends build-essential libsqlite3-dev && rm -rf /var/lib/apt/lists/*
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
COPY requirements.txt requirements.lock /tmp/
RUN pip install --no-cache-dir --only-binary=vodozemac -r /tmp/requirements.txt -c /tmp/requirements.lock
FROM python:3.12-slim-bookworm
ENV PATH=/opt/venv/bin:$PATH PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
RUN useradd --uid 10001 --create-home bot && mkdir -p /app /data/crypto && chown -R bot:bot /app /data
COPY --from=builder /opt/venv /opt/venv
COPY --chown=bot:bot . /app
WORKDIR /app
USER 10001:10001
EXPOSE 8080
CMD ["python", "server.py"]
