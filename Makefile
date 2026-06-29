.PHONY: dev test lint run-calm up down logs ps build run

VENV := .venv/bin

# Compose stack uses compose.env for interpolation so the container ignores the
# host .env (which points inference at localhost — wrong inside a container).
COMPOSE := docker compose --env-file compose.env

dev:  ## start llama-server + uvicorn + vite (Ctrl+C tears down)
	@./scripts/dev.sh

test:  ## run the full pytest suite
	@$(VENV)/python -m pytest

lint:  ## ruff check + mypy
	@$(VENV)/ruff check . && $(VENV)/mypy saboteur

run-calm:  ## Stage-1 gate: POST a calm_seas N=8 run to the running API
	@curl -fsS -X POST localhost:8000/runs \
		-H 'Content-Type: application/json' \
		-d '{"profile":"calm_seas","n_agents":8}'
	@echo

# ---- Docker stack (host llama-server must be running with --host 0.0.0.0) ----

up:  ## build + start the console container, then wait for it to be healthy
	@$(COMPOSE) up --build -d
	@echo "[make up] waiting for http://localhost:8000/health ..."
	@for i in $$(seq 1 30); do \
		curl -fsS localhost:8000/health >/dev/null 2>&1 && \
			{ echo "[make up] console healthy → http://localhost:8000"; exit 0; }; \
		sleep 2; \
	done; \
	echo "[make up] not healthy yet — check 'make logs'"; exit 1

down:  ## stop + remove the console container (runs/ persists on the host)
	@$(COMPOSE) down

logs:  ## follow the console container logs
	@$(COMPOSE) logs -f console

ps:  ## show compose service status
	@$(COMPOSE) ps

build:  ## build the console image without starting it
	@$(COMPOSE) build

run:  ## POST a reference cohort to the running console (PROFILE=flaky_friday make run)
	@curl -fsS -X POST localhost:8000/runs \
		-H 'Content-Type: application/json' \
		-d '{"profile":"$(or $(PROFILE),flaky_friday)","target":"reference"}'
	@echo
