# Saboteur dashboard

The Vite + React + Tailwind chaos console: live cohort grid, chaos feed,
per-agent timeline, resilience scorecard, plus the Targets / Profile Builder /
Runs / Compare pages and the static landing + walkthrough demo.

State is event-sourced: one pure reducer (`src/state/reducer.ts`) folds
`TelemetryEvent`s from the WebSocket (or a replayed JSONL) into all view state,
so live and replay render identically by construction.

## Develop

```bash
npm ci
npm run dev        # Vite dev server on :5173, proxying API calls to :8000
```

Set `VITE_API_BASE_URL` if the FastAPI backend is not on `localhost:8000`.

## Build & test

```bash
npm run build      # tsc --noEmit + vite build, outputs dist/ (served by FastAPI)
npm test           # vitest (reducer determinism / live-replay parity)
```

## Demo data

`src/demo/` bundles the recorded run(s) that drive the walkthrough and the
landing scorecard. To swap or add one, see the header comment in
`src/demo/index.ts`.
