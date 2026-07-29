#![allow(non_snake_case)]

use crate::config::ConfigStatus;

/// Claude 插件：获取 ~/.claude/config.json 状态
#[tauri::command]
pub async fn get_claude_plugin_status() -> Result<ConfigStatus, String> {
    crate::claude_plugin::claude_config_status()
        .map(|(exists, path)| ConfigStatus {
            exists,
            path: path.to_string_lossy().to_string(),
        })
        .map_err(|e| e.to_string())
}

/// Claude 插件：读取配置内容（若不存在返回 Ok(None)）
#[tauri::command]
pub async fn read_claude_plugin_config() -> Result<Option<String>, String> {
    crate::claude_plugin::read_claude_config().map_err(|e| e.to_string())
}

/// Claude 插件：写入/清除固定配置
#[tauri::command]
pub async fn apply_claude_plugin_config(official: bool) -> Result<bool, String> {
    if official {
        crate::claude_plugin::clear_claude_config().map_err(|e| e.to_string())
    } else {
        crate::claude_plugin::write_claude_config().map_err(|e| e.to_string())
    }
}

/// Claude 插件：检测是否已写入目标配置
#[tauri::command]
pub async fn is_claude_plugin_applied() -> Result<bool, String> {
    crate::claude_plugin::is_claude_config_applied().map_err(|e| e.to_string())
}

/// Claude Code：跳过初次安装确认（写入 ~/.claude.json 的 hasCompletedOnboarding=true）
#[tauri::command]
pub async fn apply_claude_onboarding_skip() -> Result<bool, String> {
    set_has_completed_onboarding().map_err(|e| e.to_string())
}

/// Claude Code：恢复初次安装确认（删除 ~/.claude.json 的 hasCompletedOnboarding 字段）
#[tauri::command]
pub async fn clear_claude_onboarding_skip() -> Result<bool, String> {
    clear_has_completed_onboarding().map_err(|e| e.to_string())
}

/// Claude Code onboarding flag helpers (formerly in claude_mcp.rs).
fn read_claude_user_json() -> Result<serde_json::Value, crate::error::AppError> {
    let path = crate::config::get_claude_mcp_path();
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    crate::config::read_json_file(&path)
}

fn set_has_completed_onboarding() -> Result<bool, crate::error::AppError> {
    let path = crate::config::get_claude_mcp_path();
    let mut root = read_claude_user_json()?;
    let obj = root
        .as_object_mut()
        .ok_or_else(|| crate::error::AppError::Config("~/.claude.json 根必须是对象".into()))?;
    let already = obj
        .get("hasCompletedOnboarding")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if already {
        return Ok(false);
    }
    obj.insert(
        "hasCompletedOnboarding".into(),
        serde_json::Value::Bool(true),
    );
    crate::config::write_json_file(&path, &root)?;
    Ok(true)
}

fn clear_has_completed_onboarding() -> Result<bool, crate::error::AppError> {
    let path = crate::config::get_claude_mcp_path();
    if !path.exists() {
        return Ok(false);
    }
    let mut root = read_claude_user_json()?;
    let obj = root
        .as_object_mut()
        .ok_or_else(|| crate::error::AppError::Config("~/.claude.json 根必须是对象".into()))?;
    if obj.remove("hasCompletedOnboarding").is_none() {
        return Ok(false);
    }
    crate::config::write_json_file(&path, &root)?;
    Ok(true)
}
