FROM python:3.13-slim
ARG TAVERN_VERSION=0.4.0
ARG TAVERN_COMMIT=unknown
ARG TAVERN_BUILD_DATE=unknown
ARG TAVERN_CHANNEL=stable
ARG TAVERN_IMAGE_TAG=local
ENV TAVERN_VERSION=${TAVERN_VERSION} TAVERN_COMMIT=${TAVERN_COMMIT} TAVERN_BUILD_DATE=${TAVERN_BUILD_DATE} TAVERN_CHANNEL=${TAVERN_CHANNEL} TAVERN_IMAGE_TAG=${TAVERN_IMAGE_TAG}
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 API_DATA_DIR=/data
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && groupadd -g 10001 tavern && useradd -u 10001 -g tavern -M tavern && mkdir /data && chown tavern:tavern /data
COPY . .
USER 10001:10001
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health',timeout=3)"
CMD ["python", "server.py"]
