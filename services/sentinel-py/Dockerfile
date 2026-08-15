# syntax=docker/dockerfile:1
# Build context is the repo ROOT, matching every other service here:
#   docker build -f services/sentinel-py/Dockerfile -t tradew-sentinel-py .
#
# The paths below are therefore repo-relative. They were briefly written as
# if the context were this directory, which silently resolved `pyproject.toml`
# to the repo's npm manifest and failed on `COPY app`. Nothing caught it
# because this image had no CI job — added in the same change as this fix.

FROM python:3.11-slim

WORKDIR /app

# Dependencies first so a code-only change does not reinstall them.
COPY services/sentinel-py/pyproject.toml ./
COPY services/sentinel-py/app ./app

RUN pip install --no-cache-dir .

# Internal service; the compose/K8s layer sets HOST=0.0.0.0 behind the
# private network boundary. See app/core/config.py for the defaults.
EXPOSE 4011

CMD ["python", "-m", "app.main"]
