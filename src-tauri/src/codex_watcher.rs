//! 转发期间盯住 `~/.codex/config.toml`，有人写回禁止字段
//! （`CODEX_FORWARDING_FORBIDDEN_KEYS`）就删掉。
//!
//! 用 mtime 轮询而不是文件系统事件：`~/.codex` 可能还不存在、覆盖目录可能运行中
//! 被改掉，轮询每次现算路径，这两种情况都不用额外处理。一次 stat 的开销可以忽略。

use std::sync::Arc;
use std::time::{Duration, SystemTime};

use crate::database::Database;

const POLL_INTERVAL: Duration = Duration::from_secs(1);

pub fn spawn(db: Arc<Database>) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(POLL_INTERVAL);
        // None 表示还没看过；第一轮一定检查一次，覆盖 app 没运行时写进去的情况。
        let mut last_seen: Option<Option<SystemTime>> = None;
        loop {
            interval.tick().await;
            let mtime = std::fs::metadata(crate::codex_config::get_codex_config_path())
                .and_then(|meta| meta.modified())
                .ok();
            if last_seen == Some(mtime) {
                continue;
            }
            last_seen = Some(mtime);
            if mtime.is_none() {
                continue;
            }
            match crate::services::provider::forwarding::strip_codex_forbidden_keys(&db) {
                Ok(true) => log::info!("已删除转发期间写入 config.toml 的禁止字段"),
                Ok(false) => {}
                Err(e) => log::warn!("检查 Codex config.toml 的禁止字段失败: {e}"),
            }
        }
    });
}
