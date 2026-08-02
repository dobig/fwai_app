// 联调用的 vitest 配置：只跑 tests/live，且**不装 MSW**。
//
// 和 vitest.config.ts 的唯一实质区别就是 setupFiles 少了 setupTests.ts ——
// 那里面 server.listen() 会把所有请求截到 mock 上，而这些用例的全部意义
// 就是不走 mock。
import path from "node:path";
import { defineConfig } from "vitest/config";
import pkg from "./package.json";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setupGlobals.ts"],
    globals: true,
    include: ["tests/live/**/*.live.test.ts"],
    // 真的要连一个进程、下真实订单、轮询回调，比单测慢一个量级。
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // 用例之间共享服务端状态（买过的套餐留在那儿），并发跑必然互相踩。
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
