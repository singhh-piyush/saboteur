# Saboteur — CI/runtime image.
#
# Carries the package, the chaos profiles, and the bundled deterministic mock
# model, so the resilience gate runs anywhere with no GPU:
#
#   docker build -t saboteur:ci .
#   # offline demo (mock model, reference agent):
#   docker run --rm -v "$PWD/runs:/app/runs" saboteur:ci \
#       run --target reference --mock --profile hell_mode --ci --metric survival_rate --threshold 0.85
#   # against your own model (no --mock): pass the endpoint as env
#   docker run --rm -v "$PWD/runs:/app/runs" \
#       -e OPENAI_BASE_URL=... -e OPENAI_API_KEY=... -e MODEL_ID=... saboteur:ci \
#       run --target reference --profile hell_mode --ci --threshold 0.85
#
# ENTRYPOINT is the `saboteur` CLI, so `docker run saboteur:ci <subcommand> ...`.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Install deps first (better layer caching), then the package.
COPY pyproject.toml README.md ./
COPY saboteur ./saboteur
COPY profiles ./profiles
COPY examples ./examples
RUN pip install .

# Artifact dir — mount a host path here to collect scorecards/JSONL.
RUN mkdir -p runs

ENTRYPOINT ["saboteur"]
CMD ["--help"]
