import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:5173",
    channel: "chrome",
    headless: true,
  },
  webServer: [
    {
      command:
        process.platform === "win32"
          ? ".\\.venv\\Scripts\\python.exe -m host_agent"
          : "./.venv/bin/python -m host_agent",
      cwd: "./services/host-agent",
      url: "http://127.0.0.1:8765/health",
      reuseExistingServer: !process.env.CI,
      env: {
        HOST_DATA_DIR: "../../.e2e-tmp/data",
        HOST_CACHE_DIR: "../../.e2e-tmp/cache",
      },
    },
    {
      command: "npm run dev --workspace apps/web -- --port 5173 --strictPort",
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
    },
  ],
});
