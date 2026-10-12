import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { createContext, useContext, type ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettingsPage } from "@/components/settings/SettingsPage";

const toastErrorMock = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

const tMock = vi.fn((key: string) => key);
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: tMock }),
}));

interface SettingsMock {
  settings: any;
  isLoading: boolean;
  isPortable: boolean;
  updateSettings: ReturnType<typeof vi.fn>;
  autoSaveSettings: ReturnType<typeof vi.fn>;
}

const createSettingsMock = (overrides: Partial<SettingsMock> = {}) => {
  const base: SettingsMock = {
    settings: {
      showInTray: true,
      minimizeToTrayOnClose: true,
      language: "zh",
    },
    isLoading: false,
    isPortable: false,
    updateSettings: vi.fn(),
    autoSaveSettings: vi.fn().mockResolvedValue({ requiresRestart: false }),
  };
  return { ...base, ...overrides };
};

let settingsMock = createSettingsMock();

vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => settingsMock,
}));

const TabsContext = createContext<{
  value: string;
  onValueChange?: (value: string) => void;
}>({
  value: "general",
});

vi.mock("@/components/ui/tabs", () => {
  return {
    Tabs: ({ value, onValueChange, children }: any) => (
      <TabsContext.Provider value={{ value, onValueChange }}>
        <div data-testid="tabs">{children}</div>
      </TabsContext.Provider>
    ),
    TabsList: ({ children }: any) => <div>{children}</div>,
    TabsTrigger: ({ value, children }: any) => {
      const ctx = useContext(TabsContext);
      return (
        <button type="button" onClick={() => ctx.onValueChange?.(value)}>
          {children}
        </button>
      );
    },
    TabsContent: ({ value, children }: any) => {
      const ctx = useContext(TabsContext);
      if (ctx.value !== value) return null;
      return <div data-testid={`tab-${value}`}>{children}</div>;
    },
  };
});

vi.mock("@/components/settings/LanguageSettings", () => ({
  LanguageSettings: ({ value, onChange }: any) => (
    <div>
      <span>language:{value}</span>
      <button onClick={() => onChange("en")}>change-language</button>
    </div>
  ),
}));

vi.mock("@/components/settings/ThemeSettings", () => ({
  ThemeSettings: () => <div>theme-settings</div>,
}));

vi.mock("@/components/settings/AppVisibilitySettings", () => ({
  AppVisibilitySettings: () => <div>app-visibility-settings</div>,
}));

vi.mock("@/components/settings/TerminalSettings", () => ({
  TerminalSettings: () => <div>terminal-settings</div>,
}));

vi.mock("@/components/settings/WindowSettings", () => ({
  WindowSettings: ({ onChange }: any) => (
    <button onClick={() => onChange({ minimizeToTrayOnClose: false })}>
      window-settings
    </button>
  ),
}));

vi.mock("@/components/settings/GatewayAccountSettings", () => ({
  GatewayAccountSettings: () => <div>gateway-account-settings</div>,
}));

vi.mock("@/components/settings/AboutSection", () => ({
  AboutSection: ({ isPortable }: any) => <div>about:{String(isPortable)}</div>,
}));

const renderSettingsPage = (
  props?: Partial<ComponentProps<typeof SettingsPage>>,
) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <SettingsPage open={true} onOpenChange={vi.fn()} {...props} />
    </QueryClientProvider>,
  );
};

describe("SettingsPage Component", () => {
  beforeEach(() => {
    tMock.mockImplementation((key: string) => key);
    settingsMock = createSettingsMock();
    toastErrorMock.mockReset();
  });

  it("should not render form content when loading", () => {
    settingsMock = createSettingsMock({ settings: null, isLoading: true });

    renderSettingsPage();

    expect(screen.queryByText("language:zh")).not.toBeInTheDocument();
    // 加载状态下显示 spinner 而不是表单内容
    expect(document.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("should render only general / advanced / about tabs", () => {
    renderSettingsPage();

    expect(screen.getByText("settings.tabGeneral")).toBeInTheDocument();
    expect(screen.getByText("settings.tabAdvanced")).toBeInTheDocument();
    expect(screen.getByText("common.about")).toBeInTheDocument();
    // 「数据」tab（配置目录 / 导入导出 / 备份 / 日志）已整体去掉，连同它底部的
    // 「保存」按钮。这里钉住它别复活。
    expect(screen.queryByText("settings.tabData")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /common\.save/ }),
    ).not.toBeInTheDocument();
  });

  it("should autosave general settings and show account settings under advanced", async () => {
    renderSettingsPage();

    expect(screen.getByText("language:zh")).toBeInTheDocument();
    expect(screen.getByText("theme-settings")).toBeInTheDocument();
    // 账号级设置不在「通用」，在「高级」。
    expect(
      screen.queryByText("gateway-account-settings"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("change-language"));
    expect(settingsMock.updateSettings).toHaveBeenCalledWith({
      language: "en",
    });
    await waitFor(() =>
      expect(settingsMock.autoSaveSettings).toHaveBeenCalledWith({
        language: "en",
      }),
    );

    fireEvent.click(screen.getByText("window-settings"));
    expect(settingsMock.updateSettings).toHaveBeenCalledWith({
      minimizeToTrayOnClose: false,
    });

    fireEvent.click(screen.getByText("settings.tabAdvanced"));
    expect(screen.getByText("gateway-account-settings")).toBeInTheDocument();
    expect(screen.queryByText("language:zh")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("common.about"));
    expect(screen.getByText("about:false")).toBeInTheDocument();
  });

  it("should open on the requested default tab", () => {
    renderSettingsPage({ defaultTab: "advanced" });

    expect(screen.getByText("gateway-account-settings")).toBeInTheDocument();
    expect(screen.queryByText("language:zh")).not.toBeInTheDocument();
  });

  it("should toast when autosave fails", async () => {
    settingsMock = createSettingsMock({
      autoSaveSettings: vi.fn().mockRejectedValue(new Error("boom")),
    });

    renderSettingsPage();
    fireEvent.click(screen.getByText("change-language"));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("settings.saveFailedGeneric"),
    );
  });
});
