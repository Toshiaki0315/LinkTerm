import { defineConfig } from "@playwright/test";

const PORT = 1520;
/** CSP の検査用（製品と同じ形にバンドルした画面）。 */
export const CSP_PORT = 1521;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1200, height: 800 },
  },
  webServer: [
    {
      command: `npx vite --port ${PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${PORT}/e2e/index.html`,
      reuseExistingServer: true,
      timeout: 60_000,
      stdout: "ignore",
    },
    {
      command: `npx vite build --config vite.csp.config.ts && npx vite preview --config vite.csp.config.ts`,
      url: `http://127.0.0.1:${CSP_PORT}/e2e/index.html`,
      reuseExistingServer: true,
      timeout: 120_000,
      stdout: "ignore",
    },
  ],
});
