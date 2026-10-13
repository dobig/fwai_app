import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeDesktopProviderForm } from "@/components/providers/forms/ClaudeDesktopProviderForm";

const toasts = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toasts }));

vi.mock("@/lib/api/llm-gateway", () => ({
  getGatewayBaseURL: () => "https://api.fwai.space",
  gatewayOAuthAccessToken: () => "sk-from-login",
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function renderForm(
  props: Partial<Parameters<typeof ClaudeDesktopProviderForm>[0]> = {},
) {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(
    <ClaudeDesktopProviderForm
      submitLabel="添加"
      onSubmit={onSubmit}
      onCancel={vi.fn()}
      {...props}
    />,
  );
  return { onSubmit };
}

describe("ClaudeDesktopProviderForm", () => {
  it("prefills credentials from the gateway login when adding", () => {
    // token 是一串 JWT，让用户自己抄过来不现实
    renderForm();
    expect(screen.getByLabelText("API 端点")).toHaveValue(
      "https://api.fwai.space",
    );
    expect(screen.getByLabelText("API Key")).toHaveValue("sk-from-login");
  });

  it("does not prefill when editing an existing provider", () => {
    renderForm({
      initialData: {
        name: "Mine",
        settingsConfig: {
          env: {
            ANTHROPIC_BASE_URL: "https://custom.example.com",
            ANTHROPIC_AUTH_TOKEN: "sk-mine",
          },
        },
      },
    });
    expect(screen.getByLabelText("API 端点")).toHaveValue(
      "https://custom.example.com",
    );
    expect(screen.getByLabelText("API Key")).toHaveValue("sk-mine");
  });

  it("submits credentials and the ticked models", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();

    await user.type(screen.getByLabelText("名称"), "LLM Gateway");
    await user.click(screen.getByRole("button", { name: "添加" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(JSON.parse(payload.settingsConfig)).toEqual({
      env: {
        ANTHROPIC_BASE_URL: "https://api.fwai.space",
        ANTHROPIC_AUTH_TOKEN: "sk-from-login",
      },
    });
    // 只支持直连
    expect(payload.meta.claudeDesktopMode).toBe("direct");
    // 默认勾上的三档都在，Fable 默认不勾
    expect(Object.keys(payload.meta.claudeDesktopModelRoutes).sort()).toEqual([
      "claude-haiku-4-5-20251001",
      "claude-opus-5",
      "claude-sonnet-5",
    ]);
  });

  it("refuses to save a model name Desktop would reject", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();

    await user.type(screen.getByLabelText("名称"), "Mine");
    const sonnet = screen.getByLabelText("Sonnet 模型名");
    await user.clear(sonnet);
    await user.type(sonnet, "gpt-5.6");

    await user.click(screen.getByRole("button", { name: "添加" }));

    // 不合规不是「这个模型不可用」，而是 Desktop 会拒收整组、模型菜单整个空掉，
    // 所以这里不给「仍要保存」的台阶
    expect(onSubmit).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenCalledWith(
      expect.stringContaining("gpt-5.6"),
    );
  });

  it("requires a name", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await user.click(screen.getByRole("button", { name: "添加" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenCalledWith("请填写供应商名称");
  });

  it("tells the user Desktop needs a restart", () => {
    renderForm();
    expect(screen.getByText(/重启 Claude App/)).toBeInTheDocument();
  });

  it("keeps an existing model selection when editing", () => {
    renderForm({
      initialData: {
        name: "Mine",
        meta: {
          claudeDesktopModelRoutes: {
            "claude-opus-5": { model: "claude-opus-5", supports1m: true },
          },
        },
      },
    });
    expect(screen.getByLabelText("Opus 模型名")).toHaveValue("claude-opus-5");
    // 存过的档位勾上，没存过的不勾。未勾选行的 1M 标记无所谓——rowsToMeta 不读它。
    expect(screen.getByLabelText("Opus")).toBeChecked();
    expect(screen.getByLabelText("Sonnet")).not.toBeChecked();
  });
});
