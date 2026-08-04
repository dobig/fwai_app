import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import pkg from "./package.json";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // 和 vite.config.ts 同源。单测里也要能读到真实版本号，否则「请求头跟着
  // package.json 变」这条就没法测。
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setupGlobals.ts", "./tests/setupTests.ts"],
    globals: true,
    // tests/live 要连一个真在跑的 gateway，这里跑不了（也不该跑 —— 单测的前提
    // 就是不依赖外部进程）。它走 vitest.live.config.ts，入口是
    // scripts/live-gateway-test.sh。
    exclude: ["node_modules/**", "dist/**", "tests/live/**"],
    coverage: {
      reporter: ["text", "lcov"],
    },
  },
});
