# fwai_app

[LLM Gateway](https://fwai.space) 的桌面客户端 —— Claude Code / Codex / Gemini CLI 的供应商管理与一键切换。

## 下载

到 [Releases](https://github.com/dobig/fwai_app/releases/latest) 取对应平台的安装包:

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| macOS (Apple Silicon) | `fwai_app_X.Y.Z_aarch64.dmg` | Developer ID 签名 + 公证,双击直接打开 |
| macOS (Intel) | `fwai_app_X.Y.Z_x64.dmg` | 同上 |
| Windows | `fwai_app_X.Y.Z_x64-setup.exe` | 未签名,首次运行 SmartScreen 会提示,选"仍要运行" |
| Windows | `fwai_app_X.Y.Z_x64_en-US.msi` | 同上,适合批量部署 |

## 使用

1. 打开应用,LLM Gateway 自动出现在 Claude / Codex 的供应商列表
2. 在面板中登录并开启转发
3. 在供应商列表中启用 LLM Gateway(此时才写入 CLI 配置;切换会先恢复原配置)

配置目录 `~/.fwai_app`,与上游 cc-switch 的 `~/.cc-switch` 完全独立,两个应用可以共存,互不读写。

## 这是一个 fork

本项目是 [farion1231/cc-switch](https://github.com/farion1231/cc-switch)(MIT)的**硬分叉**,不是上游的
发行版,也不与上游同步——只保留供应商管理核心(添加/编辑/切换,写入各 CLI 的配置文件)和托盘快速切换,
再加上 LLM Gateway 的登录/订阅/额度面板。上游的代理服务器、WebDAV 同步、MCP/Skills 管理等一律不在这里,
需要那些功能请直接用上游。

许可证沿用 MIT,原作者版权声明保留在 [LICENSE](LICENSE)。

## 开发

```bash
pnpm install
pnpm tauri dev      # 开发
pnpm tauri build    # 构建

pnpm run typecheck && pnpm run test:unit               # 前端
cd src-tauri && cargo fmt --check && cargo test --lib  # 后端
```

网关地址在构建期由 `VITE_GATEWAY_URL` 烘焙进产物,默认 `https://api.fwai.space`;
本地联调用 `VITE_GATEWAY_URL=http://127.0.0.1:8080 pnpm tauri dev`。

## 发布

推 `vX.Y.Z` tag,CI 在 GitHub 托管的 macOS 和 Windows runner 上构建四个安装包并挂到**草稿** release,
确认无误后手动发布。完整步骤和一次性的签名配置见 [docs/release.md](docs/release.md)。
