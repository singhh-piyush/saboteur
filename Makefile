.PHONY: dev test lint run-calm

VENV := .venv/bin

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
