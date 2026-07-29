use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::str::FromStr;

use crate::config::{copy_file, get_app_config_dir, get_app_config_path, write_json_file};
use crate::error::AppError;
use crate::provider::ProviderManager;

/// 应用类型
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppType {
    Claude,
    Codex,
    Gemini,
}

impl AppType {
    pub fn as_str(&self) -> &str {
        match self {
            AppType::Claude => "claude",
            AppType::Codex => "codex",
            AppType::Gemini => "gemini",
        }
    }

    /// Additive mode wrote ALL providers to live config (OpenCode/OpenClaw/
    /// Hermes). Those apps are gone; every remaining app is switch mode.
    pub fn is_additive_mode(&self) -> bool {
        false
    }

    /// Return an iterator over all app types
    pub fn all() -> impl Iterator<Item = AppType> {
        [AppType::Claude, AppType::Codex, AppType::Gemini].into_iter()
    }
}

impl FromStr for AppType {
    type Err = AppError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let normalized = s.trim().to_lowercase();
        match normalized.as_str() {
            "claude" => Ok(AppType::Claude),
            "codex" => Ok(AppType::Codex),
            "gemini" => Ok(AppType::Gemini),
            other => Err(AppError::localized(
                "unsupported_app",
                format!("不支持的应用标识: '{other}'。可选值: claude, codex, gemini。"),
                format!("Unsupported app id: '{other}'. Allowed: claude, codex, gemini."),
            )),
        }
    }
}

/// 通用配置片段（按应用分治）。已下线应用的字段保留用于反序列化旧配置。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CommonConfigSnippets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gemini: Option<String>,
}

impl CommonConfigSnippets {
    /// 获取指定应用的通用配置片段
    pub fn get(&self, app: &AppType) -> Option<&String> {
        match app {
            AppType::Claude => self.claude.as_ref(),
            AppType::Codex => self.codex.as_ref(),
            AppType::Gemini => self.gemini.as_ref(),
        }
    }

    /// 设置指定应用的通用配置片段
    pub fn set(&mut self, app: &AppType, snippet: Option<String>) {
        match app {
            AppType::Claude => self.claude = snippet,
            AppType::Codex => self.codex = snippet,
            AppType::Gemini => self.gemini = snippet,
        }
    }
}

/// 多应用配置结构（仅用于旧版 config.json → SQLite 的一次性迁移路径）。
/// 移除的功能（MCP/Prompt/Skills 等）在旧配置里的字段会被 serde 静默忽略。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultiAppConfig {
    #[serde(default = "default_version")]
    pub version: u32,
    /// 应用管理器（claude/codex/gemini）
    #[serde(flatten)]
    pub apps: HashMap<String, ProviderManager>,
    /// 旧版功能字段（MCP/Prompt/Skills 已移除）。必须显式吸收，否则
    /// serde(flatten) 会把这些键塞进 apps 并按 ProviderManager 解析而报错。
    #[serde(default, skip_serializing)]
    mcp: serde_json::Value,
    #[serde(default, skip_serializing)]
    prompts: serde_json::Value,
    #[serde(default, skip_serializing)]
    skills: serde_json::Value,
    /// 通用配置片段（按应用分治）
    #[serde(default)]
    pub common_config_snippets: CommonConfigSnippets,
    /// Claude 通用配置片段（旧字段，用于向后兼容迁移）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_common_config_snippet: Option<String>,
}

fn default_version() -> u32 {
    2
}

impl Default for MultiAppConfig {
    fn default() -> Self {
        let mut apps = HashMap::new();
        apps.insert("claude".to_string(), ProviderManager::default());
        apps.insert("codex".to_string(), ProviderManager::default());
        apps.insert("gemini".to_string(), ProviderManager::default());

        Self {
            version: 2,
            apps,
            mcp: serde_json::Value::Null,
            prompts: serde_json::Value::Null,
            skills: serde_json::Value::Null,
            common_config_snippets: CommonConfigSnippets::default(),
            claude_common_config_snippet: None,
        }
    }
}

impl MultiAppConfig {
    /// 从文件加载配置（仅支持 v2 结构）
    pub fn load() -> Result<Self, AppError> {
        let config_path = get_app_config_path();

        if !config_path.exists() {
            log::info!("配置文件不存在，创建新的多应用配置");
            let config = Self::default();
            config.save()?;
            return Ok(config);
        }

        let content =
            std::fs::read_to_string(&config_path).map_err(|e| AppError::io(&config_path, e))?;
        let value: serde_json::Value =
            serde_json::from_str(&content).map_err(|e| AppError::json(&config_path, e))?;

        // v1 判定：顶层同时包含 providers(object) + current(string) 且无 apps
        let is_v1 = value.get("providers").is_some_and(|v| v.is_object())
            && value.get("current").is_some_and(|v| v.is_string())
            && value.get("apps").is_none();
        if is_v1 {
            return Err(AppError::localized(
                "config.unsupported_v1",
                "检测到旧版 v1 配置格式。当前版本已不再支持运行时自动迁移。".to_string(),
                "Detected legacy v1 config. Runtime auto-migration is no longer supported."
                    .to_string(),
            ));
        }

        let mut config: Self =
            serde_json::from_value(value).map_err(|e| AppError::json(&config_path, e))?;
        let mut updated = false;

        // 确保 gemini 应用存在（兼容旧配置文件）
        if !config.apps.contains_key("gemini") {
            config
                .apps
                .insert("gemini".to_string(), ProviderManager::default());
            updated = true;
        }

        // 迁移通用配置片段：claude_common_config_snippet → common_config_snippets.claude
        if let Some(old_claude_snippet) = config.claude_common_config_snippet.take() {
            log::info!(
                "迁移通用配置：claude_common_config_snippet → common_config_snippets.claude"
            );
            config.common_config_snippets.claude = Some(old_claude_snippet);
            updated = true;
        }

        if updated {
            log::info!("配置结构已更新，保存配置...");
            config.save()?;
        }

        Ok(config)
    }

    /// 保存配置到文件
    pub fn save(&self) -> Result<(), AppError> {
        let config_path = get_app_config_path();
        // 先备份旧版（若存在）到 ~/.fwai_app/config.json.bak，再写入新内容
        if config_path.exists() {
            let backup_path = get_app_config_dir().join("config.json.bak");
            if let Err(e) = copy_file(&config_path, &backup_path) {
                log::warn!("备份 config.json 到 .bak 失败: {e}");
            }
        }

        write_json_file(&config_path, self)?;
        Ok(())
    }

    /// 获取指定应用的管理器
    pub fn get_manager(&self, app: &AppType) -> Option<&ProviderManager> {
        self.apps.get(app.as_str())
    }

    /// 获取指定应用的管理器（可变引用）
    pub fn get_manager_mut(&mut self, app: &AppType) -> Option<&mut ProviderManager> {
        self.apps.get_mut(app.as_str())
    }

    /// 确保应用存在
    pub fn ensure_app(&mut self, app: &AppType) {
        if !self.apps.contains_key(app.as_str()) {
            self.apps
                .insert(app.as_str().to_string(), ProviderManager::default());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_type_parses_supported_apps() {
        assert_eq!(AppType::from_str("claude").unwrap(), AppType::Claude);
        assert_eq!(AppType::from_str("Codex").unwrap(), AppType::Codex);
        assert_eq!(AppType::from_str(" gemini ").unwrap(), AppType::Gemini);
        assert!(AppType::from_str("opencode").is_err());
        assert!(AppType::from_str("claude-desktop").is_err());
    }

    #[test]
    fn multi_app_config_ignores_removed_feature_fields() {
        let json = serde_json::json!({
            "version": 2,
            "claude": {"providers": {}, "current": ""},
            "codex": {"providers": {}, "current": ""},
            "mcp": {"claude": {"servers": {}}},
            "prompts": {"claude": {"prompts": {}}},
            "skills": {"installed": []}
        });
        let config: MultiAppConfig = serde_json::from_value(json).unwrap();
        assert!(config.apps.contains_key("claude"));
        assert!(config.apps.contains_key("codex"));
    }
}
