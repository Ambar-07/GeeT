import { defineConfig } from "@playwright/test";

// Frontend regression checks with a simulated host; no music library is modified.
export default defineConfig({
  testDir: "./tests/ui",
  timeout: 30_000,
  workers: 2,
  globalSetup: "./tests/ui/server.ts",
  use: { baseURL: "http://127.0.0.1:5190", channel: "chrome", headless: true },
});
