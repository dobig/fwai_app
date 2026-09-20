//! Provider service module
//!
//! Handles provider CRUD operations, switching, and configuration management.

mod endpoints;
pub mod forwarding;
mod gemini_auth;
mod live;

use indexmap::IndexMap;
use regex::Regex;
use serde::Deserialize;
use serde_json::Value;

use crate::app_config::AppType;
use crate::error::AppError;
use crate::provider::{Provider, UsageResult};
use crate::settings::CustomEndpoint;
use crate::store::AppState;

// Re-export sub-module functions for external access
pub use live::{
    import_default_config, read_live_settings, should_import_default_config_on_startup,
    sync_current_to_live,
};

// Internal re-exports (pub(crate))
pub(crate) use live::sanitize_claude_settings_for_live;
pub(crate) use live::{
    build_effective_settings_with_common_config, normalize_provider_common_config_for_storage,
    provider_exists_in_live_config, strip_common_config_from_live_settings,
    sync_current_provider_for_app_to_live, write_live_with_common_config, LiveWriteIntent,
};

// Internal re-exports

/// Provider business logic service
pub struct ProviderService;

/// Result of a provider switch operation, including any non-fatal warnings
#[derive(Debug, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SwitchResult {
    pub warnings: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{get_claude_settings_path, read_json_file, write_json_file};
    use crate::database::Database;
    use crate::provider::ProviderMeta;
    use crate::store::AppState;
    use serde_json::json;
    use serial_test::serial;
    use std::env;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex, OnceLock};
    use tempfile::TempDir;

    struct TempHome {
        #[allow(dead_code)]
        dir: TempDir,
        original_home: Option<String>,
        original_userprofile: Option<String>,
        original_test_home: Option<String>,
    }

    impl TempHome {
        fn new() -> Self {
            let dir = TempDir::new().expect("failed to create temp home");
            let original_home = env::var("HOME").ok();
            let original_userprofile = env::var("USERPROFILE").ok();
            let original_test_home = env::var("CC_SWITCH_TEST_HOME").ok();

            env::set_var("HOME", dir.path());
            env::set_var("USERPROFILE", dir.path());
            env::set_var("CC_SWITCH_TEST_HOME", dir.path());

            Self {
                dir,
                original_home,
                original_userprofile,
                original_test_home,
            }
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            match &self.original_home {
                Some(value) => env::set_var("HOME", value),
                None => env::remove_var("HOME"),
            }

            match &self.original_userprofile {
                Some(value) => env::set_var("USERPROFILE", value),
                None => env::remove_var("USERPROFILE"),
            }

            match &self.original_test_home {
                Some(value) => env::set_var("CC_SWITCH_TEST_HOME", value),
                None => env::remove_var("CC_SWITCH_TEST_HOME"),
            }
        }
    }

    fn test_guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|err| err.into_inner())
    }

    fn with_test_home<T>(test: impl FnOnce(&AppState, &Path) -> T) -> T {
        let _guard = test_guard();
        let temp = tempfile::tempdir().expect("tempdir");
        let old_test_home = std::env::var_os("CC_SWITCH_TEST_HOME");
        let old_home = std::env::var_os("HOME");
        std::env::set_var("CC_SWITCH_TEST_HOME", temp.path());
        std::env::set_var("HOME", temp.path());

        let db = Arc::new(Database::memory().expect("in-memory database"));
        let state = AppState::new(db);
        let result = test(&state, temp.path());

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

    fn claude_env_provider(id: &str, name: &str, api_key: &str, base_url: &str) -> Provider {
        Provider {
            id: id.to_string(),
            name: name.to_string(),
            settings_config: json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": api_key,
                    "ANTHROPIC_BASE_URL": base_url
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

    fn claude_gateway_provider(id: &str) -> Provider {
        claude_env_provider(
            id,
            "LLM Gateway Local",
            "sk-old-user-token",
            "http://127.0.0.1:8080",
        )
    }

    #[test]
    fn validate_provider_settings_rejects_missing_auth() {
        let provider = Provider::with_id(
            "codex".into(),
            "Codex".into(),
            json!({ "config": "base_url = \"https://example.com\"" }),
            None,
        );
        let err = ProviderService::validate_provider_settings(&AppType::Codex, &provider)
            .expect_err("missing auth should be rejected");
        assert!(
            err.to_string().contains("auth"),
            "expected auth error, got {err:?}"
        );
    }

    #[test]
    #[serial]
    fn remove_managed_current_claude_provider_clears_gateway_live_config() {
        with_test_home(|state, _home| {
            let provider = claude_gateway_provider("llm-gateway-local");
            ProviderService::add(state, AppType::Claude, provider.clone(), true)
                .expect("add gateway provider");
            ProviderService::switch(state, AppType::Claude, &provider.id)
                .expect("switch to gateway provider");

            let live_before: Value =
                read_json_file(&get_claude_settings_path()).expect("read live settings");
            assert_eq!(
                live_before.pointer("/env/ANTHROPIC_AUTH_TOKEN"),
                Some(&json!("sk-old-user-token"))
            );

            ProviderService::remove_managed_provider(state, AppType::Claude, &provider.id)
                .expect("remove managed gateway provider");

            assert!(
                state
                    .db
                    .get_provider_by_id(&provider.id, AppType::Claude.as_str())
                    .expect("query provider")
                    .is_none(),
                "gateway provider should be deleted from db"
            );
            assert_eq!(
                crate::settings::get_current_provider(&AppType::Claude),
                None
            );

            let live_after: Value =
                read_json_file(&get_claude_settings_path()).unwrap_or_else(|_| json!({}));
            assert_eq!(live_after.pointer("/env/ANTHROPIC_AUTH_TOKEN"), None);
            assert_eq!(live_after.pointer("/env/ANTHROPIC_BASE_URL"), None);
        });
    }

    /// 即使存在 `default` 快照，移除托管供应商也只撤销它自己写进去的字段，
    /// 不把 `default` 的内容整体写回 live。
    ///
    /// 这条曾经是反过来的：以前会 switch 到 `default`，于是登出把一份陈旧快照
    /// 覆盖到磁盘上，用户后来手动加的设置被一并抹掉。这里用一个只存在于 live、
    /// `default` 里没有的键（CLAUDE_CODE_EFFORT_LEVEL）把那个回归钉住。
    #[test]
    #[serial]
    fn remove_managed_current_claude_provider_keeps_user_live_settings() {
        with_test_home(|state, _home| {
            let default_provider = claude_env_provider(
                "default",
                "default",
                "sk-default-token",
                "https://api.anthropic.com",
            );
            ProviderService::add(state, AppType::Claude, default_provider.clone(), true)
                .expect("add default provider");

            let gateway_provider = claude_gateway_provider("llm-gateway-local");
            ProviderService::add(state, AppType::Claude, gateway_provider.clone(), true)
                .expect("add gateway provider");
            ProviderService::switch(state, AppType::Claude, &gateway_provider.id)
                .expect("switch to gateway provider");

            // 用户在 live 里手动加的设置，`default` 快照里没有。
            let path = get_claude_settings_path();
            let mut live: Value = read_json_file(&path).expect("read live settings");
            live["env"]["CLAUDE_CODE_EFFORT_LEVEL"] = json!("max");
            live["theme"] = json!("dark");
            crate::config::write_json_file(&path, &live).expect("write live settings");

            ProviderService::remove_managed_provider(state, AppType::Claude, &gateway_provider.id)
                .expect("remove managed gateway provider");

            // 登出后不再有当前供应商：托管条目已删，也不该顶替成 default。
            assert_eq!(
                crate::settings::get_current_provider(&AppType::Claude),
                None
            );
            assert!(
                state
                    .db
                    .get_provider_by_id(&gateway_provider.id, AppType::Claude.as_str())
                    .expect("query gateway provider")
                    .is_none(),
                "gateway provider should be deleted from db"
            );

            let live_after: Value =
                read_json_file(&get_claude_settings_path()).expect("read live settings");
            // 托管凭据被撤销……
            assert_eq!(live_after.pointer("/env/ANTHROPIC_AUTH_TOKEN"), None);
            assert_eq!(live_after.pointer("/env/ANTHROPIC_BASE_URL"), None);
            // ……但用户自己的设置原样保留（这正是回归点）。
            assert_eq!(
                live_after.pointer("/env/CLAUDE_CODE_EFFORT_LEVEL"),
                Some(&json!("max"))
            );
            assert_eq!(live_after.pointer("/theme"), Some(&json!("dark")));
        });
    }

    /// 「开启转发」在 gateway 不是当前供应商时走的路径：先 update 写入最新
    /// token，再 switch 过去，live 配置必须真的带上网关地址。
    ///
    /// 前端此前只在 gateway 已是当前供应商时才 update，否则静默跳过。登出会把
    /// 当前供应商清掉，于是重新登录后点「开启转发」对 claude 什么都不写，
    /// live 里没有 ANTHROPIC_BASE_URL——转发是断的，提示却说已更新。
    #[test]
    #[serial]
    fn switching_to_gateway_provider_writes_live_config() {
        with_test_home(|state, _home| {
            let default_provider = claude_env_provider(
                "default",
                "default",
                "sk-default-token",
                "https://api.anthropic.com",
            );
            ProviderService::add(state, AppType::Claude, default_provider, true)
                .expect("add default provider");

            let gateway_provider = claude_gateway_provider("llm-gateway-local");
            ProviderService::add(state, AppType::Claude, gateway_provider.clone(), true)
                .expect("add gateway provider");

            // 前提：gateway 存在但不是当前供应商——正是登出重登后的状态。
            assert_ne!(
                ProviderService::current(state, AppType::Claude).expect("current"),
                gateway_provider.id
            );

            // update 此时不落盘（条目不是当前），随后的 switch 才写 live。
            ProviderService::update(
                state,
                AppType::Claude,
                None,
                claude_env_provider(
                    &gateway_provider.id,
                    "LLM Gateway Local",
                    "sk-fresh-token",
                    "https://api.fwai.space",
                ),
            )
            .expect("update gateway provider");
            ProviderService::switch(state, AppType::Claude, &gateway_provider.id)
                .expect("switch to gateway provider");

            let live: Value =
                read_json_file(&get_claude_settings_path()).expect("read live settings");
            assert_eq!(
                live.pointer("/env/ANTHROPIC_BASE_URL"),
                Some(&json!("https://api.fwai.space")),
                "转发开启后 live 配置必须指向网关"
            );
            assert_eq!(
                live.pointer("/env/ANTHROPIC_AUTH_TOKEN"),
                Some(&json!("sk-fresh-token")),
                "写进 live 的必须是 update 传入的最新 token"
            );
        });
    }

    #[test]
    fn extract_credentials_returns_expected_values() {
        let provider = Provider::with_id(
            "claude".into(),
            "Claude".into(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "token",
                    "ANTHROPIC_BASE_URL": "https://claude.example"
                }
            }),
            None,
        );
        let (api_key, base_url) =
            ProviderService::extract_credentials(&provider, &AppType::Claude).unwrap();
        assert_eq!(api_key, "token");
        assert_eq!(base_url, "https://claude.example");
    }

    #[test]
    fn extract_codex_common_config_preserves_mcp_servers_base_url() {
        let config_toml = r#"model_provider = "azure"
model = "gpt-4"
disable_response_storage = true

[model_providers.azure]
name = "Azure OpenAI"
base_url = "https://azure.example/v1"
wire_api = "responses"

[mcp_servers.my_server]
base_url = "http://localhost:8080"
"#;

        let settings = json!({ "config": config_toml });
        let extracted = ProviderService::extract_codex_common_config(&settings)
            .expect("extract_codex_common_config should succeed");

        assert!(
            !extracted
                .lines()
                .any(|line| line.trim_start().starts_with("model_provider")),
            "should remove top-level model_provider"
        );
        assert!(
            !extracted
                .lines()
                .any(|line| line.trim_start().starts_with("model =")),
            "should remove top-level model"
        );
        assert!(
            !extracted.contains("[model_providers"),
            "should remove entire model_providers table"
        );
        assert!(
            extracted.contains("http://localhost:8080"),
            "should keep mcp_servers.* base_url"
        );
    }

    /// Fable 档和子代理模型是供应商专属的映射，和 haiku/sonnet/opus 一样
    /// 不能进共享的通用配置片段，否则会把一家的模型名带到别家去。
    #[test]
    fn extract_claude_common_config_strips_fable_and_subagent_model_keys() {
        let settings = json!({
            "env": {
                "ANTHROPIC_DEFAULT_OPUS_MODEL": "opus-mapped[1M]",
                "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "Opus Mapped",
                "ANTHROPIC_DEFAULT_FABLE_MODEL": "claude-fable-5-1[1M]",
                "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME": "Fable 5.1",
                "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-5",
                "ANTHROPIC_MODEL": "default-mapped",
                "ENABLE_TOOL_SEARCH": "true"
            },
            "theme": "dark"
        });

        let snippet = ProviderService::extract_claude_common_config(&settings)
            .expect("extract should succeed");
        let value: Value = serde_json::from_str(&snippet).expect("snippet is valid JSON");
        let env = value.get("env");

        for stripped in [
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
            "ANTHROPIC_DEFAULT_FABLE_MODEL",
            "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
            "CLAUDE_CODE_SUBAGENT_MODEL",
            "ANTHROPIC_MODEL",
        ] {
            assert!(
                env.and_then(|e| e.get(stripped)).is_none(),
                "provider-specific model key {stripped} must not enter common config"
            );
        }
        assert_eq!(
            env.and_then(|e| e.get("ENABLE_TOOL_SEARCH"))
                .and_then(|v| v.as_str()),
            Some("true")
        );
        assert_eq!(value.get("theme").and_then(|v| v.as_str()), Some("dark"));
    }

    #[test]
    #[serial]
    fn remove_managed_codex_provider_clears_gateway_live_config() {
        with_test_home(|state, _home| {
            let config_text = "model_provider = \"llm_gateway\"\nmodel = \"gpt-5.4\"\n\n[model_providers.llm_gateway]\nname = \"llm_gateway\"\nbase_url = \"http://127.0.0.1:8080/v1\"\nwire_api = \"responses\"\n";
            let provider = Provider {
                id: "llm-gateway-local".to_string(),
                name: "LLM Gateway".to_string(),
                settings_config: json!({
                    "auth": { "OPENAI_API_KEY": "sk-gw-codex-token" },
                    "config": config_text,
                }),
                website_url: None,
                category: Some("custom".to_string()),
                created_at: Some(1),
                sort_index: Some(0),
                notes: None,
                meta: None,
                icon: None,
                icon_color: None,
                in_failover_queue: false,
            };
            ProviderService::add(state, AppType::Codex, provider.clone(), true)
                .expect("add codex gateway provider");
            ProviderService::switch(state, AppType::Codex, &provider.id)
                .expect("switch to codex gateway provider");

            let auth_path = crate::codex_config::get_codex_auth_path();
            let live_auth: Value = read_json_file(&auth_path).expect("read live auth.json");
            assert_eq!(
                live_auth.get("OPENAI_API_KEY").and_then(Value::as_str),
                Some("sk-gw-codex-token")
            );

            ProviderService::remove_managed_provider(state, AppType::Codex, &provider.id)
                .expect("remove managed codex provider");

            assert!(
                state
                    .db
                    .get_provider_by_id(&provider.id, AppType::Codex.as_str())
                    .expect("query provider")
                    .is_none(),
                "codex gateway provider should be deleted from db"
            );
            assert!(
                !auth_path.exists()
                    || read_json_file::<Value>(&auth_path)
                        .map(|v| v.get("OPENAI_API_KEY").is_none())
                        .unwrap_or(true),
                "managed codex credentials should be cleared from live auth.json"
            );
        });
    }
}

impl ProviderService {
    fn normalize_provider_if_claude(app_type: &AppType, provider: &mut Provider) {
        if matches!(app_type, AppType::Claude) {
            let mut v = provider.settings_config.clone();
            if normalize_claude_models_in_value(&mut v) {
                provider.settings_config = v;
            }
        }
    }

    /// Check whether a provider exists in live config, tolerating parse errors
    /// only for providers that are explicitly marked as DB-only.
    fn check_live_config_exists(
        app_type: &AppType,
        provider_id: &str,
        live_config_managed: Option<bool>,
    ) -> Result<bool, AppError> {
        if live_config_managed == Some(false) {
            Ok(provider_exists_in_live_config(app_type, provider_id).unwrap_or(false))
        } else {
            provider_exists_in_live_config(app_type, provider_id)
        }
    }

    fn provider_live_config_managed(provider: &Provider) -> Option<bool> {
        provider
            .meta
            .as_ref()
            .and_then(|meta| meta.live_config_managed)
    }

    fn set_provider_live_config_managed(provider: &mut Provider, managed: bool) {
        provider
            .meta
            .get_or_insert_with(Default::default)
            .live_config_managed = Some(managed);
    }

    /// List all providers for an app type
    pub fn list(
        state: &AppState,
        app_type: AppType,
    ) -> Result<IndexMap<String, Provider>, AppError> {
        state.db.get_all_providers(app_type.as_str())
    }

    /// Get current provider ID
    ///
    /// 使用有效的当前供应商 ID（验证过存在性）。
    /// 优先从本地 settings 读取，验证后 fallback 到数据库的 is_current 字段。
    /// 这确保了云同步场景下多设备可以独立选择供应商，且返回的 ID 一定有效。
    ///
    /// 对于累加模式应用（OpenCode, OpenClaw），不存在"当前供应商"概念，直接返回空字符串。
    pub fn current(state: &AppState, app_type: AppType) -> Result<String, AppError> {
        // Additive mode apps have no "current" provider concept
        if app_type.is_additive_mode() {
            return Ok(String::new());
        }
        crate::settings::get_effective_current_provider(&state.db, &app_type)
            .map(|opt| opt.unwrap_or_default())
    }

    /// Add a new provider
    pub fn add(
        state: &AppState,
        app_type: AppType,
        provider: Provider,
        add_to_live: bool,
    ) -> Result<bool, AppError> {
        let mut provider = provider;
        // Normalize Claude model keys
        Self::normalize_provider_if_claude(&app_type, &mut provider);
        Self::validate_provider_settings(&app_type, &provider)?;
        normalize_provider_common_config_for_storage(state.db.as_ref(), &app_type, &mut provider)?;
        let _ = add_to_live;

        // Save to database
        state.db.save_provider(app_type.as_str(), &provider)?;

        // Check if sync is needed (if this is current provider, or no current provider)
        let current = state.db.get_current_provider(app_type.as_str())?;
        if current.is_none() {
            // No current provider, set as current and sync
            state
                .db
                .set_current_provider(app_type.as_str(), &provider.id)?;
            write_live_with_common_config(
                state.db.as_ref(),
                &app_type,
                &provider,
                LiveWriteIntent::BackgroundSync,
            )?;
        }

        Ok(true)
    }

    /// Update a provider
    pub fn update(
        state: &AppState,
        app_type: AppType,
        original_id: Option<&str>,
        provider: Provider,
    ) -> Result<bool, AppError> {
        let mut provider = provider;
        let original_id = original_id.unwrap_or(provider.id.as_str()).to_string();
        let provider_id_changed = original_id != provider.id;
        let existing_provider = state
            .db
            .get_provider_by_id(&original_id, app_type.as_str())?;
        // Normalize Claude model keys
        Self::normalize_provider_if_claude(&app_type, &mut provider);
        Self::validate_provider_settings(&app_type, &provider)?;
        normalize_provider_common_config_for_storage(state.db.as_ref(), &app_type, &mut provider)?;

        if provider_id_changed {
            return Err(AppError::Message(
                "Changing the provider key is not supported".to_string(),
            ));
        }
        let _ = existing_provider;

        // Save to database
        state.db.save_provider(app_type.as_str(), &provider)?;

        // For other apps: Check if this is current provider (use effective current, not just DB)
        let effective_current =
            crate::settings::get_effective_current_provider(&state.db, &app_type)?;
        let is_current = effective_current.as_deref() == Some(provider.id.as_str());

        if is_current {
            // 用户在编辑页点的保存：转发期间也要整文件写，否则新增/删除的字段
            // 永远到不了磁盘（凭据仍会被钉成网关的值）。
            write_live_with_common_config(
                state.db.as_ref(),
                &app_type,
                &provider,
                LiveWriteIntent::UserSave,
            )?;
        }

        Ok(true)
    }

    /// Delete a provider
    ///
    /// 同时检查本地 settings 和数据库的当前供应商，防止删除任一端正在使用的供应商。
    /// 对于累加模式应用（OpenCode, OpenClaw），可以随时删除任意供应商，同时从 live 配置中移除。
    pub fn delete(state: &AppState, app_type: AppType, id: &str) -> Result<(), AppError> {
        let local_current = crate::settings::get_current_provider(&app_type);
        let db_current = state.db.get_current_provider(app_type.as_str())?;

        if local_current.as_deref() == Some(id) || db_current.as_deref() == Some(id) {
            return Err(AppError::Message(
                "无法删除当前正在使用的供应商".to_string(),
            ));
        }

        state.db.delete_provider(app_type.as_str(), id)
    }

    /// Remove an app-managed provider even when it is current.
    ///
    /// This is intentionally stricter than normal delete: for Claude live config it only removes
    /// fields whose current values still match the provider being removed.
    pub fn remove_managed_provider(
        state: &AppState,
        app_type: AppType,
        id: &str,
    ) -> Result<(), AppError> {
        // 这个条目正压着一份转发覆盖的话，先把转发前的 endpoint + key 还回去。
        // 不这么做，备份会随着条目一起消失，用户原来的配置就永远回不来了——
        // 前端目前确实是先 stopForwarding 再走这里，但「登出后配置能复原」不该
        // 依赖调用方的顺序。
        if forwarding::load_backup(state.db.as_ref(), &app_type)?
            .and_then(|backup| backup.provider_id)
            .as_deref()
            == Some(id)
        {
            forwarding::stop_forwarding(state, &app_type)?;
        }

        let provider = state.db.get_provider_by_id(id, app_type.as_str())?;
        let local_current = crate::settings::get_current_provider(&app_type);
        let db_current = state.db.get_current_provider(app_type.as_str())?;
        let was_current = local_current.as_deref() == Some(id) || db_current.as_deref() == Some(id);

        if was_current {
            // 只撤销我们自己托管的字段，不整体覆盖 live 配置。
            //
            // 这里原本会 switch 到 `default`，而 `default` 是很久以前一次
            // import 的快照——切过去等于把那份陈旧配置整体写回磁盘，把用户
            // 后来手动加的设置（ANTHROPIC_MODEL、CLAUDE_CODE_EFFORT_LEVEL、
            // theme…）连同托管字段一起抹掉。登出只应该带走凭据。
            if let Some(provider) = provider.as_ref() {
                Self::clear_managed_live_config_if_matches(&app_type, provider)?;
            }
            crate::settings::set_current_provider(&app_type, None)?;
        }

        state.db.delete_provider(app_type.as_str(), id)
    }

    fn clear_managed_live_config_if_matches(
        app_type: &AppType,
        provider: &Provider,
    ) -> Result<(), AppError> {
        match app_type {
            AppType::Claude => {}
            AppType::Codex => return Self::clear_managed_codex_live_config_if_matches(provider),
            _ => return Ok(()),
        }

        let Some(expected_env) = provider
            .settings_config
            .get("env")
            .and_then(Value::as_object)
        else {
            return Ok(());
        };

        let managed_keys = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];
        let expected: Vec<_> = managed_keys
            .iter()
            .filter_map(|key| expected_env.get(*key).map(|value| (*key, value)))
            .collect();
        if expected.is_empty() {
            return Ok(());
        }

        let path = crate::config::get_claude_settings_path();
        if !path.exists() {
            return Ok(());
        }

        let mut live: Value = crate::config::read_json_file(&path)?;
        let Some(live_env) = live.get_mut("env").and_then(Value::as_object_mut) else {
            return Ok(());
        };

        if !expected.iter().all(|(key, value)| {
            live_env
                .get(*key)
                .is_some_and(|live_value| live_value == *value)
        }) {
            return Ok(());
        }

        for (key, _) in expected {
            live_env.remove(key);
        }

        let remove_env = live
            .get("env")
            .and_then(Value::as_object)
            .is_some_and(|env| env.is_empty());
        if remove_env {
            if let Some(obj) = live.as_object_mut() {
                obj.remove("env");
            }
        }

        if live.as_object().is_some_and(|obj| obj.is_empty()) {
            crate::config::delete_file(&path)?;
        } else {
            crate::config::write_json_file(&path, &live)?;
        }

        Ok(())
    }

    /// Remove provider from live config only (for additive mode apps like OpenCode, OpenClaw)
    ///
    /// Does NOT delete from database - provider remains in the list.
    /// This is used when user wants to "remove" a provider from active config
    /// but keep it available for future use.
    /// Codex counterpart: only strips the live credentials when they still
    /// match the managed provider being removed, so a hand-edited auth.json
    /// is never clobbered. The config.toml is deleted only on an exact match
    /// (it then contains nothing but what we wrote).
    fn clear_managed_codex_live_config_if_matches(provider: &Provider) -> Result<(), AppError> {
        let Some(expected_key) = provider
            .settings_config
            .get("auth")
            .and_then(|auth| auth.get("OPENAI_API_KEY"))
            .and_then(Value::as_str)
        else {
            return Ok(());
        };

        let auth_path = crate::codex_config::get_codex_auth_path();
        if !auth_path.exists() {
            return Ok(());
        }
        let live_auth: Value = crate::config::read_json_file(&auth_path)?;
        if live_auth.get("OPENAI_API_KEY").and_then(Value::as_str) != Some(expected_key) {
            return Ok(());
        }
        crate::config::delete_file(&auth_path)?;

        let expected_config = provider
            .settings_config
            .get("config")
            .and_then(Value::as_str)
            .unwrap_or("");
        let config_path = crate::codex_config::get_codex_config_path();
        if config_path.exists() {
            let live_config =
                std::fs::read_to_string(&config_path).map_err(|e| AppError::io(&config_path, e))?;
            if live_config.trim() == expected_config.trim() {
                crate::config::delete_file(&config_path)?;
            }
        }

        Ok(())
    }

    pub fn remove_from_live_config(
        state: &AppState,
        app_type: AppType,
        id: &str,
    ) -> Result<(), AppError> {
        let _ = (state, id);
        Err(AppError::Message(format!(
            "App {} does not support remove from live config",
            app_type.as_str()
        )))
    }

    /// Switch to a provider
    ///
    /// Switch flow:
    /// 1. Validate target provider exists
    /// 2. Check if proxy takeover mode is active AND proxy server is running
    /// 3. If takeover mode active: hot-switch proxy target only (no Live config write)
    /// 4. If normal mode:
    ///    a. **Backfill mechanism**: Backfill current live config to current provider
    ///    b. Update local settings current_provider_xxx (device-level)
    ///    c. Update database is_current (as default for new devices)
    ///    d. Write target provider config to live files
    ///    e. Sync MCP configuration
    pub fn switch(state: &AppState, app_type: AppType, id: &str) -> Result<SwitchResult, AppError> {
        // Check if provider exists
        let providers = state.db.get_all_providers(app_type.as_str())?;
        let _provider = providers
            .get(id)
            .ok_or_else(|| AppError::Message(format!("供应商 {id} 不存在")))?;

        Self::switch_normal(state, app_type, id, &providers)
    }

    /// Normal switch flow (non-proxy mode)
    fn switch_normal(
        state: &AppState,
        app_type: AppType,
        id: &str,
        providers: &indexmap::IndexMap<String, Provider>,
    ) -> Result<SwitchResult, AppError> {
        let provider = providers
            .get(id)
            .ok_or_else(|| AppError::Message(format!("供应商 {id} 不存在")))?;

        // 用户在转发期间手动切到别的供应商 = 他自己接管了 endpoint，转发到此
        // 为止。备份必须就地作废：留着的话，之后点「结束转发」会把转发前那份
        // 陈旧的 token/base_url 盖到用户刚选的供应商上。
        //
        // 这里只丢弃备份，不调 stop_forwarding——下面马上要整份写入目标供应商
        // 的配置，先还原一遍纯属多写一次盘。
        if let Some(backup) = forwarding::load_backup(state.db.as_ref(), &app_type)? {
            if backup.provider_id.as_deref() != Some(id) {
                forwarding::discard_backup(state.db.as_ref(), &app_type)?;
            }
        }

        let mut result = SwitchResult::default();

        // Backfill: Backfill current live config to current provider
        // Use effective current provider (validated existence) to ensure backfill targets valid provider
        let current_id = crate::settings::get_effective_current_provider(&state.db, &app_type)?;

        if let Some(current_id) = current_id {
            if current_id != id {
                // Additive mode apps - all providers coexist in the same file,
                // no backfill needed (backfill is for exclusive mode apps like Claude/Codex/Gemini)
                if !app_type.is_additive_mode() {
                    // Only backfill when switching to a different provider
                    if let Ok(live_config) = read_live_settings(app_type.clone()) {
                        if let Some(mut current_provider) = providers.get(&current_id).cloned() {
                            current_provider.settings_config =
                                strip_common_config_from_live_settings(
                                    state.db.as_ref(),
                                    &app_type,
                                    &current_provider,
                                    live_config,
                                );
                            if let Err(e) =
                                state.db.save_provider(app_type.as_str(), &current_provider)
                            {
                                log::warn!("Backfill failed: {e}");
                                result
                                    .warnings
                                    .push(format!("backfill_failed:{current_id}"));
                            }
                        }
                    }
                }
            }
        }

        // Additive mode apps skip setting is_current (no such concept)
        if !app_type.is_additive_mode() {
            // Update local settings (device-level, takes priority)
            crate::settings::set_current_provider(&app_type, Some(id))?;

            // Update database is_current (as default for new devices)
            state.db.set_current_provider(app_type.as_str(), id)?;
        }

        // Sync to live (write_gemini_live handles security flag internally for Gemini)
        write_live_with_common_config(
            state.db.as_ref(),
            &app_type,
            provider,
            LiveWriteIntent::BackgroundSync,
        )?;

        Ok(result)
    }

    /// Sync current provider to live configuration (re-export)
    pub fn sync_current_to_live(state: &AppState) -> Result<(), AppError> {
        sync_current_to_live(state)
    }

    pub fn sync_current_provider_for_app(
        state: &AppState,
        app_type: AppType,
    ) -> Result<(), AppError> {
        if app_type.is_additive_mode() {
            return sync_current_provider_for_app_to_live(state, &app_type);
        }

        let current_id =
            match crate::settings::get_effective_current_provider(&state.db, &app_type)? {
                Some(id) => id,
                None => return Ok(()),
            };

        let providers = state.db.get_all_providers(app_type.as_str())?;
        let Some(provider) = providers.get(&current_id) else {
            return Ok(());
        };

        let _ = provider;
        sync_current_provider_for_app_to_live(state, &app_type)
    }

    pub fn migrate_legacy_common_config_usage(
        state: &AppState,
        app_type: AppType,
        legacy_snippet: &str,
    ) -> Result<(), AppError> {
        if app_type.is_additive_mode() || legacy_snippet.trim().is_empty() {
            return Ok(());
        }

        let providers = state.db.get_all_providers(app_type.as_str())?;

        for provider in providers.values() {
            if provider
                .meta
                .as_ref()
                .and_then(|meta| meta.common_config_enabled)
                .is_some()
            {
                continue;
            }

            if !live::provider_uses_common_config(&app_type, provider, Some(legacy_snippet)) {
                continue;
            }

            let mut updated_provider = provider.clone();
            updated_provider
                .meta
                .get_or_insert_with(Default::default)
                .common_config_enabled = Some(true);

            match live::remove_common_config_from_settings(
                &app_type,
                &updated_provider.settings_config,
                legacy_snippet,
            ) {
                Ok(settings) => updated_provider.settings_config = settings,
                Err(err) => {
                    log::warn!(
                        "Failed to normalize legacy common config for {} provider '{}': {err}",
                        app_type.as_str(),
                        updated_provider.id
                    );
                }
            }

            state
                .db
                .save_provider(app_type.as_str(), &updated_provider)?;
        }

        Ok(())
    }

    pub fn migrate_legacy_common_config_usage_if_needed(
        state: &AppState,
        app_type: AppType,
    ) -> Result<(), AppError> {
        if app_type.is_additive_mode() {
            return Ok(());
        }

        let Some(snippet) = state.db.get_config_snippet(app_type.as_str())? else {
            return Ok(());
        };

        if snippet.trim().is_empty() {
            return Ok(());
        }

        Self::migrate_legacy_common_config_usage(state, app_type, &snippet)
    }

    /// Extract common config snippet from current provider
    ///
    /// Extracts the current provider's configuration and removes provider-specific fields
    /// (API keys, model settings, endpoints) to create a reusable common config snippet.
    pub fn extract_common_config_snippet(
        state: &AppState,
        app_type: AppType,
    ) -> Result<String, AppError> {
        // Get current provider
        let current_id = Self::current(state, app_type.clone())?;
        if current_id.is_empty() {
            return Err(AppError::Message("No current provider".to_string()));
        }

        let providers = state.db.get_all_providers(app_type.as_str())?;
        let provider = providers
            .get(&current_id)
            .ok_or_else(|| AppError::Message(format!("Provider {current_id} not found")))?;

        match app_type {
            AppType::Claude => Self::extract_claude_common_config(&provider.settings_config),
            AppType::Codex => Self::extract_codex_common_config(&provider.settings_config),
            AppType::Gemini => Self::extract_gemini_common_config(&provider.settings_config),
        }
    }

    /// Extract common config snippet from a config value (e.g. editor content).
    pub fn extract_common_config_snippet_from_settings(
        app_type: AppType,
        settings_config: &Value,
    ) -> Result<String, AppError> {
        match app_type {
            AppType::Claude => Self::extract_claude_common_config(settings_config),
            AppType::Codex => Self::extract_codex_common_config(settings_config),
            AppType::Gemini => Self::extract_gemini_common_config(settings_config),
        }
    }

    /// Extract common config for Claude (JSON format)
    fn extract_claude_common_config(settings: &Value) -> Result<String, AppError> {
        let mut config = settings.clone();

        // Fields to exclude from common config
        const ENV_EXCLUDES: &[&str] = &[
            // Auth
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            // Models and Claude Code model-menu display names
            "ANTHROPIC_MODEL",
            "ANTHROPIC_REASONING_MODEL", // legacy: 已废弃，但旧配置可能残留
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
            // Fable 是第四档模型映射，与 haiku/sonnet/opus 同属供应商专属；
            // 子代理模型同理。进了通用配置片段会污染其它供应商。
            "ANTHROPIC_DEFAULT_FABLE_MODEL",
            "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
            "CLAUDE_CODE_SUBAGENT_MODEL",
            // Endpoint
            "ANTHROPIC_BASE_URL",
        ];

        const TOP_LEVEL_EXCLUDES: &[&str] = &[
            "apiBaseUrl",
            // Legacy model fields
            "primaryModel",
            "smallFastModel",
        ];

        // Remove env fields
        if let Some(env) = config.get_mut("env").and_then(|v| v.as_object_mut()) {
            for key in ENV_EXCLUDES {
                env.remove(*key);
            }
            // If env is empty after removal, remove the env object itself
            if env.is_empty() {
                config.as_object_mut().map(|obj| obj.remove("env"));
            }
        }

        // Remove top-level fields
        if let Some(obj) = config.as_object_mut() {
            for key in TOP_LEVEL_EXCLUDES {
                obj.remove(*key);
            }
        }

        // Check if result is empty
        if config.as_object().is_none_or(|obj| obj.is_empty()) {
            return Ok("{}".to_string());
        }

        serde_json::to_string_pretty(&config)
            .map_err(|e| AppError::Message(format!("Serialization failed: {e}")))
    }

    /// Extract common config for Codex (TOML format)
    fn extract_codex_common_config(settings: &Value) -> Result<String, AppError> {
        // Codex config is stored as { "auth": {...}, "config": "toml string" }
        let config_toml = settings
            .get("config")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if config_toml.is_empty() {
            return Ok(String::new());
        }

        let mut doc = config_toml
            .parse::<toml_edit::DocumentMut>()
            .map_err(|e| AppError::Message(format!("TOML parse error: {e}")))?;

        // Remove provider-specific fields.
        let root = doc.as_table_mut();
        root.remove("model");
        root.remove("model_provider");
        // Legacy/alt formats might use a top-level base_url.
        root.remove("base_url");

        // Remove entire model_providers table (provider-specific configuration)
        root.remove("model_providers");

        // Clean up multiple empty lines (keep at most one blank line).
        let mut cleaned = String::new();
        let mut blank_run = 0usize;
        for line in doc.to_string().lines() {
            if line.trim().is_empty() {
                blank_run += 1;
                if blank_run <= 1 {
                    cleaned.push('\n');
                }
                continue;
            }
            blank_run = 0;
            cleaned.push_str(line);
            cleaned.push('\n');
        }

        Ok(cleaned.trim().to_string())
    }

    /// Extract common config for Gemini (JSON format)
    ///
    /// Extracts `.env` values while excluding provider-specific credentials:
    /// - GOOGLE_GEMINI_BASE_URL
    /// - GEMINI_API_KEY
    fn extract_gemini_common_config(settings: &Value) -> Result<String, AppError> {
        let env = settings.get("env").and_then(|v| v.as_object());

        let mut snippet = serde_json::Map::new();
        if let Some(env) = env {
            for (key, value) in env {
                if key == "GOOGLE_GEMINI_BASE_URL" || key == "GEMINI_API_KEY" {
                    continue;
                }
                let Value::String(v) = value else {
                    continue;
                };
                let trimmed = v.trim();
                if !trimmed.is_empty() {
                    snippet.insert(key.to_string(), Value::String(trimmed.to_string()));
                }
            }
        }

        if snippet.is_empty() {
            return Ok("{}".to_string());
        }

        serde_json::to_string_pretty(&Value::Object(snippet))
            .map_err(|e| AppError::Message(format!("Serialization failed: {e}")))
    }

    /// Extract common config for OpenCode (JSON format)
    fn extract_opencode_common_config(settings: &Value) -> Result<String, AppError> {
        // OpenCode uses a different config structure with npm, options, models
        // For common config, we exclude provider-specific fields like apiKey
        let mut config = settings.clone();

        // Remove provider-specific fields
        if let Some(obj) = config.as_object_mut() {
            if let Some(options) = obj.get_mut("options").and_then(|v| v.as_object_mut()) {
                options.remove("apiKey");
                options.remove("baseURL");
            }
            // Keep npm and models as they might be common
        }

        if config.is_null() || (config.is_object() && config.as_object().unwrap().is_empty()) {
            return Ok("{}".to_string());
        }

        serde_json::to_string_pretty(&config)
            .map_err(|e| AppError::Message(format!("Serialization failed: {e}")))
    }

    /// Extract common config for OpenClaw (JSON format)
    fn extract_openclaw_common_config(settings: &Value) -> Result<String, AppError> {
        // OpenClaw uses a different config structure with baseUrl, apiKey, api, models
        // For common config, we exclude provider-specific fields like apiKey
        let mut config = settings.clone();

        // Remove provider-specific fields
        if let Some(obj) = config.as_object_mut() {
            obj.remove("apiKey");
            obj.remove("baseUrl");
            // Keep api and models as they might be common
        }

        if config.is_null() || (config.is_object() && config.as_object().unwrap().is_empty()) {
            return Ok("{}".to_string());
        }

        serde_json::to_string_pretty(&config)
            .map_err(|e| AppError::Message(format!("Serialization failed: {e}")))
    }

    /// Import default configuration from live files (re-export)
    ///
    /// Returns `Ok(true)` if imported, `Ok(false)` if skipped.
    pub fn import_default_config(state: &AppState, app_type: AppType) -> Result<bool, AppError> {
        import_default_config(state, app_type)
    }

    pub fn should_import_default_config_on_startup(
        state: &AppState,
        app_type: &AppType,
    ) -> Result<bool, AppError> {
        should_import_default_config_on_startup(state, app_type)
    }

    /// Read current live settings (re-export)
    pub fn read_live_settings(app_type: AppType) -> Result<Value, AppError> {
        read_live_settings(app_type)
    }

    /// Get custom endpoints list (re-export)
    pub fn get_custom_endpoints(
        state: &AppState,
        app_type: AppType,
        provider_id: &str,
    ) -> Result<Vec<CustomEndpoint>, AppError> {
        endpoints::get_custom_endpoints(state, app_type, provider_id)
    }

    /// Add custom endpoint (re-export)
    pub fn add_custom_endpoint(
        state: &AppState,
        app_type: AppType,
        provider_id: &str,
        url: String,
    ) -> Result<(), AppError> {
        endpoints::add_custom_endpoint(state, app_type, provider_id, url)
    }

    /// Remove custom endpoint (re-export)
    pub fn remove_custom_endpoint(
        state: &AppState,
        app_type: AppType,
        provider_id: &str,
        url: String,
    ) -> Result<(), AppError> {
        endpoints::remove_custom_endpoint(state, app_type, provider_id, url)
    }

    /// Update endpoint last used timestamp (re-export)
    pub fn update_endpoint_last_used(
        state: &AppState,
        app_type: AppType,
        provider_id: &str,
        url: String,
    ) -> Result<(), AppError> {
        endpoints::update_endpoint_last_used(state, app_type, provider_id, url)
    }

    /// Update provider sort order
    pub fn update_sort_order(
        state: &AppState,
        app_type: AppType,
        updates: Vec<ProviderSortUpdate>,
    ) -> Result<bool, AppError> {
        let mut providers = state.db.get_all_providers(app_type.as_str())?;

        for update in updates {
            if let Some(provider) = providers.get_mut(&update.id) {
                provider.sort_index = Some(update.sort_index);
                state.db.save_provider(app_type.as_str(), provider)?;
            }
        }

        Ok(true)
    }

    /// Query provider usage (re-export)

    /// Test usage script (re-export)
    #[allow(clippy::too_many_arguments)]

    pub(crate) fn write_gemini_live(provider: &Provider) -> Result<(), AppError> {
        live::write_gemini_live(provider)
    }

    fn validate_provider_settings(app_type: &AppType, provider: &Provider) -> Result<(), AppError> {
        match app_type {
            AppType::Claude => {
                if !provider.settings_config.is_object() {
                    return Err(AppError::localized(
                        "provider.claude.settings.not_object",
                        "Claude 配置必须是 JSON 对象",
                        "Claude configuration must be a JSON object",
                    ));
                }
            }
            AppType::Codex => {
                let settings = provider.settings_config.as_object().ok_or_else(|| {
                    AppError::localized(
                        "provider.codex.settings.not_object",
                        "Codex 配置必须是 JSON 对象",
                        "Codex configuration must be a JSON object",
                    )
                })?;

                let auth = settings.get("auth").ok_or_else(|| {
                    AppError::localized(
                        "provider.codex.auth.missing",
                        format!("供应商 {} 缺少 auth 配置", provider.id),
                        format!("Provider {} is missing auth configuration", provider.id),
                    )
                })?;
                if !auth.is_object() {
                    return Err(AppError::localized(
                        "provider.codex.auth.not_object",
                        format!("供应商 {} 的 auth 配置必须是 JSON 对象", provider.id),
                        format!(
                            "Provider {} auth configuration must be a JSON object",
                            provider.id
                        ),
                    ));
                }

                if let Some(config_value) = settings.get("config") {
                    if !(config_value.is_string() || config_value.is_null()) {
                        return Err(AppError::localized(
                            "provider.codex.config.invalid_type",
                            "Codex config 字段必须是字符串",
                            "Codex config field must be a string",
                        ));
                    }
                    if let Some(cfg_text) = config_value.as_str() {
                        crate::codex_config::validate_config_toml(cfg_text)?;
                    }
                }
            }
            AppType::Gemini => {
                use crate::gemini_config::validate_gemini_settings;
                validate_gemini_settings(&provider.settings_config)?
            }
        }

        Ok(())
    }

    #[allow(dead_code)]
    fn extract_credentials(
        provider: &Provider,
        app_type: &AppType,
    ) -> Result<(String, String), AppError> {
        match app_type {
            AppType::Claude => {
                let env = provider
                    .settings_config
                    .get("env")
                    .and_then(|v| v.as_object())
                    .ok_or_else(|| {
                        AppError::localized(
                            "provider.claude.env.missing",
                            "配置格式错误: 缺少 env",
                            "Invalid configuration: missing env section",
                        )
                    })?;

                let api_key = env
                    .get("ANTHROPIC_AUTH_TOKEN")
                    .or_else(|| env.get("ANTHROPIC_API_KEY"))
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        AppError::localized(
                            "provider.claude.api_key.missing",
                            "缺少 API Key",
                            "API key is missing",
                        )
                    })?
                    .to_string();

                let base_url = env
                    .get("ANTHROPIC_BASE_URL")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        AppError::localized(
                            "provider.claude.base_url.missing",
                            "缺少 ANTHROPIC_BASE_URL 配置",
                            "Missing ANTHROPIC_BASE_URL configuration",
                        )
                    })?
                    .to_string();

                Ok((api_key, base_url))
            }
            AppType::Codex => {
                let auth = provider
                    .settings_config
                    .get("auth")
                    .and_then(|v| v.as_object())
                    .ok_or_else(|| {
                        AppError::localized(
                            "provider.codex.auth.missing",
                            "配置格式错误: 缺少 auth",
                            "Invalid configuration: missing auth section",
                        )
                    })?;

                let api_key = auth
                    .get("OPENAI_API_KEY")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        AppError::localized(
                            "provider.codex.api_key.missing",
                            "缺少 API Key",
                            "API key is missing",
                        )
                    })?
                    .to_string();

                let config_toml = provider
                    .settings_config
                    .get("config")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                let base_url = if config_toml.contains("base_url") {
                    let re = Regex::new(r#"base_url\s*=\s*["']([^"']+)["']"#).map_err(|e| {
                        AppError::localized(
                            "provider.regex_init_failed",
                            format!("正则初始化失败: {e}"),
                            format!("Failed to initialize regex: {e}"),
                        )
                    })?;
                    re.captures(config_toml)
                        .and_then(|caps| caps.get(1))
                        .map(|m| m.as_str().to_string())
                        .ok_or_else(|| {
                            AppError::localized(
                                "provider.codex.base_url.invalid",
                                "config.toml 中 base_url 格式错误",
                                "base_url in config.toml has invalid format",
                            )
                        })?
                } else {
                    return Err(AppError::localized(
                        "provider.codex.base_url.missing",
                        "config.toml 中缺少 base_url 配置",
                        "base_url is missing from config.toml",
                    ));
                };

                Ok((api_key, base_url))
            }
            AppType::Gemini => {
                use crate::gemini_config::json_to_env;

                let env_map = json_to_env(&provider.settings_config)?;

                let api_key = env_map.get("GEMINI_API_KEY").cloned().ok_or_else(|| {
                    AppError::localized(
                        "gemini.missing_api_key",
                        "缺少 GEMINI_API_KEY",
                        "Missing GEMINI_API_KEY",
                    )
                })?;

                let base_url = env_map
                    .get("GOOGLE_GEMINI_BASE_URL")
                    .cloned()
                    .unwrap_or_else(|| "https://generativelanguage.googleapis.com".to_string());

                Ok((api_key, base_url))
            }
        }
    }
}

/// Normalize Claude model keys in a JSON value
///
/// Reads old key (ANTHROPIC_SMALL_FAST_MODEL), writes new keys (DEFAULT_*), and deletes old key.
pub(crate) fn normalize_claude_models_in_value(settings: &mut Value) -> bool {
    let mut changed = false;
    let env = match settings.get_mut("env").and_then(|v| v.as_object_mut()) {
        Some(obj) => obj,
        None => return changed,
    };

    let model = env
        .get("ANTHROPIC_MODEL")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let small_fast = env
        .get("ANTHROPIC_SMALL_FAST_MODEL")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let current_haiku = env
        .get("ANTHROPIC_DEFAULT_HAIKU_MODEL")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let current_sonnet = env
        .get("ANTHROPIC_DEFAULT_SONNET_MODEL")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let current_opus = env
        .get("ANTHROPIC_DEFAULT_OPUS_MODEL")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let target_haiku = current_haiku
        .or_else(|| small_fast.clone())
        .or_else(|| model.clone());
    let target_sonnet = current_sonnet
        .or_else(|| model.clone())
        .or_else(|| small_fast.clone());
    let target_opus = current_opus
        .or_else(|| model.clone())
        .or_else(|| small_fast.clone());

    if env.get("ANTHROPIC_DEFAULT_HAIKU_MODEL").is_none() {
        if let Some(v) = target_haiku {
            env.insert(
                "ANTHROPIC_DEFAULT_HAIKU_MODEL".to_string(),
                Value::String(v),
            );
            changed = true;
        }
    }
    if env.get("ANTHROPIC_DEFAULT_SONNET_MODEL").is_none() {
        if let Some(v) = target_sonnet {
            env.insert(
                "ANTHROPIC_DEFAULT_SONNET_MODEL".to_string(),
                Value::String(v),
            );
            changed = true;
        }
    }
    if env.get("ANTHROPIC_DEFAULT_OPUS_MODEL").is_none() {
        if let Some(v) = target_opus {
            env.insert("ANTHROPIC_DEFAULT_OPUS_MODEL".to_string(), Value::String(v));
            changed = true;
        }
    }

    if env.remove("ANTHROPIC_SMALL_FAST_MODEL").is_some() {
        changed = true;
    }

    changed
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProviderSortUpdate {
    pub id: String,
    #[serde(rename = "sortIndex")]
    pub sort_index: usize,
}
