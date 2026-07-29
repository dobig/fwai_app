# 发布 fwai_app

一次发布产出四个安装包:macOS 两个 dmg(Apple Silicon / Intel,签名 + 公证)和
Windows 的 exe + msi。全部由 GitHub 托管的 runner 构建——公开仓库上 macOS 和
Windows runner 都不计费,所以两边都在 CI 里跑,本机不需要参与。

## 一次性:macOS 签名与公证

只在换 Apple 账号或证书过期时才需要重做。做完之后每次发布都不用再碰。

**为什么必须做**:未签名或 ad-hoc 签名(`"signingIdentity": "-"`)的 dmg 会被
Gatekeeper 拦下,用户看到"无法验证开发者"。绕不过去——只有 Apple Developer
Program($99/年)签发的 **Developer ID Application** 证书 + 公证才能让用户双击直接打开。

1. **创建 Developer ID Application 证书**
   Xcode → Settings → Accounts → 登录 Apple ID → 选中 team → Manage Certificates…
   → 左下 `+` → **Developer ID Application**。
   用 Xcode 而不是网页 CSR 是因为它会顺带装好 Apple 的中间证书;走网页容易漏,
   签名时报 `unable to build chain`。
   注意别选成 "Apple Development" —— 那张只能本机调试,不能分发。

2. **导出成 .p12 再转 base64**
   钥匙串访问 → 找到刚建的证书 → 右键导出 → 选 `.p12` 格式 → 设一个导出密码。
   CI 里没有你的钥匙串,证书要以 secret 的形式带进去:

   ```bash
   base64 -i cert.p12 | pbcopy     # 存进 APPLE_CERTIFICATE
   ```

   导出密码存进 `APPLE_CERTIFICATE_PASSWORD`。存完把本地的 `.p12` 删掉。

   > **只选中那一张证书再导出。** 别用 `security export -t identities` 图省事——
   > 它会把钥匙串里的**每一张**身份都打进同一个 `.p12`。如果机器上还有
   > "Apple Development"(通常排在前面),bundler 取到的是第一张,于是签成那张只能
   > 本机调试的证书,公证阶段才被 Apple 拒:`The binary is not signed with a valid
   > Developer ID certificate`。设 `APPLE_SIGNING_IDENTITY` 也救不回来——bundler
   > 只拿它和证书里的身份做一致性校验,不会在多张里挑,对不上直接中止。
   >
   > 想确认手里的 `.p12` 是干净的:
   >
   > ```bash
   > openssl pkcs12 -in cert.p12 -nokeys -nodes | openssl x509 -noout -subject
   > ```
   >
   > 应该只输出一行,且是 `Developer ID Application`。

3. **生成 App 专用密码**
   在 [account.apple.com](https://account.apple.com) → 登录与安全 → App 专用密码
   生成一个(格式 `xxxx-xxxx-xxxx-xxxx`),存进 `APPLE_PASSWORD`。
   这不是 Apple ID 登录密码,notarytool 只认 App 专用密码。

4. **配置 repository secrets**
   Settings → Secrets and variables → Actions,五个都要有:

   | Secret | 值 |
   | --- | --- |
   | `APPLE_CERTIFICATE` | 第 2 步的 base64 |
   | `APPLE_CERTIFICATE_PASSWORD` | 第 2 步的导出密码 |
   | `APPLE_ID` | 用于公证的 Apple 账号邮箱 |
   | `APPLE_PASSWORD` | 第 3 步的 App 专用密码 |
   | `APPLE_TEAM_ID` | Developer Program 的 team id(Xcode → Settings → Accounts,或 developer.apple.com 会员详情页) |

   Apple ID 和 team id 也走 secret 而不是写进仓库——这是公开仓库,Apple ID 是私人邮箱。

凭据有效期:证书 5 年;App 专用密码永久有效,但改了 Apple ID 密码会全部失效需重新生成;
会员资格每年续费,过期后无法公证。

## 发布流程

### 1. 版本号

四处同步:

```bash
# package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml 手改版本号,然后:
cargo update -p fwai_app --manifest-path src-tauri/Cargo.toml   # 同步 Cargo.lock
```

CI 会校验 tag 和 `package.json` 是否一致,不一致直接失败——否则产物名字里的版本号
是错的,发出去再收回很麻烦。

提交为 `chore: vX.Y.Z` → PR → 合并到 main。

### 2. 建草稿 release 并打 tag

```bash
gh release create vX.Y.Z --draft --title vX.Y.Z --notes-file notes.md
git tag vX.Y.Z && git push origin vX.Y.Z
```

release notes 用中文,按"新增/修复/资产/备注"分节。先建草稿是为了让 notes 提前就位;
不建也行,CI 会自己建一个空的草稿。

### 3. 等 CI

`release.yml` 监听 `v*`,并行跑两个 job:

- **macOS**(`macos-latest`,arm64):`scripts/build-macos-release.sh` 交叉编译出两个
  架构,签名 → 公证 → staple,最后用 `spctl` 和 `stapler validate` 自检每个 dmg,
  没过就让 job 失败。公证是上传到 Apple 服务器扫描,每个包几分钟,job 超时设了 3 小时。
- **Windows**(`windows-latest`):NSIS + MSI。

两个 job 都以 `draft: true` 上传,所以在你手动发布之前,release 一直是草稿状态——
构建到一半失败也不会有半成品流出去。

### 4. 检查并发布

四个资产齐全后:

```bash
gh release view vX.Y.Z          # 确认四个资产都在
gh release edit vX.Y.Z --draft=false
```

- `fwai_app_X.Y.Z_aarch64.dmg`(Apple Silicon)
- `fwai_app_X.Y.Z_x64.dmg`(Intel)
- `fwai_app_X.Y.Z_x64-setup.exe`、`fwai_app_X.Y.Z_x64_en-US.msi`(Windows)

想验证 macOS 包是不是真的干净,下载下来跑一遍(CI 已经自检过,这是复核):

```bash
spctl -a -t open -vv --context context:primary-signature <dmg>   # source=Notarized Developer ID
xcrun stapler validate <dmg>                                     # 票据已内嵌,首次启动可离线
```

## 本机构建(可选)

CI 挂了或者想在推 tag 之前先出一版验证时用:

```bash
export APPLE_ID=<你的AppleID> APPLE_TEAM_ID=<你的TeamID>
security add-generic-password -s fwai-notary -a "$APPLE_ID" -w   # 一次性,存 App 专用密码
./scripts/build-macos-release.sh          # arm64 + x64,也可只传 aarch64 / x64
```

脚本没有 `APPLE_CERTIFICATE` 时走本机分支:从登录钥匙串取证书,从 `fwai-notary`
取 App 专用密码。两个坑:

- `security add-generic-password -w` 后不给值会交互提示,若在提示处直接回车,会静默存入
  **空密码**,之后公证报 401 且不易发现——脚本会检查长度并提前报错。
- Xcode 建的证书私钥 ACL 只授权了 Xcode 自己,命令行 `codesign` 会报
  `errSecInternalComponent`。执行一次:

  ```bash
  security set-key-partition-list -S apple-tool:,apple:,codesign: \
    -s ~/Library/Keychains/login.keychain-db
  ```

查公证进度:

```bash
xcrun notarytool history --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
  --password "$(security find-generic-password -s fwai-notary -a "$APPLE_ID" -w)"
```

若公证被拒,用 `xcrun notarytool log <submission-id>` 看具体原因(常见是缺
hardened runtime 或签名不完整;Tauri 2 默认已开 hardened runtime)。

## 备注

- 网关端改动需要在 `llm_gateway` 仓库单独部署,与客户端发版相互独立。
  若两者有依赖关系,先部署网关再发客户端。
- Windows 包目前未做签名,用户首次运行会看到 SmartScreen 提示,需要 EV 代码签名证书才能消除。

## 已知问题:新账号首次公证可能极慢

2026-07-26 首次启用公证时,提交后 **20 小时**才返回 Accepted(期间同一个包再交
两份做对照也都卡着,Apple 状态页却始终显示 Notary Service 正常)。签名侧经
`codesign -dvvv` 验证无问题(完整证书链 + hardened runtime + 可信时间戳)。

**这是新开发者账号首次公证的一次性延迟**:同一天稍后提交的 dmg 只用几分钟就
Accepted,之后一直正常。所以首次启用时若长时间 `In Progress`,不要怀疑配置,
等就是了;后续发版是正常的几分钟。

遇到时的处理:

- **不必重新构建**。签名产物在 `src-tauri/target/<target>/release/bundle/` 下,
  公证一旦通过,直接对现有 dmg 补票据即可:
  `xcrun stapler staple <dmg>`,再用 `spctl` 复验。
- 查历史提交状态:`xcrun notarytool history ...`;查单个:`notarytool info <id>`;
  被拒时用 `notarytool log <id>` 看原因。
- 判断是队列问题还是包本身的问题:另交一份同样的包做对照。两个都卡 = 队列;
  新的很快返回 = 原任务单独卡死,重跑即可。
