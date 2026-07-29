import type { PricingModelSourceOption } from "../ProviderAdvancedConfig";

// ── Default configs ──────────────────────────────────────────────────

export const CLAUDE_DEFAULT_CONFIG = JSON.stringify({ env: {} }, null, 2);
export const CODEX_DEFAULT_CONFIG = JSON.stringify(
  { auth: {}, config: "" },
  null,
  2,
);
export const GEMINI_DEFAULT_CONFIG = JSON.stringify(
  {
    env: {
      GOOGLE_GEMINI_BASE_URL: "",
      GEMINI_API_KEY: "",
      GEMINI_MODEL: "gemini-3-pro-preview",
    },
  },
  null,
  2,
);

export const normalizePricingSource = (
  value?: string,
): PricingModelSourceOption =>
  value === "request" || value === "response" ? value : "inherit";
