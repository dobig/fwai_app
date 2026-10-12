import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LanguageSettings } from "@/components/settings/LanguageSettings";
import { ThemeSettings } from "@/components/settings/ThemeSettings";
import { WindowSettings } from "@/components/settings/WindowSettings";
import { GatewayAccountSettings } from "./GatewayAccountSettings";
import { AppVisibilitySettings } from "@/components/settings/AppVisibilitySettings";
import { TerminalSettings } from "@/components/settings/TerminalSettings";
import { AboutSection } from "@/components/settings/AboutSection";
import { useSettings } from "@/hooks/useSettings";
import { useTranslation } from "react-i18next";
import type { SettingsFormState } from "@/hooks/useSettings";

// 设置页只有三个 tab：通用 / 高级 / 关于。原来的「数据」tab（配置目录、导入导出、
// 备份、日志）已经整体去掉 —— 这些都是旧版多供应商切换器留下的，网关客户端用不上。
// 所有设置都在改动时即时保存，没有「保存」按钮，也不会要求重启。

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: string;
}

// onOpenChange 仍在 props 里：App 以「切回供应商列表」的形式传它，设置页本身
// 现在没有任何会主动关闭自己的操作（原来只有「保存」会关）。
export function SettingsPage({
  open,
  defaultTab = "general",
}: SettingsDialogProps) {
  const { t } = useTranslation();
  const { settings, isLoading, isPortable, updateSettings, autoSaveSettings } =
    useSettings();

  const [activeTab, setActiveTab] = useState<string>("general");

  useEffect(() => {
    if (open) setActiveTab(defaultTab);
  }, [open, defaultTab]);

  // 通用设置即时保存（无需手动点击）
  // 使用 autoSaveSettings 避免误触发系统 API（开机自启、Claude 插件等）
  const handleAutoSave = useCallback(
    async (updates: Partial<SettingsFormState>) => {
      if (!settings) return;
      updateSettings(updates);
      try {
        await autoSaveSettings(updates);
      } catch (error) {
        console.error("[SettingsPage] Failed to autosave settings", error);
        toast.error(
          t("settings.saveFailedGeneric", {
            defaultValue: "保存失败，请重试",
          }),
        );
      }
    },
    [autoSaveSettings, settings, t, updateSettings],
  );

  const isBusy = useMemo(() => isLoading && !settings, [isLoading, settings]);

  return (
    <div className="flex flex-col h-full overflow-hidden px-6">
      {isBusy ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex flex-col h-full"
        >
          <TabsList className="grid w-full grid-cols-3 mb-6 glass rounded-lg">
            <TabsTrigger value="general">
              {t("settings.tabGeneral")}
            </TabsTrigger>
            <TabsTrigger value="advanced">
              {t("settings.tabAdvanced")}
            </TabsTrigger>
            <TabsTrigger value="about">{t("common.about")}</TabsTrigger>
          </TabsList>

          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex-1 overflow-y-auto overflow-x-hidden pr-2">
              <TabsContent value="general" className="space-y-6 mt-0">
                {settings ? (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3 }}
                    className="space-y-6"
                  >
                    <LanguageSettings
                      value={settings.language}
                      onChange={(lang) => handleAutoSave({ language: lang })}
                    />
                    <ThemeSettings />
                    <AppVisibilitySettings
                      settings={settings}
                      onChange={handleAutoSave}
                    />
                    <WindowSettings
                      settings={settings}
                      onChange={handleAutoSave}
                    />
                    <TerminalSettings
                      value={settings.preferredTerminal}
                      onChange={(terminal) =>
                        handleAutoSave({ preferredTerminal: terminal })
                      }
                    />
                  </motion.div>
                ) : null}
              </TabsContent>

              <TabsContent value="advanced" className="space-y-6 mt-0">
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                  className="space-y-6"
                >
                  <GatewayAccountSettings />
                </motion.div>
              </TabsContent>

              <TabsContent value="about" className="mt-0">
                <AboutSection isPortable={isPortable} />
              </TabsContent>
            </div>
          </div>
        </Tabs>
      )}
    </div>
  );
}
