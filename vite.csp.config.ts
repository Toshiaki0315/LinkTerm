import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * CSP の検査用に、E2E の画面（e2e/index.html）を製品と同じ形（バンドル済み・インラインのスクリプトなし）で
 * 配信するための設定。`npm run test:e2e` が自動で使う。
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist-e2e",
    emptyOutDir: true,
    rollupOptions: { input: "e2e/index.html" },
  },
  preview: { port: 1521, strictPort: true, host: "127.0.0.1" },
});
