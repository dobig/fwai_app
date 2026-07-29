/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Baked at build time by the release workflow so shipped binaries default to
  // the prod gateway; unset in local dev (falls back to localhost).
  readonly VITE_GATEWAY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
