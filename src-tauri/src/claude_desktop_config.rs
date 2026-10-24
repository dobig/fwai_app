//! Claude Desktop 的第三方推理网关（3P）配置。
//!
//! 和 Claude Code 没有任何共用:Desktop 不读 `~/.claude/settings.json`,也不认
//! `ANTHROPIC_BASE_URL` 这类环境变量。它读的是自己的 profile:
//!
//! ```text
//! <normal>/claude_desktop_config.json    { "deploymentMode": "3p" }
//! <3p>/claude_desktop_config.json        { "deploymentMode": "3p" }
//! <3p>/configLibrary/<PROFILE_ID>.json   ← 网关地址 + Key 在这里
//! <3p>/configLibrary/_meta.json          entries 登记 + appliedId 指向生效的那个
//! ```
//!
//! Windows 上这四个文件写两套:MSIX 包容器里一套,传统 `%LOCALAPPDATA%`(或
//! `%APPDATA%`)下一套,见 [`windows_targets_from_app_data`]。
//!
//! 只做直连(Direct):profile 里直接写供应商的 endpoint + key。上游 cc-switch 还有
//! 一个 proxy 模式,靠本机路由服务把非 Claude 的模型名改写成 Desktop 认的名字;
//! 那套依赖代理服务,不在这里。因此**只支持 Claude 系模型**,见
//! [`is_claude_safe_model_id`]。
//!
//! 两条必须记住的约束:
//!
//! 1. 模型名不合规不是「这个模型不可用」,而是 Desktop 的 fail-all 校验**拒收整组**,
//!    模型菜单会整个空掉。所以写入前一律先过 [`validate_provider`]。
//! 2. Desktop 只在启动时读 profile。改完必须让用户重启 Desktop(macOS 上要 ⌘Q
//!    彻底退出,只关窗口不算)。

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::provider::{ClaudeDesktopMode, Provider};

/// 我们在 Desktop profile 列表里的条目 id。
///
/// 刻意**不复用**上游 cc-switch 的 `00000000-0000-4000-8000-000000157210`:
/// 那是它的条目,两个应用用同一个 id 会互相覆盖对方的 profile。
pub const PROFILE_ID: &str = "6f920dc9-bfb4-4b6b-93c8-a0c152f63850";
/// profile 在 Desktop 配置菜单里显示的名字。
pub const PROFILE_NAME: &str = "LLM Gateway";

const CONFIG_FILE: &str = "claude_desktop_config.json";
const CONFIG_LIBRARY_DIR: &str = "configLibrary";

/// Desktop 模型菜单识别的 route 前缀。
const CLAUDE_ROUTE_PREFIX: &str = "claude-";
/// 等价前缀(与 Claude Code 的 `anthropic/claude-*` 写法一致)。
const ANTHROPIC_CLAUDE_ROUTE_PREFIX: &str = "anthropic/claude-";
/// Claude Code 用 `[1M]` 后缀声明 1M 上下文,Desktop 的 schema 不认这个后缀,
/// 要翻译成 profile 里的 `supports1m` 字段。
const ONE_M_CONTEXT_MARKER: &str = "[1m]";

/// Desktop 1.12603.1+ 的 fail-all 校验认的角色段(取自 app.asar 的白名单)。
/// `mythos` 官方未公开发布,不暴露给用户。
const SAFE_ROLE_PREFIXES: &[&str] = &["sonnet-", "opus-", "haiku-", "fable-"];

/// profile 里我们独占的字段:每次写入先清掉再写,旧 Key / 旧地址不会残留。
const PROFILE_FLOOR: &[&str] = &[
    "inferenceProvider",
    "inferenceGatewayBaseUrl",
    "inferenceGatewayApiKey",
    "inferenceGatewayAuthScheme",
    "inferenceModels",
];

/// 策略键:缺失时写入,已存在就不动——用户可以自己收紧出站白名单、
/// 打开部署模式选择器,我们不该每次切换都把他的选择推回去。
fn profile_seed() -> [(&'static str, Value); 2] {
    [
        ("disableDeploymentModeChooser", json!(true)),
        ("coworkEgressAllowedHosts", json!(["*"])),
    ]
}

/// 旧版本误写进 `claude_desktop_config.json` 的 `enterpriseConfig` 网关字段。
/// 切回官方时一并清掉,免得 Desktop 还按那份陈旧配置走。
const LEGACY_ENTERPRISE_GATEWAY_KEYS: &[&str] = &[
    "disableDeploymentModeChooser",
    "inferenceGatewayApiKey",
    "inferenceGatewayAuthScheme",
    "inferenceGatewayBaseUrl",
    "inferenceProvider",
];

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct DesktopPaths {
    /// 判断「装没装」看的目录。它不存在就说明这台机器没装过 Desktop。
    /// 传统安装是 1P 目录;MSIX 安装是包容器的 `LocalCache`。
    install_dir: PathBuf,
    normal_config: PathBuf,
    threep_config: PathBuf,
    config_library: PathBuf,
    profile: PathBuf,
    meta: PathBuf,
}

/// 纯路径拼接,三个平台共用。保持无副作用,便于直接单测。
fn paths_from_dirs(normal_dir: PathBuf, threep_dir: PathBuf) -> DesktopPaths {
    let config_library = threep_dir.join(CONFIG_LIBRARY_DIR);
    DesktopPaths {
        normal_config: normal_dir.join(CONFIG_FILE),
        threep_config: threep_dir.join(CONFIG_FILE),
        profile: config_library.join(format!("{PROFILE_ID}.json")),
        meta: config_library.join("_meta.json"),
        config_library,
        install_dir: normal_dir,
    }
}

fn macos_paths_from_home(home: &Path) -> DesktopPaths {
    let app_support = home.join("Library").join("Application Support");
    paths_from_dirs(app_support.join("Claude"), app_support.join("Claude-3p"))
}

fn linux_paths_from_config_dir(config_dir: &Path) -> DesktopPaths {
    paths_from_dirs(config_dir.join("Claude"), config_dir.join("Claude-3p"))
}

/// 一套要写的 Desktop 目录。macOS / Linux 只有一套;Windows 上 MSIX 包容器和传统
/// 目录各一套。
#[derive(Debug, Clone, PartialEq, Eq)]
struct DesktopTarget {
    /// 快照和备份文件名里用来区分目标的键,要稳定:路径会随目录增减重新解析,键不会。
    key: &'static str,
    paths: DesktopPaths,
}

const DEFAULT_TARGET: &str = "default";
const WINDOWS_MSIX_TARGET: &str = "msix";
const WINDOWS_CLASSIC_TARGET: &str = "classic";

/// Windows:MSIX 包容器(微软商店等打包版)和传统目录**两套都写**。
///
/// MSIX 应用的 `%APPDATA%` / `%LOCALAPPDATA%` 被重定向进包容器,只写真实
/// `%LOCALAPPDATA%\Claude-3p` 它看不见;可反过来只写容器也不保险——两种装法并存,
/// 或者 Desktop 的包关掉了文件系统重定向时,它读的又是真实目录。挑错一边的后果都是
/// 开关显示成功、Desktop 却还在用自己那份,所以不挑,两边都写。
///
/// 容器只认跑过一次的包(有 `LocalCache`);传统目录总在列表里,哪怕还没建出来。
fn windows_targets_from_app_data(app_data: &Path, local_app_data: &Path) -> Vec<DesktopTarget> {
    let mut targets = Vec::new();
    if let Some(paths) = windows_msix_paths(local_app_data) {
        targets.push(DesktopTarget {
            key: WINDOWS_MSIX_TARGET,
            paths,
        });
    }
    targets.push(DesktopTarget {
        key: WINDOWS_CLASSIC_TARGET,
        paths: windows_classic_paths_in_either(app_data, local_app_data),
    });
    targets
}

/// 传统安装的 1P / 3P 目录总是成对放在同一个根下:要么都在 `%LOCALAPPDATA%`,
/// 要么都在 `%APPDATA%`。按 1P 目录在哪个根下来选,`%LOCALAPPDATA%` 优先;
/// 两边都没有就按 `%LOCALAPPDATA%`,由安装检查报未安装。
fn windows_classic_paths_in_either(app_data: &Path, local_app_data: &Path) -> DesktopPaths {
    let local = windows_classic_paths(local_app_data);
    if local.install_dir.is_dir() {
        return local;
    }
    let roaming = windows_classic_paths(app_data);
    if roaming.install_dir.is_dir() {
        return roaming;
    }
    local
}

/// 包容器里的布局:1P 在 `LocalCache\Roaming\Claude`,3P 在
/// `LocalCache\Local\Claude-3p`(早期版本在 `Roaming\Claude-3p`,启动时会自己
/// 搬到 Local)。哪个已经存在就用哪个,都不存在用新版的位置。
///
/// 只认跑过一次的包(有 `LocalCache`):没跑过的只剩传统路径,传统目录也没有时由
/// 安装检查报「请先启动一次」。
fn windows_msix_paths(local_app_data: &Path) -> Option<DesktopPaths> {
    let mut packages: Vec<PathBuf> = std::fs::read_dir(local_app_data.join("Packages"))
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("Claude_"))
        })
        .filter(|path| path.join("LocalCache").is_dir())
        .collect();
    // 同一台机器上每次解析到同一个包。
    packages.sort();
    let local_cache = packages.into_iter().next()?.join("LocalCache");

    let existing_or = |preferred: PathBuf, legacy: PathBuf| {
        if !preferred.exists() && legacy.exists() {
            legacy
        } else {
            preferred
        }
    };
    let normal_dir = existing_or(
        local_cache.join("Roaming").join("Claude"),
        local_cache.join("Local").join("Claude"),
    );
    let threep_dir = existing_or(
        local_cache.join("Local").join("Claude-3p"),
        local_cache.join("Roaming").join("Claude-3p"),
    );
    Some(DesktopPaths {
        // 商店版装完首次以 1P 启动之前未必有 Roaming\Claude,装没装看容器本身。
        install_dir: local_cache,
        ..paths_from_dirs(normal_dir, threep_dir)
    })
}

/// 在一个根目录下找 1P / 3P 目录。目录名可能带后缀(Claude-beta 之类),精确名不存在时扫一遍
/// `Claude*`,按名字排序取第一个,保证同一台机器上每次解析到同一个目录。
fn windows_classic_paths(local_app_data: &Path) -> DesktopPaths {
    let pick = |threep: bool| -> PathBuf {
        let exact_name = if threep { "Claude-3p" } else { "Claude" };
        let exact = local_app_data.join(exact_name);
        if exact.exists() {
            return exact;
        }
        let mut candidates: Vec<PathBuf> = std::fs::read_dir(local_app_data)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name.starts_with("Claude") && name.contains("-3p") == threep
                    })
            })
            .collect();
        candidates.sort();
        candidates.into_iter().next().unwrap_or(exact)
    };
    paths_from_dirs(pick(false), pick(true))
}

#[cfg(target_os = "linux")]
fn linux_config_dir() -> PathBuf {
    // Flatpak 把 XDG_CONFIG_HOME 换成沙箱内的私有路径,宿主里原本的值拿不到,
    // 所以这里固定用宿主默认的 ~/.config。自定义了 XDG_CONFIG_HOME 的用户请用
    // 原生包。
    if Path::new("/.flatpak-info").is_file() {
        return crate::config::get_home_dir().join(".config");
    }
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| crate::config::get_home_dir().join(".config"))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn single_target(paths: DesktopPaths) -> Vec<DesktopTarget> {
    vec![DesktopTarget {
        key: DEFAULT_TARGET,
        paths,
    }]
}

/// 要写的全部目标。至少一个。
fn current_targets() -> Result<Vec<DesktopTarget>, AppError> {
    #[cfg(target_os = "macos")]
    {
        Ok(single_target(macos_paths_from_home(
            &crate::config::get_home_dir(),
        )))
    }
    #[cfg(windows)]
    {
        let known_dir = |var: &str, fallback: &str| {
            std::env::var_os(var)
                .map(PathBuf::from)
                .unwrap_or_else(|| crate::config::get_home_dir().join("AppData").join(fallback))
        };
        Ok(windows_targets_from_app_data(
            &known_dir("APPDATA", "Roaming"),
            &known_dir("LOCALAPPDATA", "Local"),
        ))
    }
    #[cfg(target_os = "linux")]
    {
        Ok(single_target(linux_paths_from_config_dir(
            &linux_config_dir(),
        )))
    }
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    {
        Err(AppError::localized(
            "claude_desktop.unsupported_platform",
            "当前平台不支持写入 Claude Desktop 配置。支持 macOS、Windows 和 Linux。",
            "Writing Claude Desktop configuration is not supported on this platform. Supported: macOS, Windows, Linux.",
        ))
    }
}

pub fn is_supported_platform() -> bool {
    cfg!(any(target_os = "macos", windows, target_os = "linux"))
}

/// 这台机器装过 Desktop 吗。
///
/// 按配置目录(MSIX 是包容器)是否存在判断,而不是去找 .app/.exe:绿色解压、改过安装路径的装法
/// 都找不到可执行文件,但只要跑过一次就一定有这个配置目录。
pub fn is_installed() -> bool {
    current_targets().is_ok_and(|targets| any_installed(&targets))
}

fn any_installed(targets: &[DesktopTarget]) -> bool {
    targets
        .iter()
        .any(|target| target.paths.install_dir.is_dir())
}

/// 给用户看的那一套:第一个装过的目标(Windows 上容器在就是容器),都没装就第一个。
/// 只用于展示和读取,写入一律走全部目标。
fn primary_paths(targets: &[DesktopTarget]) -> &DesktopPaths {
    let target = targets
        .iter()
        .find(|target| target.paths.install_dir.is_dir())
        .or(targets.first())
        .expect("current_targets returns at least one target");
    &target.paths
}

/// `configLibrary` 的绝对路径,给「打开配置目录」用。
pub fn config_library_path() -> Result<PathBuf, AppError> {
    Ok(primary_paths(&current_targets()?).config_library.clone())
}

fn not_installed_error() -> AppError {
    AppError::localized(
        "claude_desktop.not_installed",
        "没找到 Claude Desktop 的配置目录。请先安装并至少启动一次 Claude Desktop。",
        "Could not find the Claude Desktop configuration directory. Install Claude Desktop and launch it at least once.",
    )
}

// ---------------------------------------------------------------------------
// 模型名
// ---------------------------------------------------------------------------

/// Desktop 的 fail-all 校验能接受的模型名吗。
///
/// 不合规的名字写进 `inferenceModels` 会让 Desktop **拒收整组**,模型菜单整个
/// 空掉——所以这里宁可严格:角色段之后必须还有实际标识,`claude-sonnet-` 这种
/// 退化值要拒掉。
pub fn is_claude_safe_model_id(model: &str) -> bool {
    let normalized = model.trim().to_ascii_lowercase();
    // `[1M]` 是 Claude Code 的写法,Desktop 的 schema 不认;1M 能力走 supports1m。
    if normalized.contains(ONE_M_CONTEXT_MARKER) {
        return false;
    }
    let Some(tail) = normalized
        .strip_prefix(ANTHROPIC_CLAUDE_ROUTE_PREFIX)
        .or_else(|| normalized.strip_prefix(CLAUDE_ROUTE_PREFIX))
    else {
        return false;
    };
    SAFE_ROLE_PREFIXES.iter().any(|prefix| {
        tail.strip_prefix(prefix)
            .is_some_and(|rest| !rest.is_empty())
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InferenceModelSpec {
    name: String,
    label_override: Option<String>,
    supports_1m: bool,
}

/// 单条模型写成 profile 里的形态:没有 label 也不声明 1M 时就是一个裸字符串,
/// 和 Desktop 自己写出来的形状保持一致。
fn inference_model_json(spec: &InferenceModelSpec) -> Value {
    if !spec.supports_1m && spec.label_override.is_none() {
        return Value::String(spec.name.clone());
    }
    let mut item = json!({ "name": spec.name });
    if let Some(label) = spec.label_override.as_deref() {
        item["labelOverride"] = json!(label);
    }
    if spec.supports_1m {
        item["supports1m"] = json!(true);
    }
    item
}

/// 从供应商的 `meta.claudeDesktopModelRoutes` 取要写进 profile 的模型清单。
///
/// 留空是允许的:profile 里就不写 `inferenceModels`,Desktop 会自己去读网关的
/// `/v1/models`。
fn inference_model_specs(provider: &Provider) -> Result<Vec<InferenceModelSpec>, AppError> {
    let Some(routes) = provider
        .meta
        .as_ref()
        .map(|meta| &meta.claude_desktop_model_routes)
    else {
        return Ok(Vec::new());
    };

    let mut specs = Vec::new();
    for (route_id, route) in routes {
        let route_id = route_id.trim();
        if route_id.is_empty() {
            continue;
        }
        if !is_claude_safe_model_id(route_id) {
            return Err(AppError::localized(
                "claude_desktop.model_invalid",
                format!(
                    "「{route_id}」不是 Claude Desktop 能识别的模型名。只支持 claude-* / anthropic/claude-* 的 Sonnet / Opus / Haiku / Fable 模型。"
                ),
                format!(
                    "'{route_id}' is not a model name Claude Desktop recognizes. Only claude-* / anthropic/claude-* Sonnet / Opus / Haiku / Fable models are supported."
                ),
            ));
        }
        // 直连模式没有改写模型名的环节:请求原样发给上游,映射成别的名字只会
        // 让上游收到一个它不认识的模型。要映射得用上游 cc-switch 的 proxy 模式。
        let upstream = route.model.trim();
        if !upstream.is_empty() && upstream != route_id {
            return Err(AppError::localized(
                "claude_desktop.model_mapping_unsupported",
                format!(
                    "直连模式不能把 {route_id} 映射成 {upstream}:请求会原样发给上游。需要模型映射请用上游 cc-switch 的本地路由模式。"
                ),
                format!(
                    "Direct mode cannot map {route_id} to {upstream}: the request is forwarded unchanged. Use upstream cc-switch's proxy mode if you need model mapping."
                ),
            ));
        }
        specs.push(InferenceModelSpec {
            name: route_id.to_string(),
            label_override: route
                .label_override
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            supports_1m: route.supports_1m.unwrap_or(false),
        });
    }

    // 同名去重时保留声明了 1M 的那条:排序把 supports_1m=true 放前面,dedup 留第一条。
    specs.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then_with(|| b.supports_1m.cmp(&a.supports_1m))
    });
    specs.dedup_by(|a, b| a.name == b.name);
    Ok(specs)
}

// ---------------------------------------------------------------------------
// 凭据与校验
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayCredentials {
    pub base_url: String,
    pub api_key: String,
}

/// 从供应商条目里取直连要用的 endpoint + key。
///
/// 读的是和 Claude Code 同一组字段,所以同一个网关条目可以同时喂给 CLI 和 Desktop。
pub fn gateway_credentials(provider: &Provider) -> Result<GatewayCredentials, AppError> {
    let env = provider
        .settings_config
        .get("env")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            AppError::localized(
                "claude_desktop.env_missing",
                "供应商配置缺少 env 段",
                "Provider configuration is missing the env section",
            )
        })?;

    let pick = |key: &str, zh: &str, en: &str| -> Result<String, AppError> {
        env.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| {
                AppError::localized(
                    "claude_desktop.credential_missing",
                    zh.to_string(),
                    en.to_string(),
                )
            })
    };

    Ok(GatewayCredentials {
        base_url: pick(
            "ANTHROPIC_BASE_URL",
            "供应商配置缺少 ANTHROPIC_BASE_URL",
            "Provider configuration is missing ANTHROPIC_BASE_URL",
        )?,
        api_key: pick(
            "ANTHROPIC_AUTH_TOKEN",
            "供应商配置缺少 ANTHROPIC_AUTH_TOKEN",
            "Provider configuration is missing ANTHROPIC_AUTH_TOKEN",
        )?,
    })
}

/// 写入前的全部校验。放在一处,`add` / `update` / 切换都走它。
pub fn validate_provider(provider: &Provider) -> Result<(), AppError> {
    if !provider.settings_config.is_object() {
        return Err(AppError::localized(
            "claude_desktop.settings_not_object",
            "Claude Desktop 供应商配置必须是 JSON 对象",
            "Claude Desktop provider configuration must be a JSON object",
        ));
    }
    // 从 cc-switch 导出的条目可能带 proxy 模式。静默当直连处理会让模型名映射
    // 悄悄失效,不如直接说清楚这里不支持。
    if provider
        .meta
        .as_ref()
        .and_then(|meta| meta.claude_desktop_mode.as_ref())
        .is_some_and(|mode| matches!(mode, ClaudeDesktopMode::Proxy))
    {
        return Err(AppError::localized(
            "claude_desktop.proxy_mode_unsupported",
            "这个条目用的是本地路由(proxy)模式,fwai_app 只支持直连。请改成直连,或用上游 cc-switch。",
            "This entry uses proxy mode; fwai_app only supports direct mode. Switch it to direct, or use upstream cc-switch.",
        ));
    }
    gateway_credentials(provider)?;
    inference_model_specs(provider)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 读写
// ---------------------------------------------------------------------------

/// 读一个 JSON 对象。文件不存在当空对象;存在但解析不了要报错——绝不能当空对象
/// 处理,否则会把用户手写坏了的配置整份替换掉。
fn read_object(path: &Path) -> Result<Map<String, Value>, AppError> {
    if !path.exists() {
        return Ok(Map::new());
    }
    match crate::config::read_json_file::<Value>(path)? {
        Value::Object(map) => Ok(map),
        // 不是对象(比如写成了数组)就当空的:这种文件 Desktop 自己也读不了,
        // 保留它没有意义,而报错会让用户卡在一个无法自救的状态。
        _ => Ok(Map::new()),
    }
}

/// 写 JSON。
///
/// 刻意不用 `config::write_json_file`:它会把键按字母排序(`sort_json_keys`),
/// 而这些是 Desktop 自己的配置文件,整份重排键序既是无谓的 diff,也可能和
/// Desktop 的写回逻辑打架。`preserve_order` 开着,所以这里能保住原有顺序。
fn write_object(path: &Path, value: &Map<String, Value>) -> Result<(), AppError> {
    let json =
        serde_json::to_string_pretty(value).map_err(|e| AppError::JsonSerialize { source: e })?;
    crate::config::atomic_write(path, json.as_bytes())
}

/// 首次改动某个文件之前,把原件拷到 `~/.fwai_app/backups`。
///
/// 只拷一次:名字里不带时间戳,留住的始终是**我们没碰过之前**的那一份。
fn backup_once(path: &Path, target_key: &str, backup_dir: &Path) -> Result<(), AppError> {
    if !path.exists() {
        return Ok(());
    }
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return Ok(());
    };
    // profile 和两个 claude_desktop_config.json 同名不同目录,用父目录名消歧。
    let parent_name = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .unwrap_or("claude-desktop");
    // Windows 两套目录的父目录名一样,再带上目标的键。单目标的平台沿用旧名字,
    // 已有的备份照旧认得。
    let target = if target_key == DEFAULT_TARGET {
        backup_dir.join(format!("claude-desktop.{parent_name}.{file_name}"))
    } else {
        backup_dir.join(format!(
            "claude-desktop.{target_key}.{parent_name}.{file_name}"
        ))
    };
    if target.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(backup_dir).map_err(|e| AppError::io(backup_dir, e))?;
    crate::config::copy_file(path, &target)
}

/// `None` 表示原本没有这个键：删掉，而不是写一个我们编的值。
fn apply_deployment_mode(map: &mut Map<String, Value>, mode: Option<&str>) {
    match mode {
        Some(mode) => set_deployment_mode(map, mode),
        None => {
            map.shift_remove("deploymentMode");
        }
    }
}

fn set_deployment_mode(map: &mut Map<String, Value>, mode: &str) {
    match map.get_mut("deploymentMode") {
        Some(slot) => *slot = json!(mode),
        None => {
            map.insert("deploymentMode".to_string(), json!(mode));
        }
    }
}

/// 把网关字段合进已有 profile。
///
/// 三类键分开处理,这是「不碰用户设置」的全部保证:
/// - floor:我们独占,先清后写,旧 Key 不残留
/// - seed:缺失才写,用户改过就不动
/// - 其余:完全不碰
fn merge_profile(
    mut profile: Map<String, Value>,
    fields: Map<String, Value>,
) -> Map<String, Value> {
    for key in PROFILE_FLOOR {
        profile.shift_remove(*key);
    }
    for (key, value) in fields {
        profile.insert(key, value);
    }
    for (key, value) in profile_seed() {
        if !profile.contains_key(key) {
            profile.insert(key.to_string(), value);
        }
    }
    profile
}

fn build_profile_fields(
    credentials: &GatewayCredentials,
    models: &[InferenceModelSpec],
) -> Map<String, Value> {
    let mut fields = Map::new();
    fields.insert("inferenceProvider".to_string(), json!("gateway"));
    fields.insert(
        "inferenceGatewayBaseUrl".to_string(),
        json!(credentials.base_url),
    );
    fields.insert(
        "inferenceGatewayApiKey".to_string(),
        json!(credentials.api_key),
    );
    fields.insert("inferenceGatewayAuthScheme".to_string(), json!("bearer"));
    // 留空就不写这个键:Desktop 会转而去读网关的 /v1/models。写一个空数组反而
    // 等于告诉它「一个模型都没有」。
    if !models.is_empty() {
        fields.insert(
            "inferenceModels".to_string(),
            Value::Array(models.iter().map(inference_model_json).collect()),
        );
    }
    fields
}

/// `_meta.json`:在 `entries` 里登记我们的 profile,`appliedId` 指向它。
/// 已有条目原位改名,不挪位置。
fn apply_meta(meta: &mut Map<String, Value>) -> Result<(), AppError> {
    let entries = meta
        .entry("entries".to_string())
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| {
            AppError::localized(
                "claude_desktop.meta_shape",
                "Claude Desktop 的 _meta.json 里 entries 不是数组",
                "entries in Claude Desktop's _meta.json is not an array",
            )
        })?;
    match entries
        .iter_mut()
        .find(|entry| entry.get("id").and_then(Value::as_str) == Some(PROFILE_ID))
    {
        Some(Value::Object(entry)) => {
            entry.insert("name".to_string(), json!(PROFILE_NAME));
        }
        _ => entries.push(json!({ "id": PROFILE_ID, "name": PROFILE_NAME })),
    }
    match meta.get_mut("appliedId") {
        Some(slot) => *slot = json!(PROFILE_ID),
        None => {
            meta.insert("appliedId".to_string(), json!(PROFILE_ID));
        }
    }
    Ok(())
}

/// 从 `_meta.json` 里摘掉我们的条目,`appliedId` 让给下一个(没有就删掉)。
fn unapply_meta(meta: &mut Map<String, Value>) -> Result<(), AppError> {
    let mut next_id = None;
    if let Some(entries) = meta.get_mut("entries") {
        let entries = entries.as_array_mut().ok_or_else(|| {
            AppError::localized(
                "claude_desktop.meta_shape",
                "Claude Desktop 的 _meta.json 里 entries 不是数组",
                "entries in Claude Desktop's _meta.json is not an array",
            )
        })?;
        entries.retain(|entry| entry.get("id").and_then(Value::as_str) != Some(PROFILE_ID));
        next_id = entries
            .iter()
            .find_map(|entry| entry.get("id").and_then(Value::as_str))
            .map(str::to_string);
    }
    if meta.get("appliedId").and_then(Value::as_str) == Some(PROFILE_ID) {
        match next_id {
            Some(id) => {
                meta.insert("appliedId".to_string(), json!(id));
            }
            None => {
                meta.shift_remove("appliedId");
            }
        }
    }
    Ok(())
}

/// 一个待写文件:内容已经在内存里算好了。
struct PendingWrite {
    path: PathBuf,
    content: Map<String, Value>,
    /// profile 里有 Key,落盘要 0600。
    private: bool,
    /// 属于哪个目标,备份文件名要用。
    target_key: &'static str,
}

/// 先把所有目标的文件全算好,再逐个落盘。
///
/// 任何一个文件解析失败都不写——不接受「改了一半」的中间状态。写盘阶段每个文件
/// 自己是原子的(临时文件 + rename),但文件之间没有事务:写到第三个失败时
/// 前两个已经生效。没搬上游那套写前意图 + 崩溃前滚的引擎,因为这里的写入是幂等
/// 的,重试一次就能收敛,而 Desktop 配置丢了也不像 Codex 的 OAuth 凭据那样需要
/// 重新登录。
fn commit(writes: Vec<PendingWrite>, backup_dir: &Path) -> Result<(), AppError> {
    for write in &writes {
        backup_once(&write.path, write.target_key, backup_dir)?;
    }
    for write in &writes {
        write_object(&write.path, &write.content)?;
        if write.private {
            set_private_permissions(&write.path)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn set_private_permissions(path: &Path) -> Result<(), AppError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| AppError::io(path, e))
}

#[cfg(not(unix))]
fn set_private_permissions(_path: &Path) -> Result<(), AppError> {
    // Windows 上 %LOCALAPPDATA% 本身就是按用户隔离的,不额外改 ACL。
    Ok(())
}

/// 把一个供应商写成 Desktop 的生效配置。
pub fn apply_provider(provider: &Provider) -> Result<(), AppError> {
    let credentials = gateway_credentials(provider)?;
    apply_with_credentials(provider, &credentials)
}

/// 用指定凭据写 Desktop 配置，模型清单仍取自条目。
///
/// 转发路径走这个:endpoint + key 由网关面板给(可能刚轮换过,比条目里存的新),
/// 而用户勾的模型档位只存在条目的 meta 里。两边各取所需。
pub fn apply_with_credentials(
    provider: &Provider,
    credentials: &GatewayCredentials,
) -> Result<(), AppError> {
    let targets = current_targets()?;
    apply_provider_to_targets(provider, credentials, &targets, &default_backup_dir())
}

fn default_backup_dir() -> PathBuf {
    crate::config::get_app_config_dir().join("backups")
}

/// 只要有一个目标装过就全部写:没装过的那套(比如只装了商店版时的传统目录)也写,
/// Desktop 读的是哪一套我们说不准。一个都没装过才拒绝,不在没装 Desktop 的机器上
/// 凭空造目录。
fn apply_provider_to_targets(
    provider: &Provider,
    credentials: &GatewayCredentials,
    targets: &[DesktopTarget],
    backup_dir: &Path,
) -> Result<(), AppError> {
    if !any_installed(targets) {
        return Err(not_installed_error());
    }
    validate_provider(provider)?;

    let models = inference_model_specs(provider)?;
    let fields = build_profile_fields(credentials, &models);

    let mut writes = Vec::new();
    for target in targets {
        writes.extend(apply_writes(target, fields.clone())?);
    }
    commit(writes, backup_dir)
}

fn apply_writes(
    target: &DesktopTarget,
    fields: Map<String, Value>,
) -> Result<Vec<PendingWrite>, AppError> {
    let paths = &target.paths;
    let mut normal = read_object(&paths.normal_config)?;
    set_deployment_mode(&mut normal, "3p");
    let mut threep = read_object(&paths.threep_config)?;
    set_deployment_mode(&mut threep, "3p");
    let profile = merge_profile(read_object(&paths.profile)?, fields);
    let mut meta = read_object(&paths.meta)?;
    apply_meta(&mut meta)?;

    Ok(vec![
        PendingWrite {
            path: paths.normal_config.clone(),
            content: normal,
            private: false,
            target_key: target.key,
        },
        PendingWrite {
            path: paths.threep_config.clone(),
            content: threep,
            private: false,
            target_key: target.key,
        },
        PendingWrite {
            path: paths.profile.clone(),
            content: profile,
            private: true,
            target_key: target.key,
        },
        PendingWrite {
            path: paths.meta.clone(),
            content: meta,
            private: false,
            target_key: target.key,
        },
    ])
}

/// 动手之前的 Desktop 状态,交给转发的备份机制保存。
///
/// 为什么需要它:直接写 `1p` 是错的。用户完全可能本来就在 3P 模式、用着自己的
/// profile(Desktop 的 configLibrary 本来就支持多份),那种情况下「还原」应该回到
/// 他原来的值,而不是被我们按成 1P。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSnapshot {
    /// 每个目标一份,键是目标的 `key`。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub targets: BTreeMap<String, TargetSnapshot>,
    /// 旧版本只写一个目标,快照直接摊在这一层。`targets` 为空时它归第一个目标——
    /// 旧版本挑中的那一套和现在排在第一的是同一套。
    #[serde(flatten)]
    pub legacy: TargetSnapshot,
}

/// 一个目标动手前的状态。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetSnapshot {
    /// 两个 `claude_desktop_config.json` 的 `deploymentMode` 原值。
    /// `None` 表示原本没有这个键——还原时应当删掉,而不是写一个我们编的值。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normal_deployment_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threep_deployment_mode: Option<String>,
    /// `_meta.json` 原来的 `appliedId`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_id: Option<String>,
}

impl DesktopSnapshot {
    /// 第 `index` 个目标的快照。没有记录(旧快照之后才多出来的目标)返回 `None`。
    fn for_target(&self, index: usize, target: &DesktopTarget) -> Option<&TargetSnapshot> {
        if self.targets.is_empty() {
            return (index == 0).then_some(&self.legacy);
        }
        self.targets.get(target.key)
    }
}

/// 采集动手前的状态。Desktop 没装时返回空快照(还原时就什么都不做)。
pub fn capture_snapshot() -> Result<DesktopSnapshot, AppError> {
    capture_snapshot_at_targets(&current_targets()?)
}

fn capture_snapshot_at_targets(targets: &[DesktopTarget]) -> Result<DesktopSnapshot, AppError> {
    if !any_installed(targets) {
        return Ok(DesktopSnapshot::default());
    }
    let mut snapshot = DesktopSnapshot::default();
    for target in targets {
        snapshot
            .targets
            .insert(target.key.to_string(), capture_target(&target.paths)?);
    }
    Ok(snapshot)
}

fn capture_target(paths: &DesktopPaths) -> Result<TargetSnapshot, AppError> {
    let read_mode = |path: &Path| -> Result<Option<String>, AppError> {
        Ok(read_object(path)?
            .get("deploymentMode")
            .and_then(Value::as_str)
            .map(str::to_string))
    };
    Ok(TargetSnapshot {
        normal_deployment_mode: read_mode(&paths.normal_config)?,
        threep_deployment_mode: read_mode(&paths.threep_config)?,
        applied_id: read_object(&paths.meta)?
            .get("appliedId")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// 按快照还原:`deploymentMode` 回到原值(原本没有就删掉),摘掉我们的 profile 条目,
/// `appliedId` 回到原来指的那个,profile 文件保留、只清我们独占的字段。
///
/// 快照里没有的目标(旧版本开的转发,升级后才写进第二套目录)只在里面确实登记着
/// 我们的 profile 时才动,按交还 1P 兜底;没登记说明不是我们写的,不碰。
pub fn restore_snapshot(snapshot: &DesktopSnapshot) -> Result<(), AppError> {
    restore_snapshot_at_targets(&current_targets()?, snapshot, &default_backup_dir())
}

fn restore_snapshot_at_targets(
    targets: &[DesktopTarget],
    snapshot: &DesktopSnapshot,
    backup_dir: &Path,
) -> Result<(), AppError> {
    let mut writes = Vec::new();
    for (index, target) in targets.iter().enumerate() {
        let target_snapshot = snapshot.for_target(index, target);
        if target_snapshot.is_none() && !lists_our_profile(&target.paths)? {
            continue;
        }
        writes.extend(restore_writes(target, target_snapshot)?);
    }
    commit(writes, backup_dir)
}

/// `_meta.json` 里还登记着我们的 profile 吗。
fn lists_our_profile(paths: &DesktopPaths) -> Result<bool, AppError> {
    Ok(read_object(&paths.meta)?
        .get("entries")
        .and_then(Value::as_array)
        .is_some_and(|entries| {
            entries
                .iter()
                .any(|entry| entry.get("id").and_then(Value::as_str) == Some(PROFILE_ID))
        }))
}

/// 交还给 Desktop 自己的 1P 登录。
///
/// profile 文件保留、只清我们独占的字段:用户在 Desktop 里对这个 profile 改过的
/// 设置下次切回来还在,而 Key 已经从磁盘上没了。Desktop 只按 `_meta.json` 的条目
/// 列 profile,摘掉条目后它不会再被列出来。
pub fn restore_official() -> Result<(), AppError> {
    restore_official_at_targets(&current_targets()?, &default_backup_dir())
}

fn restore_official_at_targets(
    targets: &[DesktopTarget],
    backup_dir: &Path,
) -> Result<(), AppError> {
    let mut writes = Vec::new();
    for target in targets {
        writes.extend(restore_writes(target, None)?);
    }
    commit(writes, backup_dir)
}

/// 一个目标的还原内容。`snapshot` 为 `None` 时按 1P 兜底——没有动手前的记录可依据
/// (删除条目那条路径)。
///
/// 目标既没装过、也没被我们写过(没有 `_meta.json`)就什么都不写,不在这里把目录
/// 建出来。装没装过不能单看 1P 目录:只装了商店版时,传统目录是我们建的,也要还原。
fn restore_writes(
    target: &DesktopTarget,
    snapshot: Option<&TargetSnapshot>,
) -> Result<Vec<PendingWrite>, AppError> {
    let paths = &target.paths;
    if !paths.install_dir.is_dir() && !paths.meta.exists() {
        return Ok(Vec::new());
    }

    let mut normal = read_object(&paths.normal_config)?;
    apply_deployment_mode(
        &mut normal,
        snapshot.map_or(Some("1p"), |s| s.normal_deployment_mode.as_deref()),
    );
    let mut threep = read_object(&paths.threep_config)?;
    apply_deployment_mode(
        &mut threep,
        snapshot.map_or(Some("1p"), |s| s.threep_deployment_mode.as_deref()),
    );
    // 旧版本把网关设置写进了 enterpriseConfig,一并清掉;清空了就把这个壳也去掉。
    if let Some(Value::Object(enterprise)) = threep.get_mut("enterpriseConfig") {
        for key in LEGACY_ENTERPRISE_GATEWAY_KEYS {
            enterprise.shift_remove(*key);
        }
        if enterprise.is_empty() {
            threep.shift_remove("enterpriseConfig");
        }
    }
    let mut meta = read_object(&paths.meta)?;
    unapply_meta(&mut meta)?;
    // 快照里记着动手前 appliedId 指的是谁，优先还原成那个（它可能是用户自己的
    // profile，unapply_meta 只会退到「列表里随便下一个」）。
    if let Some(prior) = snapshot.and_then(|s| s.applied_id.as_deref()) {
        if prior != PROFILE_ID {
            meta.insert("appliedId".to_string(), json!(prior));
        }
    }

    let mut writes = vec![
        PendingWrite {
            path: paths.normal_config.clone(),
            content: normal,
            private: false,
            target_key: target.key,
        },
        PendingWrite {
            path: paths.threep_config.clone(),
            content: threep,
            private: false,
            target_key: target.key,
        },
        PendingWrite {
            path: paths.meta.clone(),
            content: meta,
            private: false,
            target_key: target.key,
        },
    ];
    if paths.profile.exists() {
        let mut profile = read_object(&paths.profile)?;
        for key in PROFILE_FLOOR {
            profile.shift_remove(*key);
        }
        writes.push(PendingWrite {
            path: paths.profile.clone(),
            content: profile,
            private: true,
            target_key: target.key,
        });
    }
    Ok(writes)
}

/// 删掉某个供应商条目时:只有 profile 里生效的正是它,才交还 1P。
///
/// 和 Claude / Codex 的同类逻辑一个意思——用户删的可能是个早就不生效的旧条目,
/// 那种情况下动 live 配置属于误伤。每个目标分开判断。
pub fn restore_official_if_matches(provider: &Provider) -> Result<(), AppError> {
    restore_official_if_matches_at_targets(provider, &current_targets()?, &default_backup_dir())
}

fn restore_official_if_matches_at_targets(
    provider: &Provider,
    targets: &[DesktopTarget],
    backup_dir: &Path,
) -> Result<(), AppError> {
    let Ok(credentials) = gateway_credentials(provider) else {
        // 条目本身就没有完整凭据,不可能是它写进去的。
        return Ok(());
    };
    let mut writes = Vec::new();
    for target in targets {
        let live_key = read_object(&target.paths.profile)?
            .get("inferenceGatewayApiKey")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_default();
        if live_key == credentials.api_key {
            writes.extend(restore_writes(target, None)?);
        }
    }
    commit(writes, backup_dir)
}

/// 当前 profile 的内容,给「查看当前生效配置」用。没有就返回空对象。
pub fn read_profile() -> Result<Value, AppError> {
    let targets = current_targets()?;
    Ok(Value::Object(read_object(
        &primary_paths(&targets).profile,
    )?))
}

// ---------------------------------------------------------------------------
// 状态自检
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeDesktopStatus {
    pub supported: bool,
    pub installed: bool,
    /// Desktop 当前是否指着我们的 profile。
    pub configured: bool,
    pub profile_path: Option<String>,
    pub config_library_path: Option<String>,
    pub deployment_mode: Option<String>,
    /// profile 里实际写着的网关地址,和当前供应商比对能发现没切干净。
    pub actual_base_url: Option<String>,
    /// profile 里混进了 Desktop 不认的模型名——这会让模型菜单整个空掉。
    pub stale_raw_models: bool,
}

pub fn get_status() -> Result<ClaudeDesktopStatus, AppError> {
    if !is_supported_platform() {
        return Ok(ClaudeDesktopStatus {
            supported: false,
            installed: false,
            configured: false,
            profile_path: None,
            config_library_path: None,
            deployment_mode: None,
            actual_base_url: None,
            stale_raw_models: false,
        });
    }

    let targets = current_targets()?;
    let paths = primary_paths(&targets);
    let profile = read_object(&paths.profile).unwrap_or_default();
    // 切回官方后 profile 文件还在、只是关键字段被清空了,所以不能按文件在不在
    // 判断,要看 _meta.json 里还有没有我们的条目。
    let listed = lists_our_profile(paths).unwrap_or(false);
    let stale_raw_models = profile
        .get("inferenceModels")
        .and_then(Value::as_array)
        .is_some_and(|models| {
            models.iter().any(|item| {
                item.as_str()
                    .or_else(|| item.get("name").and_then(Value::as_str))
                    .is_some_and(|model| !is_claude_safe_model_id(model))
            })
        });

    Ok(ClaudeDesktopStatus {
        supported: true,
        installed: any_installed(&targets),
        configured: listed && profile.get("inferenceProvider").is_some(),
        profile_path: Some(paths.profile.display().to_string()),
        config_library_path: Some(paths.config_library.display().to_string()),
        deployment_mode: read_object(&paths.normal_config)
            .unwrap_or_default()
            .get("deploymentMode")
            .and_then(Value::as_str)
            .map(str::to_string),
        actual_base_url: profile
            .get("inferenceGatewayBaseUrl")
            .and_then(Value::as_str)
            .map(str::to_string),
        stale_raw_models,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{ClaudeDesktopModelRoute, ProviderMeta};
    use std::collections::HashMap;

    fn provider_with(models: &[(&str, bool)]) -> Provider {
        let mut routes = HashMap::new();
        for (name, supports_1m) in models {
            routes.insert(
                (*name).to_string(),
                ClaudeDesktopModelRoute {
                    model: (*name).to_string(),
                    label_override: None,
                    supports_1m: Some(*supports_1m),
                },
            );
        }
        let mut provider = Provider::with_id(
            "llm-gateway".to_string(),
            "LLM Gateway".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_BASE_URL": "https://api.fwai.space",
                    "ANTHROPIC_AUTH_TOKEN": "sk-test-token",
                }
            }),
            None,
        );
        provider.meta = Some(ProviderMeta {
            claude_desktop_model_routes: routes,
            ..Default::default()
        });
        provider
    }

    /// Desktop 装好之后的目录布局：1P 目录在才算装过。
    fn installed_paths(root: &Path) -> DesktopPaths {
        let paths = paths_from_dirs(root.join("Claude"), root.join("Claude-3p"));
        std::fs::create_dir_all(&paths.install_dir).expect("normal dir");
        std::fs::create_dir_all(&paths.config_library).expect("config library");
        paths
    }

    /// macOS / Linux 那样只有一套目录。
    fn single(paths: &DesktopPaths) -> Vec<DesktopTarget> {
        vec![DesktopTarget {
            key: DEFAULT_TARGET,
            paths: paths.clone(),
        }]
    }

    /// 测试里按条目自带的凭据写入（等价于直接切换那条路径）。
    fn apply(provider: &Provider, paths: &DesktopPaths, backup_dir: &Path) -> Result<(), AppError> {
        let credentials = gateway_credentials(provider)?;
        apply_provider_to_targets(provider, &credentials, &single(paths), backup_dir)
    }

    fn capture(paths: &DesktopPaths) -> TargetSnapshot {
        capture_snapshot_at_targets(&single(paths))
            .expect("capture")
            .targets[DEFAULT_TARGET]
            .clone()
    }

    fn read(path: &Path) -> Value {
        let text = std::fs::read_to_string(path).expect("read");
        serde_json::from_str(&text).expect("parse")
    }

    // ---- 模型名 ----------------------------------------------------------

    #[test]
    fn claude_safe_model_ids_are_accepted() {
        for id in [
            "claude-sonnet-5",
            "claude-opus-5",
            "claude-haiku-4-5",
            "claude-fable-5",
            "anthropic/claude-sonnet-5",
            "CLAUDE-OPUS-5",
        ] {
            assert!(is_claude_safe_model_id(id), "{id} should be accepted");
        }
    }

    #[test]
    fn unsafe_model_ids_are_rejected() {
        for id in [
            // 角色段后面没内容：写进去会触发 Desktop 的 fail-all，整组模型被拒
            "claude-sonnet-",
            "claude-opus-",
            // 不是 Claude 系
            "gpt-5.6",
            "deepseek-v3",
            "claude",
            "claude-",
            // mythos 官方未公开发布，不暴露
            "claude-mythos-5",
            // [1M] 是 Claude Code 的写法，Desktop schema 不认
            "claude-sonnet-5[1m]",
            "claude-sonnet-5[1M]",
            "",
        ] {
            assert!(!is_claude_safe_model_id(id), "{id} should be rejected");
        }
    }

    #[test]
    fn model_json_is_a_bare_string_when_nothing_extra_is_declared() {
        let spec = InferenceModelSpec {
            name: "claude-sonnet-5".to_string(),
            label_override: None,
            supports_1m: false,
        };
        assert_eq!(inference_model_json(&spec), json!("claude-sonnet-5"));
    }

    #[test]
    fn model_json_becomes_an_object_for_1m_and_labels() {
        let spec = InferenceModelSpec {
            name: "claude-opus-5".to_string(),
            label_override: Some("Opus (gateway)".to_string()),
            supports_1m: true,
        };
        assert_eq!(
            inference_model_json(&spec),
            json!({ "name": "claude-opus-5", "labelOverride": "Opus (gateway)", "supports1m": true })
        );
    }

    #[test]
    fn model_specs_reject_names_desktop_cannot_parse() {
        let provider = provider_with(&[("gpt-5.6", false)]);
        let err = inference_model_specs(&provider).expect_err("should reject");
        assert!(err.to_string().contains("gpt-5.6"), "{err}");
    }

    #[test]
    fn model_specs_reject_mapping_because_direct_mode_cannot_rewrite() {
        let mut provider = provider_with(&[]);
        let mut routes = HashMap::new();
        routes.insert(
            "claude-sonnet-5".to_string(),
            ClaudeDesktopModelRoute {
                model: "gpt-5.6".to_string(),
                label_override: None,
                supports_1m: None,
            },
        );
        provider.meta = Some(ProviderMeta {
            claude_desktop_model_routes: routes,
            ..Default::default()
        });
        let err = inference_model_specs(&provider).expect_err("should reject");
        assert!(err.to_string().contains("映射"), "{err}");
    }

    #[test]
    fn model_specs_are_sorted_and_deduped_keeping_the_1m_variant() {
        // HashMap 的迭代顺序不稳定，写出去的 inferenceModels 必须是确定的，
        // 否则每次切换都产生一个无意义的 diff。
        let provider = provider_with(&[
            ("claude-sonnet-5", true),
            ("claude-opus-5", false),
            ("claude-haiku-4-5", false),
        ]);
        let specs = inference_model_specs(&provider).expect("specs");
        let names: Vec<_> = specs.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["claude-haiku-4-5", "claude-opus-5", "claude-sonnet-5"]
        );
        assert!(specs
            .iter()
            .any(|s| s.name == "claude-sonnet-5" && s.supports_1m));
    }

    // ---- 校验 ------------------------------------------------------------

    #[test]
    fn validate_rejects_proxy_mode() {
        let mut provider = provider_with(&[("claude-sonnet-5", false)]);
        provider.meta = Some(ProviderMeta {
            claude_desktop_mode: Some(ClaudeDesktopMode::Proxy),
            ..Default::default()
        });
        let err = validate_provider(&provider).expect_err("proxy is unsupported");
        assert!(err.to_string().contains("直连"), "{err}");
    }

    #[test]
    fn validate_requires_both_credentials() {
        let mut provider = provider_with(&[]);
        provider.settings_config = json!({ "env": { "ANTHROPIC_BASE_URL": "https://x" } });
        assert!(validate_provider(&provider).is_err());

        provider.settings_config = json!({ "env": { "ANTHROPIC_AUTH_TOKEN": "sk" } });
        assert!(validate_provider(&provider).is_err());

        // 空字符串等于没填
        provider.settings_config =
            json!({ "env": { "ANTHROPIC_BASE_URL": "  ", "ANTHROPIC_AUTH_TOKEN": "sk" } });
        assert!(validate_provider(&provider).is_err());
    }

    #[test]
    fn credentials_are_trimmed() {
        let mut provider = provider_with(&[]);
        provider.settings_config = json!({
            "env": { "ANTHROPIC_BASE_URL": " https://api.fwai.space ", "ANTHROPIC_AUTH_TOKEN": " sk-x " }
        });
        let credentials = gateway_credentials(&provider).expect("credentials");
        assert_eq!(credentials.base_url, "https://api.fwai.space");
        assert_eq!(credentials.api_key, "sk-x");
    }

    // ---- 路径 ------------------------------------------------------------

    #[test]
    fn macos_paths_land_in_application_support() {
        let paths = macos_paths_from_home(Path::new("/Users/alice"));
        assert_eq!(
            paths.normal_config,
            Path::new("/Users/alice/Library/Application Support/Claude/claude_desktop_config.json")
        );
        assert_eq!(
            paths.profile,
            Path::new(&format!(
                "/Users/alice/Library/Application Support/Claude-3p/configLibrary/{PROFILE_ID}.json"
            ))
        );
        assert_eq!(
            paths.meta,
            Path::new(
                "/Users/alice/Library/Application Support/Claude-3p/configLibrary/_meta.json"
            )
        );
    }

    #[test]
    fn linux_paths_land_in_config_dir() {
        let paths = linux_paths_from_config_dir(Path::new("/home/alice/.config"));
        assert_eq!(
            paths.normal_config,
            Path::new("/home/alice/.config/Claude/claude_desktop_config.json")
        );
        assert_eq!(
            paths.threep_config,
            Path::new("/home/alice/.config/Claude-3p/claude_desktop_config.json")
        );
    }

    /// 没有商店版容器时只有传统目录这一套。
    fn windows_classic_only(app_data: &Path, local_app_data: &Path) -> DesktopPaths {
        let targets = windows_targets_from_app_data(app_data, local_app_data);
        assert_eq!(targets.len(), 1, "{targets:?}");
        assert_eq!(targets[0].key, WINDOWS_CLASSIC_TARGET);
        targets[0].paths.clone()
    }

    #[test]
    fn windows_paths_prefer_the_exact_directory_names() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(temp.path().join("Claude")).expect("Claude");
        std::fs::create_dir_all(temp.path().join("Claude-3p")).expect("Claude-3p");
        let paths = windows_classic_only(&temp.path().join("Roaming"), temp.path());
        assert_eq!(paths.install_dir, temp.path().join("Claude"));
        assert_eq!(
            paths.threep_config,
            temp.path().join("Claude-3p").join(CONFIG_FILE)
        );
    }

    #[test]
    fn windows_paths_fall_back_to_a_suffixed_install() {
        // 安装目录名带后缀（beta 之类）时精确名不存在，要扫 Claude* 找出来。
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(temp.path().join("Claude-beta")).expect("Claude-beta");
        std::fs::create_dir_all(temp.path().join("Claude-beta-3p")).expect("Claude-beta-3p");
        let paths = windows_classic_only(&temp.path().join("Roaming"), temp.path());
        assert_eq!(paths.install_dir, temp.path().join("Claude-beta"));
        assert_eq!(
            paths.threep_config,
            temp.path().join("Claude-beta-3p").join(CONFIG_FILE)
        );
    }

    #[test]
    fn windows_paths_fall_back_to_the_roaming_pair() {
        // 1P / 3P 都在 %APPDATA% 的装法:成对取 %APPDATA% 下的两个目录。
        let temp = tempfile::tempdir().expect("tempdir");
        let roaming = temp.path().join("Roaming");
        std::fs::create_dir_all(roaming.join("Claude")).expect("Claude");
        std::fs::create_dir_all(roaming.join("Claude-3p")).expect("Claude-3p");
        let paths = windows_classic_only(&roaming, temp.path());
        assert_eq!(paths.install_dir, roaming.join("Claude"));
        assert_eq!(
            paths.normal_config,
            roaming.join("Claude").join(CONFIG_FILE)
        );
        assert_eq!(
            paths.threep_config,
            roaming.join("Claude-3p").join(CONFIG_FILE)
        );
    }

    #[test]
    fn windows_paths_prefer_the_local_pair_over_roaming() {
        let temp = tempfile::tempdir().expect("tempdir");
        let roaming = temp.path().join("Roaming");
        std::fs::create_dir_all(roaming.join("Claude")).expect("Roaming Claude");
        std::fs::create_dir_all(roaming.join("Claude-3p")).expect("Roaming Claude-3p");
        std::fs::create_dir_all(temp.path().join("Claude")).expect("Claude");
        std::fs::create_dir_all(temp.path().join("Claude-3p")).expect("Claude-3p");
        let paths = windows_classic_only(&roaming, temp.path());
        assert_eq!(paths.install_dir, temp.path().join("Claude"));
        assert_eq!(
            paths.threep_config,
            temp.path().join("Claude-3p").join(CONFIG_FILE)
        );
    }

    /// 有商店版容器时两套都在:容器排第一,传统目录跟在后面。
    fn windows_msix_and_classic(
        app_data: &Path,
        local_app_data: &Path,
    ) -> (DesktopPaths, DesktopPaths) {
        let targets = windows_targets_from_app_data(app_data, local_app_data);
        let keys: Vec<_> = targets.iter().map(|target| target.key).collect();
        assert_eq!(keys, vec![WINDOWS_MSIX_TARGET, WINDOWS_CLASSIC_TARGET]);
        (targets[0].paths.clone(), targets[1].paths.clone())
    }

    #[test]
    fn windows_targets_both_the_msix_container_and_the_classic_dirs() {
        // 容器和传统目录同时在:不挑,两套都写。只写容器时,关掉了文件系统重定向的
        // 包读的是传统目录;只写传统目录时,走重定向的包又看不见。
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(temp.path().join("Claude")).expect("Claude");
        std::fs::create_dir_all(temp.path().join("Claude-3p")).expect("Claude-3p");
        let local_cache = temp
            .path()
            .join("Packages")
            .join("Claude_pzs8sxrjxfjjc")
            .join("LocalCache");
        std::fs::create_dir_all(local_cache.join("Roaming").join("Claude")).expect("Roaming");
        std::fs::create_dir_all(local_cache.join("Local").join("Claude-3p")).expect("Local");

        let (msix, classic) = windows_msix_and_classic(&temp.path().join("Roaming"), temp.path());
        assert_eq!(msix.install_dir, local_cache);
        assert_eq!(
            msix.normal_config,
            local_cache.join("Roaming").join("Claude").join(CONFIG_FILE)
        );
        assert_eq!(
            msix.profile,
            local_cache
                .join("Local")
                .join("Claude-3p")
                .join(CONFIG_LIBRARY_DIR)
                .join(format!("{PROFILE_ID}.json"))
        );
        assert_eq!(classic.install_dir, temp.path().join("Claude"));
        assert_eq!(
            classic.profile,
            temp.path()
                .join("Claude-3p")
                .join(CONFIG_LIBRARY_DIR)
                .join(format!("{PROFILE_ID}.json"))
        );
    }

    #[test]
    fn windows_msix_counts_as_installed_before_any_config_exists() {
        // 刚装好、只启动过一次的商店版:容器在,1P / 3P 目录都还没有。
        let temp = tempfile::tempdir().expect("tempdir");
        let local_cache = temp
            .path()
            .join("Packages")
            .join("Claude_pzs8sxrjxfjjc")
            .join("LocalCache");
        std::fs::create_dir_all(&local_cache).expect("LocalCache");

        let (paths, classic) = windows_msix_and_classic(&temp.path().join("Roaming"), temp.path());
        assert!(paths.install_dir.is_dir());
        // 传统目录还没有,照样在写入列表里
        assert_eq!(
            classic.threep_config,
            temp.path().join("Claude-3p").join(CONFIG_FILE)
        );
        assert_eq!(
            paths.normal_config,
            local_cache.join("Roaming").join("Claude").join(CONFIG_FILE)
        );
        assert_eq!(
            paths.threep_config,
            local_cache
                .join("Local")
                .join("Claude-3p")
                .join(CONFIG_FILE)
        );
    }

    #[test]
    fn windows_msix_keeps_a_not_yet_migrated_roaming_3p_dir() {
        let temp = tempfile::tempdir().expect("tempdir");
        let local_cache = temp
            .path()
            .join("Packages")
            .join("Claude_pzs8sxrjxfjjc")
            .join("LocalCache");
        std::fs::create_dir_all(local_cache.join("Roaming").join("Claude-3p")).expect("Roaming");

        let (paths, _) = windows_msix_and_classic(&temp.path().join("Roaming"), temp.path());
        assert_eq!(
            paths.threep_config,
            local_cache
                .join("Roaming")
                .join("Claude-3p")
                .join(CONFIG_FILE)
        );
    }

    #[test]
    fn windows_ignores_a_never_launched_msix_package() {
        // 没有 LocalCache 的包不算,只剩传统路径。
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(temp.path().join("Packages").join("Claude_pzs8sxrjxfjjc"))
            .expect("package");
        std::fs::create_dir_all(temp.path().join("Claude")).expect("Claude");

        let paths = windows_classic_only(&temp.path().join("Roaming"), temp.path());
        assert_eq!(paths.install_dir, temp.path().join("Claude"));
    }

    // ---- profile 合并 ----------------------------------------------------

    #[test]
    fn merge_overwrites_our_fields_and_keeps_everything_else() {
        let existing: Map<String, Value> = json!({
            "theme": "dark",
            "inferenceGatewayBaseUrl": "https://old.example.com",
            "inferenceGatewayApiKey": "sk-old",
            "userTweak": { "nested": true },
        })
        .as_object()
        .unwrap()
        .clone();
        let credentials = GatewayCredentials {
            base_url: "https://api.fwai.space".to_string(),
            api_key: "sk-new".to_string(),
        };
        let merged = merge_profile(existing, build_profile_fields(&credentials, &[]));

        // 我们独占的字段被换成新值，旧 Key 不残留
        assert_eq!(merged["inferenceGatewayApiKey"], json!("sk-new"));
        assert_eq!(
            merged["inferenceGatewayBaseUrl"],
            json!("https://api.fwai.space")
        );
        assert_eq!(merged["inferenceProvider"], json!("gateway"));
        assert_eq!(merged["inferenceGatewayAuthScheme"], json!("bearer"));
        // 用户自己的键原样保留
        assert_eq!(merged["theme"], json!("dark"));
        assert_eq!(merged["userTweak"], json!({ "nested": true }));
        // 策略键缺失时补上
        assert_eq!(merged["disableDeploymentModeChooser"], json!(true));
        assert_eq!(merged["coworkEgressAllowedHosts"], json!(["*"]));
    }

    #[test]
    fn merge_does_not_push_policy_keys_back_after_the_user_changed_them() {
        let existing: Map<String, Value> = json!({
            "disableDeploymentModeChooser": false,
            "coworkEgressAllowedHosts": ["example.com"],
        })
        .as_object()
        .unwrap()
        .clone();
        let credentials = GatewayCredentials {
            base_url: "https://api.fwai.space".to_string(),
            api_key: "sk".to_string(),
        };
        let merged = merge_profile(existing, build_profile_fields(&credentials, &[]));
        assert_eq!(merged["disableDeploymentModeChooser"], json!(false));
        assert_eq!(merged["coworkEgressAllowedHosts"], json!(["example.com"]));
    }

    #[test]
    fn empty_model_list_omits_the_key_so_desktop_reads_v1_models() {
        // 写一个空数组等于告诉 Desktop「一个模型都没有」，必须整个不写这个键。
        let credentials = GatewayCredentials {
            base_url: "https://api.fwai.space".to_string(),
            api_key: "sk".to_string(),
        };
        let fields = build_profile_fields(&credentials, &[]);
        assert!(!fields.contains_key("inferenceModels"));
    }

    // ---- _meta.json ------------------------------------------------------

    #[test]
    fn apply_meta_registers_us_without_moving_existing_entries() {
        let mut meta: Map<String, Value> = json!({
            "entries": [
                { "id": "someone-else", "name": "Theirs" },
                { "id": PROFILE_ID, "name": "stale name" },
            ],
            "appliedId": "someone-else",
        })
        .as_object()
        .unwrap()
        .clone();
        apply_meta(&mut meta).expect("apply");
        let entries = meta["entries"].as_array().unwrap();
        // 原位改名，不挪位置
        assert_eq!(entries[0]["id"], json!("someone-else"));
        assert_eq!(entries[1]["id"], json!(PROFILE_ID));
        assert_eq!(entries[1]["name"], json!(PROFILE_NAME));
        assert_eq!(meta["appliedId"], json!(PROFILE_ID));
    }

    #[test]
    fn unapply_meta_hands_applied_id_to_the_next_profile() {
        let mut meta: Map<String, Value> = json!({
            "entries": [
                { "id": PROFILE_ID, "name": PROFILE_NAME },
                { "id": "someone-else", "name": "Theirs" },
            ],
            "appliedId": PROFILE_ID,
        })
        .as_object()
        .unwrap()
        .clone();
        unapply_meta(&mut meta).expect("unapply");
        let entries = meta["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["id"], json!("someone-else"));
        assert_eq!(meta["appliedId"], json!("someone-else"));
    }

    #[test]
    fn unapply_meta_drops_applied_id_when_we_were_the_only_profile() {
        let mut meta: Map<String, Value> = json!({
            "entries": [{ "id": PROFILE_ID, "name": PROFILE_NAME }],
            "appliedId": PROFILE_ID,
        })
        .as_object()
        .unwrap()
        .clone();
        unapply_meta(&mut meta).expect("unapply");
        assert!(meta["entries"].as_array().unwrap().is_empty());
        assert!(!meta.contains_key("appliedId"));
    }

    #[test]
    fn unapply_meta_leaves_someone_elses_applied_id_alone() {
        let mut meta: Map<String, Value> = json!({
            "entries": [
                { "id": PROFILE_ID, "name": PROFILE_NAME },
                { "id": "someone-else", "name": "Theirs" },
            ],
            "appliedId": "someone-else",
        })
        .as_object()
        .unwrap()
        .clone();
        unapply_meta(&mut meta).expect("unapply");
        assert_eq!(meta["appliedId"], json!("someone-else"));
    }

    // ---- 端到端 ----------------------------------------------------------

    #[test]
    fn apply_writes_all_four_files() {
        let temp = tempfile::tempdir().expect("tempdir");
        let backups = temp.path().join("backups");
        let paths = installed_paths(temp.path());
        let provider = provider_with(&[("claude-sonnet-5", true), ("claude-opus-5", false)]);

        apply(&provider, &paths, &backups).expect("apply");

        assert_eq!(read(&paths.normal_config)["deploymentMode"], json!("3p"));
        assert_eq!(read(&paths.threep_config)["deploymentMode"], json!("3p"));

        let profile = read(&paths.profile);
        assert_eq!(profile["inferenceProvider"], json!("gateway"));
        assert_eq!(
            profile["inferenceGatewayBaseUrl"],
            json!("https://api.fwai.space")
        );
        assert_eq!(profile["inferenceGatewayApiKey"], json!("sk-test-token"));
        assert_eq!(profile["inferenceGatewayAuthScheme"], json!("bearer"));
        assert_eq!(
            profile["inferenceModels"],
            json!(["claude-opus-5", { "name": "claude-sonnet-5", "supports1m": true }])
        );

        let meta = read(&paths.meta);
        assert_eq!(meta["appliedId"], json!(PROFILE_ID));
        assert_eq!(meta["entries"][0]["id"], json!(PROFILE_ID));
    }

    #[test]
    fn apply_refuses_when_desktop_is_not_installed() {
        let temp = tempfile::tempdir().expect("tempdir");
        // 故意不建 Claude 目录
        let paths = paths_from_dirs(temp.path().join("Claude"), temp.path().join("Claude-3p"));
        let provider = provider_with(&[("claude-sonnet-5", false)]);

        let err =
            apply(&provider, &paths, &temp.path().join("backups")).expect_err("should refuse");
        assert!(err.to_string().contains("Claude Desktop"), "{err}");
        // 最重要的是别在用户机器上凭空造出目录
        assert!(!paths.config_library.exists());
        assert!(!paths.normal_config.exists());
    }

    #[test]
    fn apply_preserves_unrelated_keys_in_desktops_own_config() {
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = installed_paths(temp.path());
        std::fs::write(
            &paths.normal_config,
            serde_json::to_string_pretty(&json!({
                "deploymentMode": "1p",
                "mcpServers": { "fs": { "command": "npx" } },
                "locale": "zh-CN",
            }))
            .unwrap(),
        )
        .expect("seed");

        apply(
            &provider_with(&[("claude-sonnet-5", false)]),
            &paths,
            &temp.path().join("backups"),
        )
        .expect("apply");

        let normal = read(&paths.normal_config);
        assert_eq!(normal["deploymentMode"], json!("3p"));
        // Desktop 自己的设置一个字节都不该动
        assert_eq!(normal["mcpServers"], json!({ "fs": { "command": "npx" } }));
        assert_eq!(normal["locale"], json!("zh-CN"));
    }

    #[test]
    fn apply_preserves_key_order_of_desktops_config() {
        // 这些是另一个应用的文件，整份重排键序既是无谓 diff，也可能和 Desktop
        // 自己的写回逻辑打架。write_json_file 会排序，所以这里不能用它。
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = installed_paths(temp.path());
        std::fs::write(
            &paths.normal_config,
            r#"{"zebra":1,"deploymentMode":"1p","alpha":2}"#,
        )
        .expect("seed");

        apply(
            &provider_with(&[("claude-sonnet-5", false)]),
            &paths,
            &temp.path().join("backups"),
        )
        .expect("apply");

        let text = std::fs::read_to_string(&paths.normal_config).expect("read");
        let zebra = text.find("zebra").expect("zebra present");
        let alpha = text.find("alpha").expect("alpha present");
        assert!(zebra < alpha, "key order should survive, got: {text}");
    }

    #[test]
    fn apply_backs_up_the_original_once() {
        let temp = tempfile::tempdir().expect("tempdir");
        let backups = temp.path().join("backups");
        let paths = installed_paths(temp.path());
        std::fs::write(&paths.normal_config, r#"{"deploymentMode":"1p"}"#).expect("seed");

        let provider = provider_with(&[("claude-sonnet-5", false)]);
        apply(&provider, &paths, &backups).expect("first apply");
        apply(&provider, &paths, &backups).expect("second apply");

        // 备份留的始终是我们没碰过之前那一份，第二次写入不该把它覆盖成 3p
        let backup = backups.join("claude-desktop.Claude.claude_desktop_config.json");
        let text = std::fs::read_to_string(&backup).expect("backup exists");
        assert!(
            text.contains("1p"),
            "backup should hold the pre-change file: {text}"
        );
    }

    #[test]
    fn restore_hands_desktop_back_to_its_own_login() {
        let temp = tempfile::tempdir().expect("tempdir");
        let backups = temp.path().join("backups");
        let paths = installed_paths(temp.path());
        let provider = provider_with(&[("claude-sonnet-5", false)]);
        apply(&provider, &paths, &backups).expect("apply");

        restore_official_at_targets(&single(&paths), &backups).expect("restore");

        assert_eq!(read(&paths.normal_config)["deploymentMode"], json!("1p"));
        assert_eq!(read(&paths.threep_config)["deploymentMode"], json!("1p"));

        // profile 文件保留，但 Key 和地址都从磁盘上清掉了
        let profile = read(&paths.profile);
        assert!(!profile
            .as_object()
            .unwrap()
            .contains_key("inferenceGatewayApiKey"));
        assert!(!profile
            .as_object()
            .unwrap()
            .contains_key("inferenceProvider"));
        // 用户在 Desktop 里改的策略键留着，下次切回来还在
        assert_eq!(profile["disableDeploymentModeChooser"], json!(true));

        // Desktop 只按 _meta.json 列 profile，摘掉条目后它不会再被列出
        let meta = read(&paths.meta);
        assert!(meta["entries"].as_array().unwrap().is_empty());
        assert!(!meta.as_object().unwrap().contains_key("appliedId"));
    }

    #[test]
    fn restore_clears_legacy_enterprise_gateway_keys() {
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = installed_paths(temp.path());
        std::fs::write(
            &paths.threep_config,
            serde_json::to_string(&json!({
                "deploymentMode": "3p",
                "enterpriseConfig": {
                    "inferenceGatewayApiKey": "sk-legacy",
                    "inferenceProvider": "gateway",
                },
            }))
            .unwrap(),
        )
        .expect("seed");

        restore_official_at_targets(&single(&paths), &temp.path().join("backups"))
            .expect("restore");

        let threep = read(&paths.threep_config);
        assert_eq!(threep["deploymentMode"], json!("1p"));
        // 清空之后连空壳也不留
        assert!(!threep.as_object().unwrap().contains_key("enterpriseConfig"));
    }

    #[test]
    fn restore_keeps_unrelated_enterprise_config_keys() {
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = installed_paths(temp.path());
        std::fs::write(
            &paths.threep_config,
            serde_json::to_string(&json!({
                "enterpriseConfig": {
                    "inferenceGatewayApiKey": "sk-legacy",
                    "someOrgPolicy": true,
                },
            }))
            .unwrap(),
        )
        .expect("seed");

        restore_official_at_targets(&single(&paths), &temp.path().join("backups"))
            .expect("restore");

        let threep = read(&paths.threep_config);
        assert_eq!(threep["enterpriseConfig"], json!({ "someOrgPolicy": true }));
    }

    // ---- 动手前快照 ----------------------------------------------------

    #[test]
    fn snapshot_records_the_prior_deployment_mode_and_applied_id() {
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = installed_paths(temp.path());
        std::fs::write(&paths.normal_config, r#"{"deploymentMode":"3p"}"#).expect("seed");
        std::fs::write(
            &paths.meta,
            r#"{"entries":[{"id":"theirs","name":"Theirs"}],"appliedId":"theirs"}"#,
        )
        .expect("seed");

        let snapshot = capture(&paths);
        assert_eq!(snapshot.normal_deployment_mode.as_deref(), Some("3p"));
        // 这个文件还不存在，原本就没有这个键
        assert_eq!(snapshot.threep_deployment_mode, None);
        assert_eq!(snapshot.applied_id.as_deref(), Some("theirs"));
    }

    /// 一个本来就在用 3P、还配着自己 profile 的用户，开关一轮之后必须回到原样。
    ///
    /// 这是 restore 不能硬写 `1p` 的理由：那会把他从 3P 模式踢回官方登录，
    /// 而他的 profile 还在 configLibrary 里躺着。
    #[test]
    fn a_user_already_on_3p_is_returned_to_their_own_profile() {
        let temp = tempfile::tempdir().expect("tempdir");
        let backups = temp.path().join("backups");
        let paths = installed_paths(temp.path());
        std::fs::write(&paths.normal_config, r#"{"deploymentMode":"3p"}"#).expect("seed");
        std::fs::write(&paths.threep_config, r#"{"deploymentMode":"3p"}"#).expect("seed");
        std::fs::write(
            &paths.meta,
            r#"{"entries":[{"id":"theirs","name":"Theirs"}],"appliedId":"theirs"}"#,
        )
        .expect("seed");

        let snapshot = capture_snapshot_at_targets(&single(&paths)).expect("capture");
        apply(
            &provider_with(&[("claude-sonnet-5", false)]),
            &paths,
            &backups,
        )
        .expect("apply");
        // 我们接管期间 appliedId 指向我们
        assert_eq!(read(&paths.meta)["appliedId"], json!(PROFILE_ID));

        restore_snapshot_at_targets(&single(&paths), &snapshot, &backups).expect("restore");

        // 回到他原来的模式和 profile，而不是被按成 1p
        assert_eq!(read(&paths.normal_config)["deploymentMode"], json!("3p"));
        assert_eq!(read(&paths.threep_config)["deploymentMode"], json!("3p"));
        assert_eq!(read(&paths.meta)["appliedId"], json!("theirs"));
        let entries = read(&paths.meta)["entries"].as_array().unwrap().clone();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["id"], json!("theirs"));
    }

    #[test]
    fn restore_removes_the_key_when_it_was_absent_before() {
        // 原本没有 deploymentMode（全新安装的 Desktop）：还原时该删掉，
        // 而不是替用户写一个他从没设过的 1p。
        let temp = tempfile::tempdir().expect("tempdir");
        let backups = temp.path().join("backups");
        let paths = installed_paths(temp.path());
        std::fs::write(&paths.normal_config, r#"{"preferences":{"locale":"zh"}}"#).expect("seed");

        let snapshot = capture_snapshot_at_targets(&single(&paths)).expect("capture");
        assert_eq!(
            snapshot.targets[DEFAULT_TARGET].normal_deployment_mode,
            None
        );

        apply(&provider_with(&[]), &paths, &backups).expect("apply");
        assert_eq!(read(&paths.normal_config)["deploymentMode"], json!("3p"));

        restore_snapshot_at_targets(&single(&paths), &snapshot, &backups).expect("restore");

        let normal = read(&paths.normal_config);
        assert!(
            !normal.as_object().unwrap().contains_key("deploymentMode"),
            "原本没有这个键，还原后不该凭空出现: {normal}"
        );
        // 用户自己的键照旧
        assert_eq!(normal["preferences"]["locale"], json!("zh"));
    }

    #[test]
    fn restore_without_a_snapshot_falls_back_to_1p() {
        // 删除条目那条路径没有动手前的记录可依据，兜底交还官方。
        let temp = tempfile::tempdir().expect("tempdir");
        let backups = temp.path().join("backups");
        let paths = installed_paths(temp.path());
        apply(&provider_with(&[]), &paths, &backups).expect("apply");

        restore_official_at_targets(&single(&paths), &backups).expect("restore");

        assert_eq!(read(&paths.normal_config)["deploymentMode"], json!("1p"));
    }

    #[test]
    fn snapshot_is_empty_when_desktop_is_not_installed() {
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = paths_from_dirs(temp.path().join("Claude"), temp.path().join("Claude-3p"));
        // 没装过时不该去读（也读不到）任何东西，更不该建目录
        let snapshot = capture_snapshot_at_targets(&single(&paths)).expect("capture");
        assert_eq!(snapshot, DesktopSnapshot::default());
        assert!(!paths.config_library.exists());
    }

    #[test]
    fn restore_is_a_noop_when_desktop_is_not_installed() {
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = paths_from_dirs(temp.path().join("Claude"), temp.path().join("Claude-3p"));
        restore_official_at_targets(&single(&paths), &temp.path().join("backups")).expect("noop");
        assert!(!paths.normal_config.exists());
        assert!(!paths.config_library.exists());
    }

    #[test]
    fn unparseable_desktop_config_is_not_silently_replaced() {
        // 手写坏了的配置当成空对象处理，会把用户的内容整份丢掉。
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = installed_paths(temp.path());
        std::fs::write(&paths.normal_config, "{ this is not json").expect("seed");

        let err = apply(
            &provider_with(&[("claude-sonnet-5", false)]),
            &paths,
            &temp.path().join("backups"),
        )
        .expect_err("should refuse to write");
        // 文件原样留着，等用户自己处理
        let text = std::fs::read_to_string(&paths.normal_config).expect("read");
        assert_eq!(text, "{ this is not json", "err was: {err}");
    }

    #[test]
    fn apply_rejects_an_unsafe_model_before_touching_any_file() {
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = installed_paths(temp.path());
        let provider = provider_with(&[("gpt-5.6", false)]);

        apply(&provider, &paths, &temp.path().join("backups")).expect_err("should reject");
        // 校验不过就一个文件都不碰——写一半会让 Desktop 的模型菜单整个空掉
        assert!(!paths.profile.exists());
        assert!(!paths.normal_config.exists());
    }

    #[cfg(unix)]
    #[test]
    fn profile_is_written_with_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = installed_paths(temp.path());
        apply(
            &provider_with(&[("claude-sonnet-5", false)]),
            &paths,
            &temp.path().join("backups"),
        )
        .expect("apply");

        // profile 里有 API Key
        let mode = std::fs::metadata(&paths.profile)
            .expect("meta")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "profile should be owner-only");
    }

    #[test]
    fn restore_if_matches_leaves_a_profile_written_by_another_provider_alone() {
        let temp = tempfile::tempdir().expect("tempdir");
        let backups = temp.path().join("backups");
        let paths = installed_paths(temp.path());
        apply(&provider_with(&[]), &paths, &backups).expect("apply");

        // 删的是个 key 不同的旧条目：它不是当前生效的那家，不该动 Desktop 的配置
        let mut other = provider_with(&[]);
        other.settings_config = json!({
            "env": { "ANTHROPIC_BASE_URL": "https://other", "ANTHROPIC_AUTH_TOKEN": "sk-other" }
        });
        restore_official_if_matches_at_targets(&other, &single(&paths), &backups).expect("noop");

        assert_eq!(read(&paths.normal_config)["deploymentMode"], json!("3p"));
        assert_eq!(read(&paths.meta)["appliedId"], json!(PROFILE_ID));
    }

    #[test]
    fn restore_if_matches_hands_back_when_it_is_the_live_provider() {
        let temp = tempfile::tempdir().expect("tempdir");
        let backups = temp.path().join("backups");
        let paths = installed_paths(temp.path());
        let provider = provider_with(&[]);
        apply(&provider, &paths, &backups).expect("apply");

        restore_official_if_matches_at_targets(&provider, &single(&paths), &backups)
            .expect("restore");

        assert_eq!(read(&paths.normal_config)["deploymentMode"], json!("1p"));
        assert!(read(&paths.meta)["entries"].as_array().unwrap().is_empty());
    }

    // ---- Windows 两套目录 ----------------------------------------------

    /// 只装了商店版:容器装过,传统目录还没有。
    fn msix_and_classic_targets(root: &Path) -> Vec<DesktopTarget> {
        let msix = installed_paths(&root.join("LocalCache"));
        let classic = paths_from_dirs(root.join("Claude"), root.join("Claude-3p"));
        vec![
            DesktopTarget {
                key: WINDOWS_MSIX_TARGET,
                paths: msix,
            },
            DesktopTarget {
                key: WINDOWS_CLASSIC_TARGET,
                paths: classic,
            },
        ]
    }

    fn apply_to(targets: &[DesktopTarget], backup_dir: &Path) {
        let provider = provider_with(&[("claude-sonnet-5", false)]);
        let credentials = gateway_credentials(&provider).expect("credentials");
        apply_provider_to_targets(&provider, &credentials, targets, backup_dir).expect("apply");
    }

    #[test]
    fn apply_writes_every_target_even_one_desktop_has_not_created_yet() {
        let temp = tempfile::tempdir().expect("tempdir");
        let targets = msix_and_classic_targets(temp.path());

        apply_to(&targets, &temp.path().join("backups"));

        for target in &targets {
            let paths = &target.paths;
            assert_eq!(read(&paths.normal_config)["deploymentMode"], json!("3p"));
            assert_eq!(read(&paths.threep_config)["deploymentMode"], json!("3p"));
            assert_eq!(
                read(&paths.profile)["inferenceGatewayApiKey"],
                json!("sk-test-token")
            );
            assert_eq!(read(&paths.meta)["appliedId"], json!(PROFILE_ID));
        }
    }

    #[test]
    fn apply_refuses_when_no_target_is_installed() {
        let temp = tempfile::tempdir().expect("tempdir");
        let targets = vec![
            DesktopTarget {
                key: WINDOWS_MSIX_TARGET,
                paths: paths_from_dirs(temp.path().join("a"), temp.path().join("a-3p")),
            },
            DesktopTarget {
                key: WINDOWS_CLASSIC_TARGET,
                paths: paths_from_dirs(temp.path().join("b"), temp.path().join("b-3p")),
            },
        ];
        let provider = provider_with(&[]);
        let credentials = gateway_credentials(&provider).expect("credentials");
        apply_provider_to_targets(
            &provider,
            &credentials,
            &targets,
            &temp.path().join("backups"),
        )
        .expect_err("should refuse");
        for target in &targets {
            assert!(!target.paths.normal_config.exists());
            assert!(!target.paths.config_library.exists());
        }
    }

    #[test]
    fn backups_of_the_two_targets_do_not_overwrite_each_other() {
        let temp = tempfile::tempdir().expect("tempdir");
        let backups = temp.path().join("backups");
        let targets = msix_and_classic_targets(temp.path());
        std::fs::create_dir_all(&targets[1].paths.install_dir).expect("classic");
        std::fs::write(&targets[0].paths.normal_config, r#"{"from":"msix"}"#).expect("seed");
        std::fs::write(&targets[1].paths.normal_config, r#"{"from":"classic"}"#).expect("seed");

        apply_to(&targets, &backups);

        let msix = std::fs::read_to_string(
            backups.join("claude-desktop.msix.Claude.claude_desktop_config.json"),
        )
        .expect("msix backup");
        let classic = std::fs::read_to_string(
            backups.join("claude-desktop.classic.Claude.claude_desktop_config.json"),
        )
        .expect("classic backup");
        assert!(msix.contains("msix"), "{msix}");
        assert!(classic.contains("classic"), "{classic}");
    }

    #[test]
    fn restore_returns_each_target_to_its_own_prior_state() {
        let temp = tempfile::tempdir().expect("tempdir");
        let backups = temp.path().join("backups");
        let targets = msix_and_classic_targets(temp.path());
        std::fs::write(
            &targets[0].paths.normal_config,
            r#"{"deploymentMode":"3p"}"#,
        )
        .expect("seed");
        std::fs::write(
            &targets[0].paths.meta,
            r#"{"entries":[{"id":"theirs","name":"Theirs"}],"appliedId":"theirs"}"#,
        )
        .expect("seed");

        let snapshot = capture_snapshot_at_targets(&targets).expect("capture");
        apply_to(&targets, &backups);
        restore_snapshot_at_targets(&targets, &snapshot, &backups).expect("restore");

        // 容器那套回到用户自己的 3P profile
        let msix = &targets[0].paths;
        assert_eq!(read(&msix.normal_config)["deploymentMode"], json!("3p"));
        assert_eq!(read(&msix.meta)["appliedId"], json!("theirs"));
        // 传统那套是我们建的:原本没有 deploymentMode,还原后也没有
        let classic = &targets[1].paths;
        assert!(!read(&classic.normal_config)
            .as_object()
            .unwrap()
            .contains_key("deploymentMode"));
        assert!(read(&classic.meta)["entries"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(!read(&classic.profile)
            .as_object()
            .unwrap()
            .contains_key("inferenceGatewayApiKey"));
    }

    #[test]
    fn old_single_target_snapshot_still_restores_the_first_target() {
        // 旧版本开的转发,备份里的快照是摊平的三个字段。升级后两套都被写过:
        // 第一套按旧快照还原,第二套没有记录,按交还 1P 兜底。
        let temp = tempfile::tempdir().expect("tempdir");
        let backups = temp.path().join("backups");
        let targets = msix_and_classic_targets(temp.path());
        let snapshot: DesktopSnapshot = serde_json::from_value(json!({
            "normalDeploymentMode": "3p",
            "threepDeploymentMode": "3p",
            "appliedId": "theirs",
        }))
        .expect("legacy snapshot");
        assert!(snapshot.targets.is_empty());

        apply_to(&targets, &backups);
        restore_snapshot_at_targets(&targets, &snapshot, &backups).expect("restore");

        let msix = &targets[0].paths;
        assert_eq!(read(&msix.normal_config)["deploymentMode"], json!("3p"));
        assert_eq!(read(&msix.meta)["appliedId"], json!("theirs"));
        let classic = &targets[1].paths;
        assert_eq!(read(&classic.normal_config)["deploymentMode"], json!("1p"));
        assert!(read(&classic.meta)["entries"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn a_target_missing_from_the_snapshot_is_left_alone_if_we_never_wrote_it() {
        let temp = tempfile::tempdir().expect("tempdir");
        let backups = temp.path().join("backups");
        let targets = msix_and_classic_targets(temp.path());
        // 第二套是用户自己的 3P 配置,我们从没写过
        std::fs::create_dir_all(&targets[1].paths.config_library).expect("classic");
        std::fs::create_dir_all(&targets[1].paths.install_dir).expect("classic");
        std::fs::write(
            &targets[1].paths.normal_config,
            r#"{"deploymentMode":"3p"}"#,
        )
        .expect("seed");
        std::fs::write(
            &targets[1].paths.meta,
            r#"{"entries":[{"id":"theirs","name":"Theirs"}],"appliedId":"theirs"}"#,
        )
        .expect("seed");

        let legacy = DesktopSnapshot::default();
        restore_snapshot_at_targets(&targets, &legacy, &backups).expect("restore");

        assert_eq!(
            read(&targets[1].paths.normal_config)["deploymentMode"],
            json!("3p")
        );
        assert_eq!(read(&targets[1].paths.meta)["appliedId"], json!("theirs"));
    }

    #[test]
    fn snapshot_serializes_per_target_without_the_legacy_fields() {
        let temp = tempfile::tempdir().expect("tempdir");
        let targets = msix_and_classic_targets(temp.path());
        std::fs::write(
            &targets[0].paths.normal_config,
            r#"{"deploymentMode":"3p"}"#,
        )
        .expect("seed");

        let snapshot = capture_snapshot_at_targets(&targets).expect("capture");
        let value = serde_json::to_value(&snapshot).expect("serialize");
        assert_eq!(
            value,
            json!({ "targets": { "msix": { "normalDeploymentMode": "3p" }, "classic": {} } })
        );
        let back: DesktopSnapshot = serde_json::from_value(value).expect("deserialize");
        assert_eq!(back, snapshot);
    }

    #[test]
    fn restore_if_matches_checks_each_target_separately() {
        let temp = tempfile::tempdir().expect("tempdir");
        let backups = temp.path().join("backups");
        let targets = msix_and_classic_targets(temp.path());
        apply_to(&targets, &backups);
        // 第二套被另一家的 Key 覆盖了
        let mut other = provider_with(&[("claude-sonnet-5", false)]);
        other.settings_config = json!({
            "env": { "ANTHROPIC_BASE_URL": "https://other", "ANTHROPIC_AUTH_TOKEN": "sk-other" }
        });
        let credentials = gateway_credentials(&other).expect("credentials");
        apply_provider_to_targets(&other, &credentials, &targets[1..], &backups).expect("apply");

        restore_official_if_matches_at_targets(&provider_with(&[]), &targets, &backups)
            .expect("restore");

        assert_eq!(
            read(&targets[0].paths.normal_config)["deploymentMode"],
            json!("1p")
        );
        assert_eq!(
            read(&targets[1].paths.normal_config)["deploymentMode"],
            json!("3p")
        );
    }
}
