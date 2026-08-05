//! 转发覆盖：只改 endpoint 和 api key，别的一概不动。
//!
//! 「开启转发」以前走的是标准 provider 切换，也就是把整份 provider 配置整文件
//! 覆盖到 live 上。后果是用户在转发期间对 live 的任何修改（换 model、加 MCP
//! server、调 theme）都会在下一次写入时被抹掉，结束转发时又被另一份快照整体
//! 覆盖一遍。
//!
//! 这里换成字段级：
//!
//! 1. 开启转发：先把 live 里**当前**的 endpoint + key 存进备份，再只覆盖这两
//!    个字段，文件其余内容原样保留。
//! 2. 结束转发：只把这两个字段写回去，转发期间用户改的东西全部保留。
//! 3. 开启转发时 live 里本就没有这两个字段（全新机器，或上次登出清掉了），
//!    备份记为「原本不存在」，结束时删掉它们——不凭空造一个用户从没配过的 key。
//!
//! 备份存在 settings 表，每个 app 一条，键是 `forwarding_live_backup_<app>`。
//! 备份存在与否同时也是「转发是否开着」的唯一事实来源。
//!
//! 光有 start/stop 还不够：转发期间 token 刷新会走 `ProviderService::update`，
//! 用户在供应商列表里点一下 LLM Gateway 会走 `switch`，两条路最后都落到
//! `write_live_with_common_config` 的整文件写。所以 `intercept_live_write`
//! 挂在那个漏斗上——只要该 app 的转发开着、写的又是转发那个条目，就一律降级成
//! 字段级覆盖。不然「只覆盖两个字段」的保证会被这些旁路绕过去。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use toml_edit::DocumentMut;

use crate::app_config::AppType;
use crate::database::Database;
use crate::error::AppError;
use crate::provider::Provider;
use crate::store::AppState;

use super::live::LiveWriteIntent;

const CLAUDE_TOKEN_KEY: &str = "ANTHROPIC_AUTH_TOKEN";
const CLAUDE_BASE_URL_KEY: &str = "ANTHROPIC_BASE_URL";
const CODEX_TOKEN_KEY: &str = "OPENAI_API_KEY";
/// Codex 侧网关的 model_provider 键名，与前端 `buildGatewayProvider` 一致。
const CODEX_GATEWAY_KEY: &str = "llm_gateway";

fn is_false(value: &bool) -> bool {
    !*value
}

/// 转发前的 live 凭据快照。字段为 `None` 一律表示「原本不存在」，结束转发时
/// 应当删除而不是写回。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ForwardingBackup {
    /// 触发这次转发的供应商条目 id，用来判断某次 live 写入该不该降级成字段级。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// 转发前生效的供应商条目 id，结束转发时把「当前供应商」指回去。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_provider_id: Option<String>,
    /// Claude: `env.ANTHROPIC_AUTH_TOKEN`；Codex: auth.json 的 `OPENAI_API_KEY`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    /// Claude: `env.ANTHROPIC_BASE_URL`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// 网关自己的 token。转发期间的任何 live 写入都以它为准，与用户在编辑页里
    /// 把凭据改成了什么无关——否则用户保存一次就能把自己踢出转发。
    ///
    /// 旧备份没有这两个字段，为 `None` 时回退到从 provider 条目现读（见
    /// `gateway_credentials`），行为与加这两个字段之前一致。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway_token: Option<String>,
    /// 网关自己的 base_url。Codex 上是不带 `/v1` 的形式，`apply_codex` 会自己拼。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway_base_url: Option<String>,
    /// Codex: 转发前生效的 `model_provider` 键。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_provider: Option<String>,
    /// Codex: `[model_providers.llm_gateway]` 是我们建的，结束时要删掉。它本来
    /// 就在（上一版整文件写留下的）就保持原样——留一张没被选中的 provider 表
    /// 是无害的，删掉反而是多改了用户的文件。
    #[serde(default, skip_serializing_if = "is_false")]
    pub gateway_table_created: bool,
}

fn backup_key(app_type: &AppType) -> String {
    format!("forwarding_live_backup_{}", app_type.as_str())
}

/// 读备份。解析不了时当作没有备份：宁可不还原，也不要拿一份读不懂的数据去覆盖
/// 用户的 live 配置。
pub fn load_backup(
    db: &Database,
    app_type: &AppType,
) -> Result<Option<ForwardingBackup>, AppError> {
    let Some(raw) = db.get_setting(&backup_key(app_type))? else {
        return Ok(None);
    };
    match serde_json::from_str::<ForwardingBackup>(&raw) {
        Ok(backup) => Ok(Some(backup)),
        Err(err) => {
            log::warn!(
                "转发备份解析失败（{}），按未开启转发处理: {err}",
                app_type.as_str()
            );
            Ok(None)
        }
    }
}

fn store_backup(
    db: &Database,
    app_type: &AppType,
    backup: &ForwardingBackup,
) -> Result<(), AppError> {
    let raw = serde_json::to_string(backup).map_err(|e| AppError::JsonSerialize { source: e })?;
    db.set_setting(&backup_key(app_type), &raw)
}

// --- live 文件读写：只碰凭据字段 ---

/// 读 live JSON。文件不存在 → `None`（等价于「还没配过」）；文件在但解析不了
/// → 报错。后者绝不能当成空对象，否则开启转发会把一份手写坏了的配置整个替换掉。
fn read_live_json(path: &std::path::Path) -> Result<Option<Value>, AppError> {
    if !path.exists() {
        return Ok(None);
    }
    crate::config::read_json_file::<Value>(path).map(Some)
}

fn capture_claude(backup: &mut ForwardingBackup) -> Result<(), AppError> {
    let path = crate::config::get_claude_settings_path();
    let Some(live) = read_live_json(&path)? else {
        return Ok(());
    };
    backup.token = live
        .pointer("/env/ANTHROPIC_AUTH_TOKEN")
        .and_then(Value::as_str)
        .map(str::to_string);
    backup.base_url = live
        .pointer("/env/ANTHROPIC_BASE_URL")
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(())
}

fn apply_claude(token: &str, base_url: &str) -> Result<(), AppError> {
    let path = crate::config::get_claude_settings_path();
    let mut live = read_live_json(&path)?.unwrap_or_else(|| json!({}));
    if !live.is_object() {
        live = json!({});
    }
    let obj = live.as_object_mut().expect("live is an object");
    let env = obj.entry("env").or_insert_with(|| json!({}));
    if !env.is_object() {
        *env = json!({});
    }
    let env_obj = env.as_object_mut().expect("env is an object");
    env_obj.insert(
        CLAUDE_TOKEN_KEY.to_string(),
        Value::String(token.to_string()),
    );
    env_obj.insert(
        CLAUDE_BASE_URL_KEY.to_string(),
        Value::String(base_url.to_string()),
    );
    crate::config::write_json_file(&path, &live)
}

fn restore_claude(backup: &ForwardingBackup) -> Result<(), AppError> {
    let path = crate::config::get_claude_settings_path();
    // live 已经不在了就没什么可还原的——别拿备份把文件重建出来。
    let Some(mut live) = read_live_json(&path)? else {
        return Ok(());
    };
    let Some(obj) = live.as_object_mut() else {
        return Ok(());
    };
    let Some(env) = obj.get_mut("env").and_then(Value::as_object_mut) else {
        return Ok(());
    };

    for (key, value) in [
        (CLAUDE_TOKEN_KEY, &backup.token),
        (CLAUDE_BASE_URL_KEY, &backup.base_url),
    ] {
        match value {
            Some(v) => {
                env.insert(key.to_string(), Value::String(v.clone()));
            }
            None => {
                env.remove(key);
            }
        }
    }

    // env 被清空就整个去掉，别留一个空壳 "env": {}。
    if env.is_empty() {
        obj.remove("env");
    }
    crate::config::write_json_file(&path, &live)
}

fn read_codex_doc() -> Result<Option<DocumentMut>, AppError> {
    let path = crate::codex_config::get_codex_config_path();
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| AppError::io(&path, e))?;
    text.parse::<DocumentMut>()
        .map(Some)
        .map_err(|e| AppError::Message(format!("解析 {} 失败: {e}", path.display())))
}

fn write_codex_doc(doc: &DocumentMut) -> Result<(), AppError> {
    let path = crate::codex_config::get_codex_config_path();
    let text = doc.to_string();
    if text.trim().is_empty() {
        // 只剩空文件就删掉——我们不该留下一个原本不存在的 config.toml。
        if path.exists() {
            crate::config::delete_file(&path)?;
        }
        return Ok(());
    }
    crate::config::write_text_file(&path, &text)
}

fn capture_codex(backup: &mut ForwardingBackup) -> Result<(), AppError> {
    let auth_path = crate::codex_config::get_codex_auth_path();
    if let Some(auth) = read_live_json(&auth_path)? {
        backup.token = auth
            .get(CODEX_TOKEN_KEY)
            .and_then(Value::as_str)
            .map(str::to_string);
    }

    if let Some(doc) = read_codex_doc()? {
        backup.model_provider = doc
            .get("model_provider")
            .and_then(|item| item.as_str())
            .map(str::to_string);
        backup.gateway_table_created = doc
            .get("model_providers")
            .and_then(|item| item.as_table())
            .map(|table| !table.contains_key(CODEX_GATEWAY_KEY))
            .unwrap_or(true);
    } else {
        backup.gateway_table_created = true;
    }
    Ok(())
}

/// Codex 的「endpoint」是结构性的：哪个 model_provider 生效、它的 base_url 指向
/// 哪里。所以覆盖 = 把 `model_provider` 指到网关那张表，并保证那张表描述的是网关
/// 地址。`model`、`model_reasoning_effort` 这些不是 endpoint，一律不碰。
fn apply_codex(token: &str, base_url: &str) -> Result<(), AppError> {
    let auth_path = crate::codex_config::get_codex_auth_path();
    let mut auth = read_live_json(&auth_path)?.unwrap_or_else(|| json!({}));
    if !auth.is_object() {
        auth = json!({});
    }
    auth.as_object_mut().expect("auth is an object").insert(
        CODEX_TOKEN_KEY.to_string(),
        Value::String(token.to_string()),
    );
    crate::config::write_json_file(&auth_path, &auth)?;

    let mut doc = read_codex_doc()?.unwrap_or_default();
    point_codex_doc_at_gateway(&mut doc, base_url)?;
    write_codex_doc(&doc)
}

/// 把一份 config.toml 的 `model_provider` 指到网关那张表，并保证那张表描述的是
/// 网关地址。只动这两处，其余（`model`、注释、用户自己的 provider 表）不碰。
fn point_codex_doc_at_gateway(doc: &mut DocumentMut, base_url: &str) -> Result<(), AppError> {
    doc["model_provider"] = toml_edit::value(CODEX_GATEWAY_KEY);
    if doc.get("model_providers").is_none() {
        doc["model_providers"] = toml_edit::table();
    }
    let providers = doc["model_providers"]
        .as_table_mut()
        .ok_or_else(|| AppError::Message("config.toml 的 model_providers 不是表".to_string()))?;
    if !providers.contains_key(CODEX_GATEWAY_KEY) {
        providers[CODEX_GATEWAY_KEY] = toml_edit::table();
    }
    let gateway = providers[CODEX_GATEWAY_KEY]
        .as_table_mut()
        .ok_or_else(|| AppError::Message("config.toml 的网关 provider 不是表".to_string()))?;
    gateway["name"] = toml_edit::value(CODEX_GATEWAY_KEY);
    gateway["base_url"] = toml_edit::value(format!("{}/v1", base_url.trim_end_matches('/')));
    gateway["wire_api"] = toml_edit::value("responses");
    gateway["requires_openai_auth"] = toml_edit::value(true);
    Ok(())
}

fn restore_codex(backup: &ForwardingBackup) -> Result<(), AppError> {
    let auth_path = crate::codex_config::get_codex_auth_path();
    if let Some(mut auth) = read_live_json(&auth_path)? {
        if let Some(obj) = auth.as_object_mut() {
            match &backup.token {
                Some(token) => {
                    obj.insert(CODEX_TOKEN_KEY.to_string(), Value::String(token.clone()));
                }
                None => {
                    obj.remove(CODEX_TOKEN_KEY);
                }
            }
            if obj.is_empty() {
                crate::config::delete_file(&auth_path)?;
            } else {
                crate::config::write_json_file(&auth_path, &auth)?;
            }
        }
    }

    let Some(mut doc) = read_codex_doc()? else {
        return Ok(());
    };
    match &backup.model_provider {
        Some(key) => doc["model_provider"] = toml_edit::value(key.as_str()),
        None => {
            doc.as_table_mut().remove("model_provider");
        }
    }
    if backup.gateway_table_created {
        if let Some(providers) = doc
            .get_mut("model_providers")
            .and_then(|item| item.as_table_mut())
        {
            providers.remove(CODEX_GATEWAY_KEY);
            if providers.is_empty() {
                doc.as_table_mut().remove("model_providers");
            }
        }
    }
    write_codex_doc(&doc)
}

fn capture_live(app_type: &AppType, backup: &mut ForwardingBackup) -> Result<(), AppError> {
    match app_type {
        AppType::Claude => capture_claude(backup),
        AppType::Codex => capture_codex(backup),
        AppType::Gemini => Ok(()),
    }
}

fn apply_live(app_type: &AppType, token: &str, base_url: &str) -> Result<(), AppError> {
    match app_type {
        AppType::Claude => apply_claude(token, base_url),
        AppType::Codex => apply_codex(token, base_url),
        AppType::Gemini => Ok(()),
    }
}

fn restore_live(app_type: &AppType, backup: &ForwardingBackup) -> Result<(), AppError> {
    match app_type {
        AppType::Claude => restore_claude(backup),
        AppType::Codex => restore_codex(backup),
        AppType::Gemini => Ok(()),
    }
}

// --- 从 provider 条目里取出「这次要覆盖的凭据」 ---

/// 网关条目里的 token / base_url。返回 `None` 表示这个条目不长得像网关条目，
/// 不该走字段级覆盖。
fn credentials_from_provider(app_type: &AppType, provider: &Provider) -> Option<(String, String)> {
    match app_type {
        AppType::Claude => {
            let token = provider
                .settings_config
                .pointer("/env/ANTHROPIC_AUTH_TOKEN")?
                .as_str()?;
            let base_url = provider
                .settings_config
                .pointer("/env/ANTHROPIC_BASE_URL")?
                .as_str()?;
            Some((token.to_string(), base_url.to_string()))
        }
        AppType::Codex => {
            let token = provider
                .settings_config
                .pointer("/auth/OPENAI_API_KEY")?
                .as_str()?;
            // base_url 埋在 config 那段 TOML 文本里；解析出来还原成不带 /v1 的
            // 形式，apply_codex 会自己再拼回去。
            let config_text = provider.settings_config.get("config")?.as_str()?;
            let doc = config_text.parse::<DocumentMut>().ok()?;
            let raw = doc
                .get("model_providers")?
                .as_table()?
                .get(CODEX_GATEWAY_KEY)?
                .as_table()?
                .get("base_url")?
                .as_str()?;
            let base_url = raw.trim_end_matches('/').trim_end_matches("/v1");
            Some((token.to_string(), base_url.to_string()))
        }
        AppType::Gemini => None,
    }
}

/// 这次 live 写入该钉上去的网关凭据。
///
/// 优先取备份里记下的网关值：它是 `start_forwarding` / 刷新时写进去的，与用户
/// 在编辑页里把 endpoint、key 改成了什么无关。旧备份没有这两个字段，回退到从
/// provider 条目现读，行为与加字段之前一致。
fn gateway_credentials(
    app_type: &AppType,
    backup: &ForwardingBackup,
    provider: &Provider,
) -> Option<(String, String)> {
    if let (Some(token), Some(base_url)) = (&backup.gateway_token, &backup.gateway_base_url) {
        return Some((token.clone(), base_url.clone()));
    }
    credentials_from_provider(app_type, provider)
}

/// 拦截器给调用方的指示。
pub(crate) enum LiveWriteDecision {
    /// 转发没开、或写的不是转发那个条目。调用方按原有逻辑整文件写。
    Proceed,
    /// 已经按字段级覆盖完了，调用方**不要**再写。
    Handled,
    /// 照常整文件写，但先把这份配置里的凭据钉成网关的值。
    ProceedWithPinnedCredentials { token: String, base_url: String },
}

/// 挂在 `write_live_with_common_config` 上的拦截器。
///
/// 转发期间「钉住 endpoint + key，放行其余」是这里的核心契约，但放行到什么程度
/// 取决于是谁发起的写入：
///
/// - `UserSave`（编辑页保存）：整文件写，只把两个凭据键钉成网关的值。编辑页的
///   初值本来就是从 live 读的，所以整份写回 = 「live + 用户改动」，新增和删除
///   字段都能生效。用户把凭据改成别的值则静默钉回去。
/// - `BackgroundSync`（切换、启动同步、改通用配置片段）：只覆盖凭据字段。这些
///   写入的内容来自数据库快照，整份写会把用户绕过 app 手改的 live 内容抹掉。
pub(crate) fn intercept_live_write(
    db: &Database,
    app_type: &AppType,
    provider: &Provider,
    intent: LiveWriteIntent,
) -> Result<LiveWriteDecision, AppError> {
    let Some(backup) = load_backup(db, app_type)? else {
        return Ok(LiveWriteDecision::Proceed);
    };
    if backup.provider_id.as_deref() != Some(provider.id.as_str()) {
        return Ok(LiveWriteDecision::Proceed);
    }
    let Some((token, base_url)) = gateway_credentials(app_type, &backup, provider) else {
        return Ok(LiveWriteDecision::Proceed);
    };
    match intent {
        LiveWriteIntent::UserSave => {
            Ok(LiveWriteDecision::ProceedWithPinnedCredentials { token, base_url })
        }
        LiveWriteIntent::BackgroundSync => {
            apply_live(app_type, &token, &base_url)?;
            Ok(LiveWriteDecision::Handled)
        }
    }
}

/// 把网关凭据钉进一份即将整文件写出去的配置。
///
/// Claude 是 `env` 下的两个键；Codex 是 auth.json 的 key 加上 config.toml 里
/// `model_provider` 的指向与网关那张表。Gemini 不支持转发，走不到这里。
pub(crate) fn pin_gateway_credentials(
    app_type: &AppType,
    settings: &mut Value,
    token: &str,
    base_url: &str,
) -> Result<(), AppError> {
    match app_type {
        AppType::Claude => {
            if !settings.is_object() {
                *settings = json!({});
            }
            let obj = settings.as_object_mut().expect("settings is an object");
            let env = obj.entry("env").or_insert_with(|| json!({}));
            if !env.is_object() {
                *env = json!({});
            }
            let env_obj = env.as_object_mut().expect("env is an object");
            env_obj.insert(
                CLAUDE_TOKEN_KEY.to_string(),
                Value::String(token.to_string()),
            );
            env_obj.insert(
                CLAUDE_BASE_URL_KEY.to_string(),
                Value::String(base_url.to_string()),
            );
            Ok(())
        }
        AppType::Codex => {
            if !settings.is_object() {
                *settings = json!({});
            }
            let obj = settings.as_object_mut().expect("settings is an object");

            let auth = obj.entry("auth").or_insert_with(|| json!({}));
            if !auth.is_object() {
                *auth = json!({});
            }
            auth.as_object_mut().expect("auth is an object").insert(
                CODEX_TOKEN_KEY.to_string(),
                Value::String(token.to_string()),
            );

            let config_text = obj.get("config").and_then(Value::as_str).unwrap_or("");
            let mut doc = if config_text.trim().is_empty() {
                DocumentMut::new()
            } else {
                config_text.parse::<DocumentMut>().map_err(|e| {
                    AppError::Message(format!("解析待写入的 Codex config.toml 失败: {e}"))
                })?
            };
            point_codex_doc_at_gateway(&mut doc, base_url)?;
            obj.insert("config".to_string(), Value::String(doc.to_string()));
            Ok(())
        }
        AppType::Gemini => Ok(()),
    }
}

/// 丢弃备份而不还原 live。
///
/// 用户在转发期间手动切到别的供应商时用这个：endpoint 已经由那次切换自己写好
/// 了，再「还原」一遍只会把转发前的陈旧凭据盖上去。
pub(crate) fn discard_backup(db: &Database, app_type: &AppType) -> Result<(), AppError> {
    db.delete_setting(&backup_key(app_type))
}

/// 转发是否正开着。
pub fn is_forwarding(db: &Database, app_type: &AppType) -> Result<bool, AppError> {
    Ok(load_backup(db, app_type)?.is_some())
}

/// 开启转发：备份 live 现有的 endpoint/key，再只覆盖这两个字段。
///
/// 重复调用是幂等的：备份已存在就不再采集，只把最新 token 覆盖上去。这一点很
/// 重要——token 刷新会重新走这条路，如果每次都重采备份，备份就会被网关自己的值
/// 污染，结束转发时「还原」出来的就是网关地址。
pub fn start_forwarding(
    state: &AppState,
    app_type: &AppType,
    provider: &Provider,
    token: &str,
    base_url: &str,
) -> Result<(), AppError> {
    if matches!(app_type, AppType::Gemini) {
        return Ok(());
    }

    // 转发前的旧凭据只在首次采集；网关凭据每次都要刷新——token 轮换会重走这条路。
    let mut backup = match load_backup(state.db.as_ref(), app_type)? {
        Some(backup) => backup,
        None => {
            let previous_provider_id =
                crate::settings::get_effective_current_provider(&state.db, app_type)?
                    .filter(|id| id != &provider.id);
            let mut backup = ForwardingBackup {
                provider_id: Some(provider.id.clone()),
                previous_provider_id,
                ..Default::default()
            };
            capture_live(app_type, &mut backup)?;
            backup
        }
    };
    backup.gateway_token = Some(token.to_string());
    backup.gateway_base_url = Some(base_url.to_string());
    store_backup(state.db.as_ref(), app_type, &backup)?;

    // 条目要存在且被标记为当前，供应商列表才会显示「已启用」。备份此时已经写好，
    // 所以这两步之后任何 live 写入都会被 intercept_live_write 降级成字段级。
    state.db.save_provider(app_type.as_str(), provider)?;
    crate::settings::set_current_provider(app_type, Some(&provider.id))?;
    state
        .db
        .set_current_provider(app_type.as_str(), &provider.id)?;

    apply_live(app_type, token, base_url)
}

/// token 轮换：只把新凭据覆盖到 live，别的一个字节都不碰。
///
/// 刷新不能走 `ProviderService::update`。前端造的网关条目是「只有凭据的最小
/// 配置」，而 update 在转发期间是整文件写（`LiveWriteIntent::UserSave`），拿那份
/// 最小配置整份写出去等于把用户的 live 削成只剩两个键。
///
/// 转发没开就什么都不做：没有覆盖层可言，凭据该由正常的供应商流程去写。
pub fn refresh_credentials(
    state: &AppState,
    app_type: &AppType,
    token: &str,
    base_url: &str,
) -> Result<(), AppError> {
    let Some(mut backup) = load_backup(state.db.as_ref(), app_type)? else {
        return Ok(());
    };
    backup.gateway_token = Some(token.to_string());
    backup.gateway_base_url = Some(base_url.to_string());
    store_backup(state.db.as_ref(), app_type, &backup)?;

    apply_live(app_type, token, base_url)
}

/// 结束转发：只把 endpoint/key 还原，转发期间的其它修改一律保留。
pub fn stop_forwarding(state: &AppState, app_type: &AppType) -> Result<(), AppError> {
    let Some(backup) = load_backup(state.db.as_ref(), app_type)? else {
        // 没有备份说明没经过 start_forwarding，什么都不该动。
        return Ok(());
    };

    restore_live(app_type, &backup)?;

    // 「当前供应商」指回转发前那个条目。live 上面已经还原过了，这里只改指针，
    // 不再触发写盘——再写一次就又是整文件覆盖，正好是要避免的那件事。
    let restore_to = backup.previous_provider_id.filter(|id| {
        matches!(
            state.db.get_provider_by_id(id, app_type.as_str()),
            Ok(Some(_))
        )
    });
    match restore_to {
        Some(id) => {
            crate::settings::set_current_provider(app_type, Some(&id))?;
            state.db.set_current_provider(app_type.as_str(), &id)?;
        }
        None => crate::settings::set_current_provider(app_type, None)?,
    }

    discard_backup(state.db.as_ref(), app_type)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use std::sync::Arc;

    fn with_test_home<T>(test: impl FnOnce(&AppState) -> T) -> T {
        let temp = tempfile::tempdir().expect("tempdir");
        let old_test_home = std::env::var_os("CC_SWITCH_TEST_HOME");
        let old_home = std::env::var_os("HOME");
        std::env::set_var("CC_SWITCH_TEST_HOME", temp.path());
        std::env::set_var("HOME", temp.path());

        let db = Arc::new(Database::memory().expect("in-memory database"));
        let state = AppState::new(db);
        let result = test(&state);

        match old_test_home {
            Some(value) => std::env::set_var("CC_SWITCH_TEST_HOME", value),
            None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
        }
        match old_home {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        result
    }

    fn gateway_provider(token: &str, base_url: &str) -> Provider {
        Provider {
            id: "llm-gateway-local".to_string(),
            name: "LLM Gateway".to_string(),
            settings_config: json!({
                "env": {
                    CLAUDE_TOKEN_KEY: token,
                    CLAUDE_BASE_URL_KEY: base_url,
                }
            }),
            website_url: Some(base_url.to_string()),
            category: Some("custom".to_string()),
            created_at: Some(1),
            sort_index: Some(0),
            notes: None,
            meta: None,
            icon: None,
            icon_color: None,
            in_failover_queue: false,
        }
    }

    fn write_live(value: Value) {
        let path = crate::config::get_claude_settings_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create live dir");
        }
        crate::config::write_json_file(&path, &value).expect("write live");
    }

    fn read_live() -> Value {
        crate::config::read_json_file::<Value>(&crate::config::get_claude_settings_path())
            .expect("read live")
    }

    fn edit_live(mutate: impl FnOnce(&mut Value)) {
        let mut live = read_live();
        mutate(&mut live);
        crate::config::write_json_file(&crate::config::get_claude_settings_path(), &live)
            .expect("user edit");
    }

    /// Codex 版的网关条目：auth.json 的 key + config.toml 里指向网关那张表。
    fn codex_gateway_provider(token: &str, base_url: &str) -> Provider {
        let mut provider = gateway_provider(token, base_url);
        provider.settings_config = json!({
            "auth": { CODEX_TOKEN_KEY: token },
            "config": format!(
                "model_provider = \"llm_gateway\"\n\n[model_providers.llm_gateway]\nbase_url = \"{}/v1\"\n",
                base_url.trim_end_matches('/')
            ),
        });
        provider
    }

    fn read_codex_text() -> String {
        std::fs::read_to_string(crate::codex_config::get_codex_config_path())
            .expect("read codex config")
    }

    /// 核心契约：转发只动 endpoint 和 key，用户在转发期间的修改必须活下来。
    #[test]
    #[serial]
    fn forwarding_preserves_user_edits_and_restores_only_credentials() {
        with_test_home(|state| {
            write_live(json!({
                "env": {
                    CLAUDE_TOKEN_KEY: "sk-original",
                    CLAUDE_BASE_URL_KEY: "https://api.anthropic.com",
                },
                "model": "opus",
            }));

            let provider = gateway_provider("gw-token", "https://api.fwai.space");
            start_forwarding(
                state,
                &AppType::Claude,
                &provider,
                "gw-token",
                "https://api.fwai.space",
            )
            .expect("start forwarding");

            let during = read_live();
            assert_eq!(
                during.pointer("/env/ANTHROPIC_BASE_URL"),
                Some(&json!("https://api.fwai.space"))
            );
            assert_eq!(
                during.pointer("/env/ANTHROPIC_AUTH_TOKEN"),
                Some(&json!("gw-token"))
            );
            assert_eq!(
                during.pointer("/model"),
                Some(&json!("opus")),
                "开启转发不该动其它字段"
            );

            // 用户在转发期间改了 model，加了 MCP，还加了一个 env 变量。
            edit_live(|live| {
                live["model"] = json!("fable");
                live["mcpServers"] = json!({ "fs": { "command": "srv" } });
                live["env"]["CLAUDE_CODE_EFFORT_LEVEL"] = json!("max");
            });

            stop_forwarding(state, &AppType::Claude).expect("stop forwarding");

            let after = read_live();
            // 凭据还原……
            assert_eq!(
                after.pointer("/env/ANTHROPIC_AUTH_TOKEN"),
                Some(&json!("sk-original"))
            );
            assert_eq!(
                after.pointer("/env/ANTHROPIC_BASE_URL"),
                Some(&json!("https://api.anthropic.com"))
            );
            // ……用户转发期间的修改一个都不能少。
            assert_eq!(after.pointer("/model"), Some(&json!("fable")));
            assert_eq!(after.pointer("/mcpServers/fs/command"), Some(&json!("srv")));
            assert_eq!(
                after.pointer("/env/CLAUDE_CODE_EFFORT_LEVEL"),
                Some(&json!("max"))
            );
        });
    }

    /// 转发前本来就没有凭据：结束转发要删掉，而不是留着网关的值。
    #[test]
    #[serial]
    fn stop_removes_credentials_that_did_not_exist_before() {
        with_test_home(|state| {
            write_live(json!({ "model": "opus" }));
            let provider = gateway_provider("gw-token", "https://api.fwai.space");

            start_forwarding(
                state,
                &AppType::Claude,
                &provider,
                "gw-token",
                "https://api.fwai.space",
            )
            .expect("start forwarding");
            assert_eq!(
                read_live().pointer("/env/ANTHROPIC_BASE_URL"),
                Some(&json!("https://api.fwai.space"))
            );

            stop_forwarding(state, &AppType::Claude).expect("stop forwarding");

            let after = read_live();
            assert_eq!(after.pointer("/env/ANTHROPIC_AUTH_TOKEN"), None);
            assert_eq!(after.pointer("/env/ANTHROPIC_BASE_URL"), None);
            // env 里没别的了就整个去掉，不留空壳。
            assert_eq!(after.get("env"), None);
            assert_eq!(after.pointer("/model"), Some(&json!("opus")));
        });
    }

    /// 重复开启（token 刷新会走到这里）不能把备份污染成网关自己的值。
    #[test]
    #[serial]
    fn repeated_start_keeps_the_original_backup() {
        with_test_home(|state| {
            write_live(json!({
                "env": {
                    CLAUDE_TOKEN_KEY: "sk-original",
                    CLAUDE_BASE_URL_KEY: "https://api.anthropic.com",
                }
            }));
            let provider = gateway_provider("gw-token-1", "https://api.fwai.space");
            start_forwarding(
                state,
                &AppType::Claude,
                &provider,
                "gw-token-1",
                "https://api.fwai.space",
            )
            .expect("first start");

            let refreshed = gateway_provider("gw-token-2", "https://api.fwai.space");
            start_forwarding(
                state,
                &AppType::Claude,
                &refreshed,
                "gw-token-2",
                "https://api.fwai.space",
            )
            .expect("second start");
            assert_eq!(
                read_live().pointer("/env/ANTHROPIC_AUTH_TOKEN"),
                Some(&json!("gw-token-2")),
                "重复开启要把最新 token 覆盖上去"
            );

            stop_forwarding(state, &AppType::Claude).expect("stop forwarding");

            assert_eq!(
                read_live().pointer("/env/ANTHROPIC_AUTH_TOKEN"),
                Some(&json!("sk-original")),
                "还原的必须是最初的原始 token，不能是网关的"
            );
        });
    }

    /// 没备份就什么都不动：结束转发不该在没开启过的情况下改 live。
    #[test]
    #[serial]
    fn stop_without_backup_is_a_noop() {
        with_test_home(|state| {
            let original = json!({
                "env": { CLAUDE_TOKEN_KEY: "sk-untouched" },
                "model": "opus",
            });
            write_live(original.clone());

            stop_forwarding(state, &AppType::Claude).expect("stop without backup");

            assert_eq!(read_live(), original);
        });
    }

    /// live 文件坏掉时开启转发必须报错，绝不能当成空对象把它替换掉。
    #[test]
    #[serial]
    fn start_refuses_to_clobber_unparseable_live_config() {
        with_test_home(|state| {
            let path = crate::config::get_claude_settings_path();
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("create live dir");
            }
            std::fs::write(&path, b"{ not json").expect("write broken live");

            let provider = gateway_provider("gw-token", "https://api.fwai.space");
            let result = start_forwarding(
                state,
                &AppType::Claude,
                &provider,
                "gw-token",
                "https://api.fwai.space",
            );

            assert!(result.is_err(), "解析失败时开启转发应当报错");
            assert_eq!(
                std::fs::read_to_string(&path).expect("live still there"),
                "{ not json",
                "报错时不能动用户的文件"
            );
        });
    }

    /// 后台同步（切换、启动同步、改通用配置片段）在转发期间必须降级成字段级，
    /// 否则数据库里的快照会把用户绕过 app 手改的 live 内容整份盖掉。
    #[test]
    #[serial]
    fn intercept_downgrades_background_sync_to_field_level() {
        with_test_home(|state| {
            write_live(json!({
                "env": {
                    CLAUDE_TOKEN_KEY: "sk-original",
                    CLAUDE_BASE_URL_KEY: "https://api.anthropic.com",
                },
                "model": "opus",
            }));

            let provider = gateway_provider("gw-token", "https://api.fwai.space");
            start_forwarding(
                state,
                &AppType::Claude,
                &provider,
                "gw-token",
                "https://api.fwai.space",
            )
            .expect("start forwarding");
            // 用户绕过 app 直接手改 live。
            edit_live(|live| live["model"] = json!("fable"));

            let decision = intercept_live_write(
                state.db.as_ref(),
                &AppType::Claude,
                &provider,
                LiveWriteIntent::BackgroundSync,
            )
            .expect("intercept live write");

            assert!(
                matches!(decision, LiveWriteDecision::Handled),
                "后台同步在转发期间应当被拦下来做字段级覆盖"
            );
            let live = read_live();
            assert_eq!(
                live.pointer("/env/ANTHROPIC_AUTH_TOKEN"),
                Some(&json!("gw-token"))
            );
            assert_eq!(
                live.pointer("/model"),
                Some(&json!("fable")),
                "拦截后的写入不该动用户手改的字段"
            );
        });
    }

    /// 用户在编辑页点保存：放行整文件写，但凭据钉成网关的值。
    /// 这样新增/删除的字段才能真正落盘。
    #[test]
    #[serial]
    fn intercept_lets_user_save_through_with_pinned_credentials() {
        with_test_home(|state| {
            write_live(json!({ "env": { CLAUDE_TOKEN_KEY: "sk-original" } }));
            let provider = gateway_provider("gw-token", "https://api.fwai.space");
            start_forwarding(
                state,
                &AppType::Claude,
                &provider,
                "gw-token",
                "https://api.fwai.space",
            )
            .expect("start forwarding");

            // 用户在编辑页里把 endpoint 改成了自己的值，还加了个新字段。
            let mut edited = gateway_provider("sk-user-typed", "https://evil.example");
            edited.settings_config["env"]["ANTHROPIC_BASE_URL2"] = json!("https://extra.example");

            let decision = intercept_live_write(
                state.db.as_ref(),
                &AppType::Claude,
                &edited,
                LiveWriteIntent::UserSave,
            )
            .expect("intercept live write");

            let LiveWriteDecision::ProceedWithPinnedCredentials { token, base_url } = decision
            else {
                panic!("用户保存应当放行整文件写");
            };
            assert_eq!(token, "gw-token", "凭据应当来自备份，而不是用户改的值");
            assert_eq!(base_url, "https://api.fwai.space");

            // 钉进去之后：用户新增的字段保留，凭据是网关的。
            let mut settings = edited.settings_config.clone();
            pin_gateway_credentials(&AppType::Claude, &mut settings, &token, &base_url)
                .expect("pin credentials");
            assert_eq!(
                settings.pointer("/env/ANTHROPIC_BASE_URL2"),
                Some(&json!("https://extra.example")),
                "用户新增的字段必须活下来"
            );
            assert_eq!(
                settings.pointer("/env/ANTHROPIC_BASE_URL"),
                Some(&json!("https://api.fwai.space")),
                "用户改掉的 endpoint 必须被钉回网关的值"
            );
            assert_eq!(
                settings.pointer("/env/ANTHROPIC_AUTH_TOKEN"),
                Some(&json!("gw-token"))
            );
        });
    }

    /// 写的不是转发那个条目时不拦截——用户切到别的供应商仍然走原有语义。
    #[test]
    #[serial]
    fn intercept_ignores_other_providers() {
        with_test_home(|state| {
            write_live(json!({ "env": { CLAUDE_TOKEN_KEY: "sk-original" } }));
            let provider = gateway_provider("gw-token", "https://api.fwai.space");
            start_forwarding(
                state,
                &AppType::Claude,
                &provider,
                "gw-token",
                "https://api.fwai.space",
            )
            .expect("start forwarding");

            let mut other = gateway_provider("sk-other", "https://api.anthropic.com");
            other.id = "some-other-provider".to_string();
            for intent in [LiveWriteIntent::UserSave, LiveWriteIntent::BackgroundSync] {
                let decision =
                    intercept_live_write(state.db.as_ref(), &AppType::Claude, &other, intent)
                        .expect("intercept");
                assert!(
                    matches!(decision, LiveWriteDecision::Proceed),
                    "别的供应商不该被拦截"
                );
            }
        });
    }

    /// 结束转发要把「当前供应商」指回转发前那个条目，UI 才不会显示成没启用。
    #[test]
    #[serial]
    fn stop_restores_previous_current_provider() {
        with_test_home(|state| {
            write_live(json!({ "env": { CLAUDE_TOKEN_KEY: "sk-original" } }));
            let mut mine = gateway_provider("sk-original", "https://api.anthropic.com");
            mine.id = "my-own-provider".to_string();
            state
                .db
                .save_provider(AppType::Claude.as_str(), &mine)
                .expect("save own provider");
            crate::settings::set_current_provider(&AppType::Claude, Some(&mine.id))
                .expect("set current");

            let provider = gateway_provider("gw-token", "https://api.fwai.space");
            start_forwarding(
                state,
                &AppType::Claude,
                &provider,
                "gw-token",
                "https://api.fwai.space",
            )
            .expect("start forwarding");
            assert_eq!(
                crate::settings::get_current_provider(&AppType::Claude).as_deref(),
                Some("llm-gateway-local")
            );

            stop_forwarding(state, &AppType::Claude).expect("stop forwarding");

            assert_eq!(
                crate::settings::get_current_provider(&AppType::Claude).as_deref(),
                Some("my-own-provider"),
                "结束转发应当指回转发前的供应商"
            );
        });
    }

    /// 转发期间用户手动切到别的供应商 = 他自己接管了 endpoint。备份必须作废，
    /// 否则之后点「结束转发」会把转发前那份陈旧凭据盖到他刚选的供应商上。
    #[test]
    #[serial]
    fn switching_away_during_forwarding_discards_the_backup() {
        with_test_home(|state| {
            write_live(json!({
                "env": {
                    CLAUDE_TOKEN_KEY: "sk-original",
                    CLAUDE_BASE_URL_KEY: "https://api.anthropic.com",
                }
            }));

            let mut other = gateway_provider("sk-other", "https://other.example.com");
            other.id = "some-other-provider".to_string();
            state
                .db
                .save_provider(AppType::Claude.as_str(), &other)
                .expect("save other provider");

            let provider = gateway_provider("gw-token", "https://api.fwai.space");
            start_forwarding(
                state,
                &AppType::Claude,
                &provider,
                "gw-token",
                "https://api.fwai.space",
            )
            .expect("start forwarding");

            crate::services::ProviderService::switch(state, AppType::Claude, &other.id)
                .expect("switch away");

            assert!(
                !is_forwarding(state.db.as_ref(), &AppType::Claude).expect("is_forwarding"),
                "切走之后转发就该算结束了"
            );
            // 切换本身已经把 other 的配置写好；结束转发不该再动它。
            let before_stop = read_live();
            stop_forwarding(state, &AppType::Claude).expect("stop forwarding");
            assert_eq!(
                read_live(),
                before_stop,
                "备份已作废，结束转发不该把陈旧凭据盖回去"
            );
            assert_eq!(
                read_live().pointer("/env/ANTHROPIC_AUTH_TOKEN"),
                Some(&json!("sk-other")),
                "用户刚选的供应商必须保持生效"
            );
        });
    }

    /// 登出时若转发还开着，删条目之前必须先把原配置还回去——否则备份跟着
    /// 条目一起没了，用户原来的 endpoint 就永远回不来了。
    #[test]
    #[serial]
    fn removing_the_forwarding_provider_restores_config_first() {
        with_test_home(|state| {
            write_live(json!({
                "env": {
                    CLAUDE_TOKEN_KEY: "sk-original",
                    CLAUDE_BASE_URL_KEY: "https://api.anthropic.com",
                },
                "model": "opus",
            }));

            let provider = gateway_provider("gw-token", "https://api.fwai.space");
            start_forwarding(
                state,
                &AppType::Claude,
                &provider,
                "gw-token",
                "https://api.fwai.space",
            )
            .expect("start forwarding");

            // 前端漏了 stopForwarding，直接走登出清理。
            crate::services::ProviderService::remove_managed_provider(
                state,
                AppType::Claude,
                &provider.id,
            )
            .expect("remove managed provider");

            let after = read_live();
            assert_eq!(
                after.pointer("/env/ANTHROPIC_AUTH_TOKEN"),
                Some(&json!("sk-original")),
                "登出前应当先把转发覆盖还原掉"
            );
            assert_eq!(
                after.pointer("/env/ANTHROPIC_BASE_URL"),
                Some(&json!("https://api.anthropic.com"))
            );
            assert_eq!(after.pointer("/model"), Some(&json!("opus")));
            assert!(
                !is_forwarding(state.db.as_ref(), &AppType::Claude).expect("is_forwarding"),
                "备份应当已经清掉"
            );
        });
    }

    /// Codex：只改 model_provider 指向和网关那张表，model / 其它 provider 表
    /// 以及注释都要原样保留。
    #[test]
    #[serial]
    fn codex_forwarding_preserves_unrelated_config() {
        with_test_home(|state| {
            let config_path = crate::codex_config::get_codex_config_path();
            std::fs::create_dir_all(config_path.parent().expect("parent"))
                .expect("create codex dir");
            std::fs::write(
                &config_path,
                r#"# 我自己的配置
model = "gpt-5.4"
model_provider = "my_provider"

[model_providers.my_provider]
name = "my_provider"
base_url = "https://my.example.com/v1"
wire_api = "responses"
"#,
            )
            .expect("write codex config");
            crate::config::write_json_file(
                &crate::codex_config::get_codex_auth_path(),
                &json!({ CODEX_TOKEN_KEY: "sk-mine" }),
            )
            .expect("write codex auth");

            let mut provider = gateway_provider("gw-token", "https://api.fwai.space");
            provider.settings_config = json!({
                "auth": { CODEX_TOKEN_KEY: "gw-token" },
                "config": "model_provider = \"llm_gateway\"\n\n[model_providers.llm_gateway]\nbase_url = \"https://api.fwai.space/v1\"\n",
            });

            start_forwarding(
                state,
                &AppType::Codex,
                &provider,
                "gw-token",
                "https://api.fwai.space",
            )
            .expect("start codex forwarding");

            let during = read_codex_text();
            assert!(during.contains(r#"model_provider = "llm_gateway""#));
            assert!(during.contains(r#"base_url = "https://api.fwai.space/v1""#));
            assert!(during.contains("# 我自己的配置"), "注释必须保留");
            assert!(during.contains(r#"model = "gpt-5.4""#), "model 不该被动");
            assert!(
                during.contains("[model_providers.my_provider]"),
                "用户自己的 provider 表必须保留"
            );

            stop_forwarding(state, &AppType::Codex).expect("stop codex forwarding");

            let after = read_codex_text();
            assert!(
                after.contains(r#"model_provider = "my_provider""#),
                "结束转发要指回原来的 model_provider"
            );
            assert!(
                !after.contains("[model_providers.llm_gateway]"),
                "我们建的网关表要删掉"
            );
            assert!(after.contains("# 我自己的配置"));
            assert!(after.contains("[model_providers.my_provider]"));
            let auth =
                crate::config::read_json_file::<Value>(&crate::codex_config::get_codex_auth_path())
                    .expect("read codex auth");
            assert_eq!(auth.get(CODEX_TOKEN_KEY), Some(&json!("sk-mine")));
        });
    }

    // --- 端到端：走 ProviderService::update，也就是编辑页保存那条真实路径 ---

    /// 本次 bug 的直接复现：转发开启时在编辑页新增一个字段并保存，必须落盘。
    #[test]
    #[serial]
    fn user_save_during_forwarding_persists_new_fields() {
        with_test_home(|state| {
            write_live(json!({ "env": { CLAUDE_TOKEN_KEY: "sk-original" } }));
            let provider = gateway_provider("gw-token", "https://api.fwai.space");
            start_forwarding(
                state,
                &AppType::Claude,
                &provider,
                "gw-token",
                "https://api.fwai.space",
            )
            .expect("start forwarding");

            // 编辑页的初值来自 live，用户在其上加了一个新键。
            let mut edited = gateway_provider("gw-token", "https://api.fwai.space");
            edited.settings_config["env"]["ANTHROPIC_BASE_URL2"] = json!("https://api.fwai.space");

            crate::services::ProviderService::update(
                state,
                AppType::Claude,
                Some("llm-gateway-local"),
                edited,
            )
            .expect("update provider");

            let live = read_live();
            assert_eq!(
                live.pointer("/env/ANTHROPIC_BASE_URL2"),
                Some(&json!("https://api.fwai.space")),
                "编辑页新增的字段必须落盘"
            );
            assert_eq!(
                live.pointer("/env/ANTHROPIC_AUTH_TOKEN"),
                Some(&json!("gw-token")),
                "凭据仍应是网关的"
            );
            assert_eq!(
                live.pointer("/env/ANTHROPIC_BASE_URL"),
                Some(&json!("https://api.fwai.space"))
            );
        });
    }

    /// 整文件写才有的能力：编辑页删掉一个字段，live 里也要消失。
    #[test]
    #[serial]
    fn user_save_during_forwarding_can_delete_fields() {
        with_test_home(|state| {
            write_live(json!({ "env": { CLAUDE_TOKEN_KEY: "sk-original" } }));
            let mut provider = gateway_provider("gw-token", "https://api.fwai.space");
            provider.settings_config["model"] = json!("opus");
            start_forwarding(
                state,
                &AppType::Claude,
                &provider,
                "gw-token",
                "https://api.fwai.space",
            )
            .expect("start forwarding");

            // 用户在编辑页把 model 删了。
            let edited = gateway_provider("gw-token", "https://api.fwai.space");
            crate::services::ProviderService::update(
                state,
                AppType::Claude,
                Some("llm-gateway-local"),
                edited,
            )
            .expect("update provider");

            assert!(
                read_live().pointer("/model").is_none(),
                "编辑页删掉的字段应当从 live 消失"
            );
        });
    }

    /// 用户改掉凭据本身：其余改动照常落盘，但凭据被静默钉回网关的值。
    #[test]
    #[serial]
    fn user_cannot_kick_themselves_out_of_forwarding() {
        with_test_home(|state| {
            write_live(json!({ "env": { CLAUDE_TOKEN_KEY: "sk-original" } }));
            let provider = gateway_provider("gw-token", "https://api.fwai.space");
            start_forwarding(
                state,
                &AppType::Claude,
                &provider,
                "gw-token",
                "https://api.fwai.space",
            )
            .expect("start forwarding");

            // 用户把 endpoint 和 key 都改成自己的，同时加了个无关字段。
            let mut edited = gateway_provider("sk-user-typed", "https://evil.example");
            edited.settings_config["model"] = json!("fable");
            crate::services::ProviderService::update(
                state,
                AppType::Claude,
                Some("llm-gateway-local"),
                edited,
            )
            .expect("update provider");

            let live = read_live();
            assert_eq!(
                live.pointer("/env/ANTHROPIC_BASE_URL"),
                Some(&json!("https://api.fwai.space")),
                "endpoint 必须钉回网关"
            );
            assert_eq!(
                live.pointer("/env/ANTHROPIC_AUTH_TOKEN"),
                Some(&json!("gw-token")),
                "key 必须钉回网关"
            );
            assert_eq!(
                live.pointer("/model"),
                Some(&json!("fable")),
                "无关字段照常落盘"
            );
        });
    }

    /// 后台同步（改通用配置片段那条路）不能把用户绕过 app 手改的 live 抹掉。
    #[test]
    #[serial]
    fn background_sync_during_forwarding_keeps_manual_live_edits() {
        with_test_home(|state| {
            write_live(json!({ "env": { CLAUDE_TOKEN_KEY: "sk-original" } }));
            let provider = gateway_provider("gw-token", "https://api.fwai.space");
            start_forwarding(
                state,
                &AppType::Claude,
                &provider,
                "gw-token",
                "https://api.fwai.space",
            )
            .expect("start forwarding");

            // 用户直接编辑 ~/.claude/settings.json，没经过 app。
            edit_live(|live| live["mcpServers"] = json!({ "fs": { "command": "srv" } }));

            crate::services::ProviderService::sync_current_provider_for_app(state, AppType::Claude)
                .expect("background sync");

            assert_eq!(
                read_live().pointer("/mcpServers/fs/command"),
                Some(&json!("srv")),
                "后台同步不该抹掉用户手改的 live 内容"
            );
        });
    }

    /// token 刷新的窄路径：只换凭据，其余字节不动。
    #[test]
    #[serial]
    fn refresh_credentials_only_touches_credentials() {
        with_test_home(|state| {
            write_live(json!({ "env": { CLAUDE_TOKEN_KEY: "sk-original" } }));
            let provider = gateway_provider("gw-token", "https://api.fwai.space");
            start_forwarding(
                state,
                &AppType::Claude,
                &provider,
                "gw-token",
                "https://api.fwai.space",
            )
            .expect("start forwarding");
            edit_live(|live| live["model"] = json!("fable"));

            refresh_credentials(
                state,
                &AppType::Claude,
                "gw-token-2",
                "https://api.fwai.space",
            )
            .expect("refresh credentials");

            let live = read_live();
            assert_eq!(
                live.pointer("/env/ANTHROPIC_AUTH_TOKEN"),
                Some(&json!("gw-token-2")),
                "新 token 要写进去"
            );
            assert_eq!(
                live.pointer("/model"),
                Some(&json!("fable")),
                "刷新不该动用户的字段"
            );

            // 刷新后的 token 也要成为后续写入钉住的值。
            let backup = load_backup(state.db.as_ref(), &AppType::Claude)
                .expect("load backup")
                .expect("backup exists");
            assert_eq!(backup.gateway_token.as_deref(), Some("gw-token-2"));
            assert_eq!(
                backup.token.as_deref(),
                Some("sk-original"),
                "转发前的旧凭据不能被刷新污染"
            );
        });
    }

    /// 转发没开时刷新是 no-op，不该凭空造出配置。
    #[test]
    #[serial]
    fn refresh_credentials_without_forwarding_is_a_noop() {
        with_test_home(|state| {
            write_live(json!({ "env": { CLAUDE_TOKEN_KEY: "sk-original" } }));
            refresh_credentials(
                state,
                &AppType::Claude,
                "gw-token",
                "https://api.fwai.space",
            )
            .expect("refresh without forwarding");
            assert_eq!(
                read_live().pointer("/env/ANTHROPIC_AUTH_TOKEN"),
                Some(&json!("sk-original"))
            );
        });
    }

    /// 旧备份没有 gateway_* 字段时回退到从条目现读，行为与加字段之前一致。
    #[test]
    #[serial]
    fn legacy_backup_without_gateway_fields_falls_back_to_provider() {
        with_test_home(|state| {
            write_live(json!({ "env": { CLAUDE_TOKEN_KEY: "sk-original" } }));
            let provider = gateway_provider("gw-token", "https://api.fwai.space");
            start_forwarding(
                state,
                &AppType::Claude,
                &provider,
                "gw-token",
                "https://api.fwai.space",
            )
            .expect("start forwarding");

            // 把备份改回旧格式（没有 gateway_token / gateway_base_url）。
            let mut backup = load_backup(state.db.as_ref(), &AppType::Claude)
                .expect("load")
                .expect("exists");
            backup.gateway_token = None;
            backup.gateway_base_url = None;
            store_backup(state.db.as_ref(), &AppType::Claude, &backup)
                .expect("store legacy backup");

            let decision = intercept_live_write(
                state.db.as_ref(),
                &AppType::Claude,
                &provider,
                LiveWriteIntent::UserSave,
            )
            .expect("intercept");
            let LiveWriteDecision::ProceedWithPinnedCredentials { token, .. } = decision else {
                panic!("应当放行整文件写");
            };
            assert_eq!(token, "gw-token", "旧备份应回退到从条目读凭据");
        });
    }

    /// Codex：转发期间编辑页保存，新增字段落盘且网关表被钉住。
    #[test]
    #[serial]
    fn codex_user_save_during_forwarding_pins_gateway_table() {
        with_test_home(|state| {
            let auth_path = crate::codex_config::get_codex_auth_path();
            if let Some(parent) = auth_path.parent() {
                std::fs::create_dir_all(parent).expect("create codex dir");
            }
            crate::config::write_json_file(&auth_path, &json!({ CODEX_TOKEN_KEY: "sk-mine" }))
                .expect("seed auth");
            crate::config::write_text_file(
                &crate::codex_config::get_codex_config_path(),
                "model_provider = \"my_provider\"\n\n[model_providers.my_provider]\nname = \"mine\"\nbase_url = \"https://mine.example/v1\"\n",
            )
            .expect("seed config");

            let provider = codex_gateway_provider("gw-token", "https://api.fwai.space");
            start_forwarding(
                state,
                &AppType::Codex,
                &provider,
                "gw-token",
                "https://api.fwai.space",
            )
            .expect("start codex forwarding");

            // 用户在编辑页把 model 改了，还把 model_provider 指回自己那张表。
            let mut edited = codex_gateway_provider("sk-user-typed", "https://evil.example");
            edited.settings_config["config"] = json!(
                "model = \"gpt-5.4-codex\"\nmodel_provider = \"my_provider\"\n\n[model_providers.my_provider]\nname = \"mine\"\nbase_url = \"https://mine.example/v1\"\n"
            );
            crate::services::ProviderService::update(
                state,
                AppType::Codex,
                Some("llm-gateway-local"),
                edited,
            )
            .expect("update codex provider");

            let after = read_codex_text();
            assert!(
                after.contains("model = \"gpt-5.4-codex\""),
                "用户改的 model 必须落盘，实际: {after}"
            );
            assert!(
                after.contains(r#"model_provider = "llm_gateway""#),
                "model_provider 必须钉回网关，实际: {after}"
            );
            assert!(
                after.contains("[model_providers.llm_gateway]"),
                "网关表必须在，实际: {after}"
            );
            assert!(
                after.contains("https://api.fwai.space/v1"),
                "网关 base_url 必须是我们的，实际: {after}"
            );
            let auth = crate::config::read_json_file::<Value>(&auth_path).expect("read auth");
            assert_eq!(
                auth.get(CODEX_TOKEN_KEY),
                Some(&json!("gw-token")),
                "Codex key 必须钉回网关"
            );
        });
    }
}
