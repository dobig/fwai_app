/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Baked at build time by the release workflow so shipped binaries default to
  // the prod gateway; unset in local dev (falls back to localhost).
  readonly VITE_GATEWAY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * 构建期注入的应用版本号（来自 package.json 的 version）。
 * 由 vite.config.ts / vitest.config.ts 的 define 提供。
 */
declare const __APP_VERSION__: string;
