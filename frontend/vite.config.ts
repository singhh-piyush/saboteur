import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// All frontend URLs are relative; in dev Vite proxies them to the FastAPI
// orchestrator, and in production FastAPI serves frontend/dist itself, so
// the same build works in both modes with zero config.
const BACKEND = "http://localhost:8000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/runs": BACKEND,
      "/profiles": BACKEND,
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
