//! Panic Hook 模块
//!
//! 在应用崩溃时捕获 panic 信息并记录到 `<app_config_dir>/crash.log` 文件中（默认 `~/.fwai_app/crash.log`）。
//! 便于用户和开发者诊断闪退问题。主线程上的 panic 还会弹框告诉用户原因。

use std::fs::OpenOptions;
use std::io::Write;
use std::panic;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// 应用版本号（从 Cargo.toml 读取）
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

static APP_CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn init_app_config_dir(dir: PathBuf) {
    let _ = APP_CONFIG_DIR.set(dir);
}

/// 获取默认应用配置目录（不会 panic）
///
/// 这里刻意不调用 config::get_app_config_dir()：panic hook 在崩溃路径上运行，
/// 必须自给自足。目录名要和它保持一致——写成 `.cc-switch` 会把 fwai_app 的崩溃
/// 日志丢进上游应用的目录里。
fn default_app_config_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".fwai_app")
}

/// 获取应用配置目录（优先使用初始化时写入的值；不会 panic）
fn get_app_config_dir() -> PathBuf {
    APP_CONFIG_DIR
        .get()
        .cloned()
        .unwrap_or_else(default_app_config_dir)
}

/// 获取崩溃日志文件路径
fn get_crash_log_path() -> PathBuf {
    get_app_config_dir().join("crash.log")
}

/// 获取日志目录路径
pub fn get_log_dir() -> PathBuf {
    get_app_config_dir().join("logs")
}

/// 安全获取环境信息（不会 panic）
fn get_system_info() -> String {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let family = std::env::consts::FAMILY;

    // 安全获取当前工作目录
    let cwd = std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    // 安全获取当前线程信息
    let thread = std::thread::current();
    let thread_name = thread.name().unwrap_or("unnamed");
    let thread_id = format!("{:?}", thread.id());

    format!(
        "OS: {os} ({family})\n\
         Arch: {arch}\n\
         App Version: {APP_VERSION}\n\
         Working Dir: {cwd}\n\
         Thread: {thread_name} (ID: {thread_id})"
    )
}

/// 设置 panic hook，捕获崩溃信息并写入日志文件
///
/// 在应用启动时调用此函数，确保任何 panic 都会被记录。
/// 日志格式包含：
/// - 时间戳
/// - 应用版本和系统信息
/// - Panic 信息
/// - 发生位置（文件:行号）
/// - Backtrace（完整调用栈）
pub fn setup_panic_hook() {
    // 启用 backtrace（确保 release 模式也能捕获）
    if std::env::var("RUST_BACKTRACE").is_err() {
        std::env::set_var("RUST_BACKTRACE", "1");
    }

    let default_hook = panic::take_hook();

    panic::set_hook(Box::new(move |panic_info| {
        let log_path = get_crash_log_path();

        // 确保目录存在
        if let Some(parent) = log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        // 构建崩溃信息（使用 catch_unwind 保护时间格式化，避免嵌套 panic）
        let timestamp = std::panic::catch_unwind(|| {
            chrono::Local::now()
                .format("%Y-%m-%d %H:%M:%S%.3f")
                .to_string()
        })
        .unwrap_or_else(|_| {
            // chrono panic 时回退到 unix timestamp
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| format!("unix:{}.{:03}", d.as_secs(), d.subsec_millis()))
                .unwrap_or_else(|_| "unknown".to_string())
        });

        // 获取系统信息
        let system_info = std::panic::catch_unwind(get_system_info)
            .unwrap_or_else(|_| "Failed to get system info".to_string());

        // 获取 panic 消息（尝试多种方式提取）
        let message = if let Some(s) = panic_info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = panic_info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            // 尝试使用 Display trait
            format!("{panic_info}")
        };

        // 获取位置信息
        let location = if let Some(loc) = panic_info.location() {
            format!(
                "File: {}\n         Line: {}\n         Column: {}",
                loc.file(),
                loc.line(),
                loc.column()
            )
        } else {
            "Unknown location".to_string()
        };

        // 捕获 backtrace（完整调用栈）
        let backtrace = std::backtrace::Backtrace::force_capture();
        let backtrace_str = format!("{backtrace}");

        // 格式化日志条目
        let separator = "=".repeat(80);
        let sub_separator = "-".repeat(40);
        let crash_entry = format!(
            r#"
{separator}
[CRASH REPORT] {timestamp}
{separator}

{sub_separator}
System Information
{sub_separator}
{system_info}

{sub_separator}
Error Details
{sub_separator}
Message: {message}

Location: {location}

{sub_separator}
Stack Trace (Backtrace)
{sub_separator}
{backtrace_str}

{separator}
"#
        );

        // 写入文件（追加模式）
        let log_saved = match OpenOptions::new().create(true).append(true).open(&log_path) {
            Ok(mut file) => {
                let written = file.write_all(crash_entry.as_bytes()).is_ok();
                let _ = file.flush();

                // 记录日志文件位置到 stderr
                eprintln!("\n[CC-Switch] Crash log saved to: {}", log_path.display());
                written
            }
            Err(_) => false,
        };

        // 同时输出到 stderr（便于开发调试）
        eprintln!("{crash_entry}");

        if is_fatal_thread() {
            let short_location = panic_info
                .location()
                .map(|loc| format!("{}:{}", loc.file(), loc.line()))
                .unwrap_or_default();
            let saved_path = log_saved.then_some(log_path.as_path());
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                show_crash_dialog(&message, &short_location, saved_path)
            }));
        }

        // 调用默认 hook
        default_hook(panic_info);
    }));
}

/// 当前线程的 panic 会不会带走整个进程。
///
/// Tauri 的事件循环、setup 和同步 command 都跑在主线程：这里 panic，要么一路
/// 展开出 main，要么穿过窗口回调的 FFI 边界直接 abort，进程都活不了。
/// tokio 任务里的 panic 会被运行时接住，应用照常运行，这时弹「即将退出」是误报。
fn is_fatal_thread() -> bool {
    std::thread::current().name() == Some("main")
}

/// 弹框里 panic 消息的最大长度。tauri::Error 的 Debug 输出可能很长，全文在崩溃日志里。
const DIALOG_MESSAGE_MAX_CHARS: usize = 800;

/// 崩溃弹框的正文。中英双语：Windows 上通常没有 LANG，没法可靠判断语言。
fn crash_dialog_text(message: &str, location: &str, log_path: Option<&Path>) -> String {
    let mut reason: String = message.chars().take(DIALOG_MESSAGE_MAX_CHARS).collect();
    if message.chars().count() > DIALOG_MESSAGE_MAX_CHARS {
        reason.push('…');
    }
    if !location.is_empty() {
        reason.push_str(&format!("\n({location})"));
    }
    let log = match log_path {
        Some(path) => format!(
            "崩溃日志 / Crash log:\n{}\n\n\
             请把这个文件发给我们。\nPlease send this file to us.",
            path.display()
        ),
        None => "崩溃日志写入失败。\nFailed to write the crash log.".to_string(),
    };
    format!(
        "fwai_app 遇到错误，即将退出。\n\
         fwai_app ran into an error and needs to close.\n\n\
         原因 / Reason:\n{reason}\n\n{log}"
    )
}

fn show_crash_dialog(message: &str, location: &str, log_path: Option<&Path>) {
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title(format!("fwai_app {APP_VERSION}"))
        .set_description(crash_dialog_text(message, location, log_path))
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_crash_log_path() {
        let path = get_crash_log_path();
        assert!(path.ends_with("crash.log"));
    }

    /// 默认目录（APP_CONFIG_DIR 未初始化时的回退）不能落在 `.cc-switch` 下——
    /// 那是上游应用的目录，崩溃日志写进去就串了。直接断言这个函数而不是
    /// get_crash_log_path()：后者读 OnceLock，值取决于同进程里别的测试有没有
    /// 先调用过 init_app_config_dir。
    #[test]
    fn test_default_config_dir_is_not_upstream() {
        let dir = default_app_config_dir();
        assert!(!dir.to_string_lossy().contains(".cc-switch"));
        assert!(dir.ends_with(".fwai_app"));
    }

    #[test]
    fn test_crash_dialog_text_has_reason_and_log_path() {
        let path = PathBuf::from("/home/u/.fwai_app/crash.log");
        let text = crash_dialog_text("setup failed", "src/lib.rs:540", Some(&path));
        assert!(text.contains("setup failed"));
        assert!(text.contains("src/lib.rs:540"));
        assert!(text.contains(&path.display().to_string()));
    }

    #[test]
    fn test_crash_dialog_text_truncates_long_message() {
        let long = "错".repeat(DIALOG_MESSAGE_MAX_CHARS + 100);
        let text = crash_dialog_text(&long, "", None);
        assert!(text.contains('…'));
        assert!(!text.contains(&long));
        assert!(text.contains("Failed to write the crash log"));
    }

    #[test]
    fn test_system_info() {
        let info = get_system_info();
        assert!(info.contains("OS:"));
        assert!(info.contains("Arch:"));
        assert!(info.contains("App Version:"));
    }
}
