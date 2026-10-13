import React from "react";
import type { AppId } from "@/lib/api/types";
import { ClaudeIcon, CodexIcon, GeminiIcon } from "@/components/BrandIcons";

export interface AppConfig {
  label: string;
  icon: React.ReactNode;
  activeClass: string;
  badgeClass: string;
}

export const APP_IDS: AppId[] = ["claude", "claude-desktop", "codex", "gemini"];

export const APP_ICON_MAP: Record<AppId, AppConfig> = {
  claude: {
    label: "Claude",
    icon: <ClaudeIcon size={14} />,
    activeClass:
      "bg-orange-500/10 ring-1 ring-orange-500/20 hover:bg-orange-500/20 text-orange-600 dark:text-orange-400",
    badgeClass:
      "bg-orange-500/10 text-orange-700 dark:text-orange-300 hover:bg-orange-500/20 border-0 gap-1.5",
  },
  "claude-desktop": {
    label: "Claude Desktop",
    icon: <ClaudeIcon size={14} />,
    activeClass:
      "bg-amber-500/10 ring-1 ring-amber-500/20 hover:bg-amber-500/20 text-amber-700 dark:text-amber-300",
    badgeClass:
      "bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 border-0 gap-1.5",
  },
  codex: {
    label: "Codex",
    icon: <CodexIcon size={14} />,
    activeClass:
      "bg-green-500/10 ring-1 ring-green-500/20 hover:bg-green-500/20 text-green-600 dark:text-green-400",
    badgeClass:
      "bg-green-500/10 text-green-700 dark:text-green-300 hover:bg-green-500/20 border-0 gap-1.5",
  },
  gemini: {
    label: "Gemini",
    icon: <GeminiIcon size={14} />,
    activeClass:
      "bg-blue-500/10 ring-1 ring-blue-500/20 hover:bg-blue-500/20 text-blue-600 dark:text-blue-400",
    badgeClass:
      "bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20 border-0 gap-1.5",
  },
};
