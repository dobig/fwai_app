import React, { createContext, useContext, useEffect, useState } from "react";
import type { AppId } from "@/lib/api";
import { ALL_APPS } from "@/lib/apps";

const STORAGE_KEY = "cc-switch-last-app";
const DEFAULT_APP: AppId = "claude";

interface ActiveAppContextValue {
  activeApp: AppId;
  setActiveApp: (app: AppId) => void;
}

const ActiveAppContext = createContext<ActiveAppContextValue | undefined>(
  undefined,
);

const getInitialApp = (): AppId => {
  if (typeof window === "undefined") return DEFAULT_APP;
  const saved = window.localStorage.getItem(STORAGE_KEY) as AppId | null;
  if (saved && ALL_APPS.includes(saved)) return saved;
  return DEFAULT_APP;
};

/// 当前选中的 CLI（Claude / Codex / Gemini）。
///
/// 提到 App 外面是因为转发面板（LlmGatewaySubscriptionDock）是 <App/> 的兄弟
/// 节点，却必须知道用户选的是哪个 app：转发只写当前这个 app 的配置，切走时还要
/// 把上一个还原回去。
export function ActiveAppProvider({
  children,
  initialApp,
}: {
  children: React.ReactNode;
  initialApp?: AppId;
}) {
  const [activeApp, setActiveApp] = useState<AppId>(
    () => initialApp ?? getInitialApp(),
  );

  // 持久化只在这里做一次。以前 App.tsx 和 AppSwitcher.tsx 各写各的，同一个 key
  // 两个写者，迟早会漂。
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, activeApp);
  }, [activeApp]);

  return (
    <ActiveAppContext.Provider value={{ activeApp, setActiveApp }}>
      {children}
    </ActiveAppContext.Provider>
  );
}

/// 没有 Provider 时退回组件自己的 state，而不是抛错（useTheme 会抛）：裸渲染
/// 单个组件的测试不该为了读一个 app id 就被迫全部包一层。
///
/// 退回的是真 state 而不是一个空函数——空函数会让「切 app」静默失效，渲染时
/// 忘了包 Provider 就变成一个查不出来的 bug。
export function useActiveApp(): ActiveAppContextValue {
  const context = useContext(ActiveAppContext);
  const [standalone, setStandalone] = useState<AppId>(DEFAULT_APP);
  if (context !== undefined) return context;
  return { activeApp: standalone, setActiveApp: setStandalone };
}
