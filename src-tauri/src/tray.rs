//! 托盘菜单管理模块
//!
//! 负责系统托盘图标和菜单的创建、更新和事件处理。

use once_cell::sync::Lazy;
use tauri::menu::{CheckMenuItem, Menu, MenuBuilder, MenuItem, Submenu, SubmenuBuilder};
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::app_config::AppType;
use crate::error::AppError;
use crate::store::AppState;

/// 每个 app 分区的子菜单句柄，用于 usage 更新时就地改 label 而非整菜单重建。
/// `create_tray_menu` 每次重建都会整表覆盖写入，保证句柄始终指向当前活跃菜单。
static TRAY_SECTION_SUBMENUS: Lazy<
    std::sync::Mutex<std::collections::HashMap<AppType, Submenu<tauri::Wry>>>,
> = Lazy::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// 托盘菜单文本（国际化）
#[derive(Clone, Copy)]
pub struct TrayTexts {
    pub show_main: &'static str,
    pub no_providers_label: &'static str,
    pub lightweight_mode: &'static str,
    pub quit: &'static str,
    pub _auto_label: &'static str,
}

impl TrayTexts {
    pub fn from_language(language: &str) -> Self {
        match language {
            "en" => Self {
                show_main: "Open main window",
                no_providers_label: "(no providers)",
                lightweight_mode: "Lightweight Mode",
                quit: "Quit",
                _auto_label: "Auto (Failover)",
            },
            "ja" => Self {
                show_main: "メインウィンドウを開く",
                no_providers_label: "(プロバイダーなし)",
                lightweight_mode: "軽量モード",
                quit: "終了",
                _auto_label: "自動 (フェイルオーバー)",
            },
            _ => Self {
                show_main: "打开主界面",
                no_providers_label: "(无供应商)",
                lightweight_mode: "轻量模式",
                quit: "退出",
                _auto_label: "自动 (故障转移)",
            },
        }
    }
}

/// 托盘应用分区配置
pub struct TrayAppSection {
    pub app_type: AppType,
    pub prefix: &'static str,
    pub empty_id: &'static str,
    pub header_label: &'static str,
    pub log_name: &'static str,
}

/// Auto 菜单项后缀
pub const AUTO_SUFFIX: &str = "auto";
pub const TRAY_ID: &str = "fwai-app";

pub const TRAY_SECTIONS: [TrayAppSection; 3] = [
    TrayAppSection {
        app_type: AppType::Claude,
        prefix: "claude_",
        empty_id: "claude_empty",
        header_label: "Claude",
        log_name: "Claude",
    },
    TrayAppSection {
        app_type: AppType::Codex,
        prefix: "codex_",
        empty_id: "codex_empty",
        header_label: "Codex",
        log_name: "Codex",
    },
    TrayAppSection {
        app_type: AppType::Gemini,
        prefix: "gemini_",
        empty_id: "gemini_empty",
        header_label: "Gemini",
        log_name: "Gemini",
    },
];

fn sort_providers(
    providers: &indexmap::IndexMap<String, crate::provider::Provider>,
) -> Vec<(&String, &crate::provider::Provider)> {
    let mut sorted: Vec<_> = providers.iter().collect();
    sorted.sort_by(|(_, a), (_, b)| {
        match (a.sort_index, b.sort_index) {
            (Some(idx_a), Some(idx_b)) => return idx_a.cmp(&idx_b),
            (Some(_), None) => return std::cmp::Ordering::Less,
            (None, Some(_)) => return std::cmp::Ordering::Greater,
            _ => {}
        }

        match (a.created_at, b.created_at) {
            (Some(time_a), Some(time_b)) => return time_a.cmp(&time_b),
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            _ => {}
        }

        a.name.cmp(&b.name)
    });
    sorted
}

/// 处理供应商托盘事件
pub fn handle_provider_tray_event(app: &tauri::AppHandle, event_id: &str) -> bool {
    for section in TRAY_SECTIONS.iter() {
        if let Some(suffix) = event_id.strip_prefix(section.prefix) {
            // 处理供应商点击
            log::info!("切换到{}供应商: {suffix}", section.log_name);
            let app_handle = app.clone();
            let provider_id = suffix.to_string();
            let app_type = section.app_type.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(e) = handle_provider_click(&app_handle, &app_type, &provider_id) {
                    log::error!("切换{}供应商失败: {e}", section.log_name);
                }
            });
            return true;
        }
    }
    false
}

/// 处理供应商点击：切换供应商
fn handle_provider_click(
    app: &tauri::AppHandle,
    app_type: &AppType,
    provider_id: &str,
) -> Result<(), AppError> {
    if let Some(app_state) = app.try_state::<AppState>() {
        let app_type_str = app_type.as_str();

        // 切换供应商。需要本地路由的供应商也不在这里自动启动代理，
        // 由用户在页面/设置中手动开启。
        crate::services::ProviderService::switch(app_state.inner(), app_type.clone(), provider_id)?;

        // 更新托盘菜单
        if let Ok(new_menu) = create_tray_menu(app, app_state.inner()) {
            if let Some(tray) = app.tray_by_id(TRAY_ID) {
                let _ = tray.set_menu(Some(new_menu));
            }
        }

        // 发射事件到前端
        let event_data = serde_json::json!({
            "appType": app_type_str,
            "providerId": provider_id
        });
        if let Err(e) = app.emit("provider-switched", event_data) {
            log::error!("发射 provider-switched 事件失败: {e}");
        }
    }
    Ok(())
}

/// 创建动态托盘菜单
pub fn create_tray_menu(
    app: &tauri::AppHandle,
    app_state: &AppState,
) -> Result<Menu<tauri::Wry>, AppError> {
    let app_settings = crate::settings::get_settings();
    let tray_texts = TrayTexts::from_language(app_settings.language.as_deref().unwrap_or("zh"));

    // Get visible apps setting, default to all visible
    let visible_apps = app_settings.visible_apps.unwrap_or_default();

    let mut menu_builder = MenuBuilder::new(app);
    let mut section_handles: std::collections::HashMap<AppType, Submenu<tauri::Wry>> =
        std::collections::HashMap::new();

    // 顶部：打开主界面 / 打开官方网站
    let show_main_item =
        MenuItem::with_id(app, "show_main", tray_texts.show_main, true, None::<&str>)
            .map_err(|e| AppError::Message(format!("创建打开主界面菜单失败: {e}")))?;
    menu_builder = menu_builder.item(&show_main_item).separator();

    // 每个应用类型折叠为子菜单，避免供应商过多时菜单过长
    for section in TRAY_SECTIONS.iter() {
        if !visible_apps.is_visible(&section.app_type) {
            continue;
        }

        let app_type_str = section.app_type.as_str();
        let providers = app_state.db.get_all_providers(app_type_str)?;

        let current_id =
            crate::settings::get_effective_current_provider(&app_state.db, &section.app_type)?
                .unwrap_or_default();

        if providers.is_empty() {
            // 空供应商：显示禁用的菜单项
            let label = format!("{} {}", section.header_label, tray_texts.no_providers_label);
            let empty_item = MenuItem::with_id(app, section.empty_id, &label, false, None::<&str>)
                .map_err(|e| {
                    AppError::Message(format!("创建{}空提示失败: {e}", section.log_name))
                })?;
            menu_builder = menu_builder.item(&empty_item);
        } else {
            let current_provider = providers.get(&current_id);
            let submenu_label = match current_provider {
                Some(p) => format!("{} · {}", section.header_label, p.name),
                None => section.header_label.to_string(),
            };
            let submenu_id = format!("submenu_{}", app_type_str);

            let mut submenu_builder = SubmenuBuilder::with_id(app, &submenu_id, &submenu_label);

            for (id, provider) in sort_providers(&providers) {
                let is_current = current_id == *id;
                let item = CheckMenuItem::with_id(
                    app,
                    format!("{}{}", section.prefix, id),
                    &provider.name,
                    true,
                    is_current,
                    None::<&str>,
                )
                .map_err(|e| {
                    AppError::Message(format!("创建{}菜单项失败: {e}", section.log_name))
                })?;
                submenu_builder = submenu_builder.item(&item);
            }

            let submenu = submenu_builder.build().map_err(|e| {
                AppError::Message(format!("构建{}子菜单失败: {e}", section.log_name))
            })?;
            section_handles.insert(section.app_type.clone(), submenu.clone());
            menu_builder = menu_builder.item(&submenu);
        }

        menu_builder = menu_builder.separator();
    }

    let lightweight_item = CheckMenuItem::with_id(
        app,
        "lightweight_mode",
        tray_texts.lightweight_mode,
        true,
        crate::lightweight::is_lightweight_mode(),
        None::<&str>,
    )
    .map_err(|e| AppError::Message(format!("创建轻量模式菜单失败: {e}")))?;

    menu_builder = menu_builder.item(&lightweight_item).separator();

    // 退出菜单（分隔符已在上面的 section 循环中添加）
    let quit_item = MenuItem::with_id(app, "quit", tray_texts.quit, true, None::<&str>)
        .map_err(|e| AppError::Message(format!("创建退出菜单失败: {e}")))?;

    menu_builder = menu_builder.item(&quit_item);

    let menu = menu_builder
        .build()
        .map_err(|e| AppError::Message(format!("构建菜单失败: {e}")))?;

    *TRAY_SECTION_SUBMENUS
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = section_handles;

    Ok(menu)
}

/// 就地更新各 app 分区子菜单的标题（usage 后缀变化时走这条），
/// 避免 `set_menu` 导致用户打开中的菜单被关闭。
/// 句柄由上一次 `create_tray_menu` 填充；为空（从未构建过菜单）时无事发生。
fn update_tray_usage_labels(app: &tauri::AppHandle) {
    let Some(app_state) = app.try_state::<AppState>() else {
        return;
    };
    let handles = match TRAY_SECTION_SUBMENUS.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };

    for section in TRAY_SECTIONS.iter() {
        let Some(submenu) = handles.get(&section.app_type) else {
            continue;
        };
        let Ok(providers) = app_state.db.get_all_providers(section.app_type.as_str()) else {
            continue;
        };
        let Ok(Some(current_id)) =
            crate::settings::get_effective_current_provider(&app_state.db, &section.app_type)
        else {
            continue;
        };
        let Some(provider) = providers.get(&current_id) else {
            continue;
        };
        let new_label = format!("{} · {}", section.header_label, provider.name);
        if let Err(e) = submenu.set_text(&new_label) {
            log::debug!("[Tray] 更新{}子菜单标题失败: {e}", section.log_name);
        }
    }
}

pub fn refresh_tray_menu(app: &tauri::AppHandle) {
    use crate::store::AppState;

    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(new_menu) = create_tray_menu(app, state.inner()) {
            if let Some(tray) = app.tray_by_id(TRAY_ID) {
                if let Err(e) = tray.set_menu(Some(new_menu)) {
                    log::error!("刷新托盘菜单失败: {e}");
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub fn apply_tray_policy(app: &tauri::AppHandle, dock_visible: bool) {
    use tauri::ActivationPolicy;

    let desired_policy = if dock_visible {
        ActivationPolicy::Regular
    } else {
        ActivationPolicy::Accessory
    };

    if let Err(err) = app.set_dock_visibility(dock_visible) {
        log::warn!("设置 Dock 显示状态失败: {err}");
    }

    if let Err(err) = app.set_activation_policy(desired_policy) {
        log::warn!("设置激活策略失败: {err}");
    }
}

/// 处理托盘菜单事件
pub fn handle_tray_menu_event(app: &tauri::AppHandle, event_id: &str) {
    log::info!("处理托盘菜单事件: {event_id}");

    match event_id {
        "show_main" => {
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                {
                    let _ = window.set_skip_taskbar(false);
                }
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
                #[cfg(target_os = "linux")]
                {
                    crate::linux_fix::nudge_main_window(window.clone());
                }
                #[cfg(target_os = "macos")]
                {
                    apply_tray_policy(app, true);
                }
            } else if crate::lightweight::is_lightweight_mode() {
                if let Err(e) = crate::lightweight::exit_lightweight_mode(app) {
                    log::error!("退出轻量模式重建窗口失败: {e}");
                }
            }
        }
        "lightweight_mode" => {
            if crate::lightweight::is_lightweight_mode() {
                if let Err(e) = crate::lightweight::exit_lightweight_mode(app) {
                    log::error!("退出轻量模式失败: {e}");
                }
            } else if let Err(e) = crate::lightweight::enter_lightweight_mode(app) {
                log::error!("进入轻量模式失败: {e}");
            }
        }
        "quit" => {
            log::info!("退出应用");
            app.exit(0);
        }
        _ => {
            if handle_provider_tray_event(app, event_id) {
                return;
            }
            log::warn!("未处理的菜单事件: {event_id}");
        }
    }
}

static TRAY_REBUILD_SCHEDULED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub fn schedule_tray_refresh(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    if TRAY_REBUILD_SCHEDULED.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(std::time::Duration::from_millis(50));
        TRAY_REBUILD_SCHEDULED.store(false, Ordering::Release);
        update_tray_usage_labels(&app);
    });
}

#[cfg(test)]
mod tests {
    use super::TRAY_ID;

    #[test]
    fn tray_id_is_unique_to_app() {
        assert_eq!(TRAY_ID, "fwai-app");
    }
}
