import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { codeInspectorPlugin } from "code-inspector-plugin";
import pkg from "./package.json";

export default defineConfig(({ command }) => ({
  root: "src",
  plugins: [
    command === "serve" &&
      codeInspectorPlugin({
        bundler: "vite",
      }),
    react(),
  ].filter(Boolean),
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // 版本号从 package.json 注入，不写常量。手写常量迟早会忘记更新——上一版
  // 的 app_version 在代码里躺了几十个版本一直是同一个字符串，服务端因此完全
  // 无法区分新旧客户端。tauri.conf.json 里的版本号和这里同源，取任一即可。
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
}));
