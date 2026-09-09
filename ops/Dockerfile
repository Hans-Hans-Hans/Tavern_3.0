FROM python:3.13-slim
ARG TAVERN_VERSION=0.4.0
ENV TAVERN_VERSION=${TAVERN_VERSION}
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY ops/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY ops/server.py /app/server.py
COPY ops/smoke.py /app/smoke.py
COPY scripts/operations.py /app/archive_host.py
EXPOSE 8091
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8091/health',timeout=3)"
CMD ["python", "/app/server.py"]
