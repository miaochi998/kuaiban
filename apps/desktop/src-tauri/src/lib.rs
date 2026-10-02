//! 快办 — 桌面挂件外壳（Tauri 层）
//!
//! 本文件只负责「平台相关」的窗口行为：贴边、悬停展开、移开收起、不抢焦点、托盘。
//! 业务逻辑一律不在这里 —— 那属于 `packages/core`（大脑）。
//!
//! 数据流：
//!   Rust（本文件）  ──emit("widget:state")──►  前端
//!   前端           ──invoke("set_expanded")──►  Rust
//!
//! 设计要点（为什么这样做）：
//!   * 窗口**始终保持展开尺寸**，收起时靠 CSS 把面板滑出窗口 + 让鼠标穿透。
//!     这样动画平滑，且不会在缩放窗口时抖动。
//!   * 收起状态鼠标是穿透的，收不到 hover 事件，所以**悬停判定用轮询鼠标坐标**。
//!   * 展开后由前端 mouseleave + 1.5 秒延迟收起；Rust 侧只负责「展开」。
//!   * 不抢焦点：Windows 上必须设 WS_EX_NOACTIVATE，否则点一下挂件会把
//!     用户正在用的窗口夺走焦点 —— 那这个软件就没法用了。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent,
};

/// 主窗口 label（与 tauri.conf.json 一致）
const WIDGET_LABEL: &str = "main";

/// 面板宽度（逻辑像素）—— 与 tauri.conf.json / CSS 保持一致
const PANEL_WIDTH: f64 = 340.0;
/// 面板最大高度（逻辑像素），实际取屏幕高度的 80% 与它的小值
const PANEL_MAX_HEIGHT: f64 = 560.0;
/// 收起时露在屏幕右侧的窄条宽度（逻辑像素），也是悬停命中区
const STRIP_WIDTH: f64 = 12.0;
/// 鼠标坐标轮询间隔（毫秒）
const POLL_INTERVAL_MS: u64 = 80;

// ─────────────────────────────────────────────────────────────
// 状态
// ─────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct WidgetState {
    /// 面板是否展开
    expanded: AtomicBool,
    /// 是否被"钉住"（钉住后鼠标移开也不收起）
    pinned: AtomicBool,
}

#[derive(Clone, serde::Serialize)]
pub struct WidgetStatus {
    expanded: bool,
    pinned: bool,
}

impl WidgetState {
    fn status(&self) -> WidgetStatus {
        WidgetStatus {
            expanded: self.expanded.load(Ordering::Relaxed),
            pinned: self.pinned.load(Ordering::Relaxed),
        }
    }
}

// ─────────────────────────────────────────────────────────────
// 窗口布局：贴屏幕最右侧、垂直居中
// ─────────────────────────────────────────────────────────────

fn apply_layout(window: &WebviewWindow) {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());

    let Some(monitor) = monitor else {
        eprintln!("[widget] 找不到显示器，跳过布局");
        return;
    };

    let scale = monitor.scale_factor();
    let screen_size = monitor.size();
    let screen_pos = monitor.position();

    // 面板高度：不超过屏幕 80%，也不超过 PANEL_MAX_HEIGHT
    let logical_height = PANEL_MAX_HEIGHT.min((screen_size.height as f64 / scale) * 0.8);

    let w = (PANEL_WIDTH * scale).round() as i32;
    let h = (logical_height * scale).round() as i32;

    // 贴紧屏幕右边缘，垂直居中
    let x = screen_pos.x + screen_size.width as i32 - w;
    let y = screen_pos.y + (screen_size.height as i32 - h) / 2;

    let _ = window.set_size(PhysicalSize::new(w as u32, h as u32));
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

// ─────────────────────────────────────────────────────────────
// 展开 / 收起
// ─────────────────────────────────────────────────────────────

fn set_expanded_inner(app: &AppHandle, expanded: bool) {
    let state = app.state::<WidgetState>();

    // 状态没变就不做任何事，避免轮询反复触发窗口 API
    if state.expanded.swap(expanded, Ordering::Relaxed) == expanded {
        return;
    }

    if let Some(window) = app.get_webview_window(WIDGET_LABEL) {
        // 收起时让鼠标穿透：面板已经滑出窗口，不该挡住底下任何窗口的操作
        let _ = window.set_ignore_cursor_events(!expanded);
    }

    let _ = app.emit("widget:state", state.status());
}

#[tauri::command]
fn set_expanded(app: AppHandle, expanded: bool) {
    let state = app.state::<WidgetState>();
    // 钉住状态下忽略"收起"请求（只有显式取消钉住才能收起）
    if !expanded && state.pinned.load(Ordering::Relaxed) {
        return;
    }
    set_expanded_inner(&app, expanded);
}

#[tauri::command]
fn set_pinned(app: AppHandle, pinned: bool) {
    let state = app.state::<WidgetState>();
    state.pinned.store(pinned, Ordering::Relaxed);

    if pinned {
        // 钉住立刻展开
        set_expanded_inner(&app, true);
    } else {
        let _ = app.emit("widget:state", state.status());
    }
}

#[tauri::command]
fn get_status(app: AppHandle) -> WidgetStatus {
    app.state::<WidgetState>().status()
}

// ─────────────────────────────────────────────────────────────
// 悬停检测（轮询鼠标坐标）
//
// 为什么不用 mouseenter 事件：收起状态下窗口是鼠标穿透的，根本收不到事件。
// 轮询 80ms 一次，代价极低，而且能顺便支持"鼠标在屏幕最右边缘"这种更宽的命中区。
// ─────────────────────────────────────────────────────────────

fn spawn_hover_watcher(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));

        let state = app.state::<WidgetState>();
        if state.pinned.load(Ordering::Relaxed) || state.expanded.load(Ordering::Relaxed) {
            continue;
        }

        let Some(window) = app.get_webview_window(WIDGET_LABEL) else {
            continue;
        };
        if !window.is_visible().unwrap_or(false) {
            continue;
        }

        let (Ok(win_pos), Ok(win_size), Ok(cursor)) = (
            window.outer_position(),
            window.outer_size(),
            app.cursor_position(),
        ) else {
            continue;
        };

        let scale = window.scale_factor().unwrap_or(1.0);
        let strip = STRIP_WIDTH * scale;

        let right = win_pos.x as f64 + win_size.width as f64;
        let top = win_pos.y as f64;
        let bottom = top + win_size.height as f64;

        // 命中区：窗口最右侧 STRIP_WIDTH 宽的那一条（也就是屏幕最右边一条）
        let in_strip = cursor.x >= right - strip
            && cursor.x <= right + 2.0
            && cursor.y >= top
            && cursor.y <= bottom;

        if in_strip {
            set_expanded_inner(&app, true);
        }
    });
}

// ─────────────────────────────────────────────────────────────
// Windows 专属：不抢焦点
//
// 没有这一句，用户点挂件时当前工作窗口会失去焦点（输入框光标消失、
// 全屏游戏/演示被打断）——这是"不影响其他窗口工作"这条需求的技术前提。
// ─────────────────────────────────────────────────────────────

#[cfg(windows)]
fn make_non_activating(window: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    let Ok(handle) = window.hwnd() else {
        eprintln!("[widget] 拿不到 HWND，无法设置 WS_EX_NOACTIVATE");
        return;
    };
    let hwnd = HWND(handle.0 as _);

    unsafe {
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        // WS_EX_NOACTIVATE：点击不激活窗口（不抢焦点）
        // WS_EX_TOOLWINDOW：不出现在 Alt+Tab 列表里
        let new_style = current | (WS_EX_NOACTIVATE.0 as isize) | (WS_EX_TOOLWINDOW.0 as isize);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_style);
    }
    println!("[widget] 已设置 WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW");
}

#[cfg(not(windows))]
fn make_non_activating(_window: &WebviewWindow) {
    // macOS 上等价能力通过 ActivationPolicy::Accessory 实现（在 setup 里设置）
}

// ─────────────────────────────────────────────────────────────
// 系统托盘
// ─────────────────────────────────────────────────────────────

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItemBuilder::with_id("toggle", "显示 / 隐藏面板").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出快办").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&toggle, &quit]).build()?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("快办")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => {
                let state = app.state::<WidgetState>();
                let expanded = state.expanded.load(Ordering::Relaxed);
                set_expanded_inner(app, !expanded);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let state = app.state::<WidgetState>();
                let expanded = state.expanded.load(Ordering::Relaxed);
                set_expanded_inner(app, !expanded);
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(WidgetState::default())
        .invoke_handler(tauri::generate_handler![set_expanded, set_pinned, get_status])
        .setup(|app| {
            let handle = app.handle().clone();

            // macOS：隐藏 Dock 图标，做成"附件"型应用（等价于 Windows 的不占任务栏）
            #[cfg(target_os = "macos")]
            {
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            if let Some(window) = app.get_webview_window(WIDGET_LABEL) {
                apply_layout(&window);
                make_non_activating(&window);
                // 初始为收起状态：鼠标穿透
                let _ = window.set_ignore_cursor_events(true);
                let _ = window.show();
            }

            build_tray(&handle)?;
            spawn_hover_watcher(handle);

            Ok(())
        })
        .on_window_event(|window, event| {
            // 挂件没有关闭按钮；即使被 Alt+F4 / Cmd+W 关掉，也只隐藏不退出，
            // 否则用户会"莫名其妙地把软件关没了"，提醒也就全失效。
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running 快办");
}
