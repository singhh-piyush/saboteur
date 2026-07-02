import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// All frontend URLs are relative by default; in dev Vite proxies them to the
// FastAPI orchestrator, and in production FastAPI serves frontend/dist itself,
// so the same build works in both modes with zero config. When the API runs on
// a non-default port (tunnels, split ports), set VITE_API_BASE_URL: the dev
// proxy retargets it here, and src/lib/api.ts rebases requests onto it at
// runtime (so a static deploy works too).
const BACKEND = process.env.VITE_API_BASE_URL || "http://localhost:8000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/runs": BACKEND,
      "/profiles": BACKEND,
      "/targets": BACKEND,
      "/faults": BACKEND,
      "/replay": BACKEND,
      "/health": BACKEND,
      "/ws": { target: BACKEND, ws: true },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
