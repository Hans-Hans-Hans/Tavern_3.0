FROM python:3.12-alpine
RUN pip install --no-cache-dir PyYAML==6.0.3
WORKDIR /app
COPY docker/init/provision.py /app/provision.py
COPY docker/init/state_archive.py /app/state_archive.py
COPY synapse_modules /app/modules
ENTRYPOINT ["python", "/app/provision.py"]
