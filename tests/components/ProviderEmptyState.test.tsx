import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProviderEmptyState } from "@/components/providers/ProviderEmptyState";

// 测试环境的 i18n resources 是空的，t() 直接返回 key，所以这里断言 key。

describe("ProviderEmptyState", () => {
  it("offers importing the live config for CLI apps", () => {
    render(
      <ProviderEmptyState
        appId="claude"
        onCreate={vi.fn()}
        onImport={vi.fn()}
      />,
    );
    expect(screen.getByText("provider.importCurrent")).toBeInTheDocument();
    expect(
      screen.getByText("provider.noProvidersDescription"),
    ).toBeInTheDocument();
    // 通用配置片段只对 CLI 成立
    expect(
      screen.getByText("provider.noProvidersDescriptionSnippet"),
    ).toBeInTheDocument();
  });

  it("does not offer an import button for Claude Desktop", () => {
    // Desktop 的 profile 是我们写出去的产物，没有「现有配置」可导入——后端的
    // import_default_config 对它恒返回 false，留着按钮只会让用户点一下、
    // 收到一句不相干的提示。
    render(
      <ProviderEmptyState
        appId="claude-desktop"
        onCreate={vi.fn()}
        onImport={undefined}
      />,
    );
    expect(screen.queryByText("provider.importCurrent")).toBeNull();
    // 「添加供应商」是 Desktop 唯一的入口，必须在
    expect(screen.getByText("provider.addProvider")).toBeInTheDocument();
  });

  it("swaps in Desktop-specific copy and drops the snippet hint", () => {
    render(<ProviderEmptyState appId="claude-desktop" onCreate={vi.fn()} />);
    expect(
      screen.getByText("provider.noProvidersDescriptionClaudeDesktop"),
    ).toBeInTheDocument();
    expect(screen.queryByText("provider.noProvidersDescription")).toBeNull();
    // Desktop 没有通用配置片段
    expect(
      screen.queryByText("provider.noProvidersDescriptionSnippet"),
    ).toBeNull();
  });
});
