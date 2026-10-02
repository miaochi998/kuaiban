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

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
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
    /// Windows：当前是否为了让输入框能打字而临时允许窗口被激活。
    /// 平时必须为 false（挂件点击不抢焦点）；只有用户明确点输入框时才短暂变 true。
    /// 其它平台无意义，恒为 false。
    activatable: AtomicBool,
    /// Windows：临时可激活之前的前台窗口句柄，用于交还焦点（0 = 无）
    prev_foreground: AtomicIsize,
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

    if !expanded {
        // 面板收起 = 用户不再需要打字：立刻把"不抢焦点"恢复回去。
        // 这是"绝不能卡在可激活状态"的第一道保险（另外还有输入框 blur 与轮询看门狗）。
        set_activatable_inner(app, false);
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

/// Windows 专用：临时允许 / 禁止本窗口被激活。
///
/// 背景：挂件平时带 WS_EX_NOACTIVATE（点击不抢焦点），代价是这个窗口永远拿不到键盘焦点，
/// 底部"添加待办"输入框根本打不进字。而"随手记一条"是这个软件的核心功能。
/// 折中办法：只有用户明确点了输入框，才临时摘掉 WS_EX_NOACTIVATE 并主动取得焦点；
/// 输入框失焦 / 面板收起 / 按 Esc 时立刻恢复。
///
/// 前端调用点见 apps/desktop/src/App.vue（输入框 focus / blur、面板收起）。
/// 非 Windows 平台是空操作（macOS 用 ActivationPolicy::Accessory，不需要动态切换）。
#[tauri::command]
fn set_activatable(app: AppHandle, activatable: bool) {
    set_activatable_inner(&app, activatable);
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

        // 看门狗（Windows）：只要当前不需要打字，就确保 WS_EX_NOACTIVATE 在位。
        // 哪怕前面任何一条恢复路径失效，这里最多 80ms 就会纠正回来。
        if !state.activatable.load(Ordering::Relaxed) {
            if let Some(window) = app.get_webview_window(WIDGET_LABEL) {
                ensure_non_activating(&window);
            }
        }

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
// Windows 专属：不抢焦点 + 按需临时可输入
//
// 没有 WS_EX_NOACTIVATE，用户点挂件时当前工作窗口会失去焦点（输入框光标消失、
// 全屏游戏/演示被打断）——这是"不影响其他窗口工作"这条需求的技术前提。
//
// 但 WS_EX_NOACTIVATE 的代价是：该窗口永远拿不到键盘焦点，输入框打不了字。
// 所以这里做「动态切换」：
//   平时              → 带 WS_EX_NOACTIVATE，点面板任何地方都不抢焦点
//   用户点输入框      → 摘掉 NOACTIVATE + SetForegroundWindow + SetFocus，可以打字
//   失焦/收起/Esc     → 立刻装回 NOACTIVATE，并把焦点还给原来的窗口
// 三道保险防止"卡在可激活状态"：输入框 blur、面板收起、80ms 轮询看门狗。
// ─────────────────────────────────────────────────────────────

#[cfg(windows)]
fn hwnd_of(window: &WebviewWindow) -> Option<windows::Win32::Foundation::HWND> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows::Win32::Foundation::HWND;

    // 走 raw-window-handle 而不是 `window.hwnd()`：
    // 后者返回的 HWND 属于 tauri 依赖的 windows crate 版本（tauri 2.12 用 0.62），
    // 与本 crate 自己声明的版本不是同一个类型，得靠 `handle.0 as _` 硬转裸指针才编得过
    // （实测能编过，但把"两个版本的 HWND 内部都是裸指针"当成了隐含契约）。
    // raw-window-handle 只交换一个裸指针，是跨版本稳定的官方接口。
    let handle = window.window_handle().ok()?;
    match handle.as_raw() {
        RawWindowHandle::Win32(h) => Some(HWND(h.hwnd.get() as *mut _)),
        _ => None,
    }
}

#[cfg(windows)]
fn get_ex_style(hwnd: windows::Win32::Foundation::HWND) -> isize {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, GWL_EXSTYLE};
    unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) }
}

#[cfg(windows)]
fn set_ex_style(hwnd: windows::Win32::Foundation::HWND, style: isize) {
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowLongPtrW, GWL_EXSTYLE};
    unsafe {
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style);
    }
}

/// 打开 / 关闭「不抢焦点」。true = 不抢焦点（默认状态）。
/// 同时确保「不占任务栏」：补上 WS_EX_TOOLWINDOW，并摘掉 WS_EX_APPWINDOW。
///
/// 为什么还要动 APPWINDOW：tao（Tauri 的窗口层）创建窗口时按 WindowFlags 会带上
/// WS_EX_APPWINDOW，`skipTaskbar` 只是事后调 ITaskbarList::DeleteTab 把按钮摘掉。
/// 位还在，等于"两种意图打架"，explorer 重启等场景下按钮有可能被重新画出来。
/// 这里直接把 APPWINDOW 摘掉、TOOLWINDOW 补上，是 Windows 上"托盘常驻窗口"的标准做法。
#[cfg(windows)]
fn apply_non_activating(hwnd: windows::Win32::Foundation::HWND, non_activating: bool) {
    use windows::Win32::UI::WindowsAndMessaging::{
        WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    let current = get_ex_style(hwnd);
    // WS_EX_NOACTIVATE：点击不激活窗口（不抢焦点）
    // WS_EX_TOOLWINDOW：不出现在 Alt+Tab 列表里，也不出现在任务栏
    let no_activate = WS_EX_NOACTIVATE.0 as isize;
    let tool_window = WS_EX_TOOLWINDOW.0 as isize;
    let app_window = WS_EX_APPWINDOW.0 as isize;
    let base = (current | tool_window) & !app_window;
    let next = if non_activating {
        base | no_activate
    } else {
        base & !no_activate
    };
    if next != current {
        set_ex_style(hwnd, next);
    }
}

#[cfg(windows)]
fn make_non_activating(window: &WebviewWindow) {
    let Some(hwnd) = hwnd_of(window) else {
        eprintln!("[widget] 拿不到 HWND，无法设置 WS_EX_NOACTIVATE");
        return;
    };
    apply_non_activating(hwnd, true);
    println!("[widget] 已设置 WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW");
}

#[cfg(not(windows))]
fn make_non_activating(_window: &WebviewWindow) {
    // macOS 上等价能力通过 ActivationPolicy::Accessory 实现（在 setup 里设置）
}

#[cfg(windows)]
fn set_activatable_inner(app: &AppHandle, activatable: bool) {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow};

    let state = app.state::<WidgetState>();
    // 状态没变就不碰窗口 API（前端 focus/blur 可能重复调用）
    if state.activatable.swap(activatable, Ordering::Relaxed) == activatable {
        return;
    }

    let Some(window) = app.get_webview_window(WIDGET_LABEL) else {
        return;
    };
    let Some(hwnd) = hwnd_of(&window) else {
        return;
    };

    unsafe {
        if activatable {
            // 记住现在的前台窗口，等会儿把焦点还给它
            let foreground = GetForegroundWindow();
            if foreground != hwnd {
                state
                    .prev_foreground
                    .store(foreground.0 as isize, Ordering::Relaxed);
            }
            apply_non_activating(hwnd, false);
            // 用户刚刚点了输入框 —— 本进程持有"最后一次输入事件"，
            // 所以这里的 SetForegroundWindow 不会被前台锁定规则拒绝。
            //
            // ⚠️ 这里**不要**再补 SetFocus(hwnd)。实测（Windows 11 26300 @150%）：
            // 把焦点强设到顶层窗口会把 WebView2 子窗口的焦点顶掉 → 输入框立刻 blur
            // → 前端释放激活 → 挂件失活 → 输入框重新 focus → 再次申请激活……
            // 形成每秒上千次的 focus/blur 死循环，键盘输入全部丢失。
            // SetForegroundWindow 之后，WebView2 作为活动窗口的焦点子窗口会自然拿到键盘焦点。
            let ok = SetForegroundWindow(hwnd).as_bool();
            println!("[widget] 输入框取得键盘焦点（SetForegroundWindow={ok}）");
        } else {
            apply_non_activating(hwnd, true);
            let fg_now = GetForegroundWindow();
            // 只有当焦点仍在我们身上时才交还：如果用户已经自己点到别的窗口，
            // 再 SetForegroundWindow 就等于把焦点抢回来 —— 那正是需求禁止的行为。
            if fg_now == hwnd {
                let prev = state.prev_foreground.load(Ordering::Relaxed);
                if prev != 0 && prev != hwnd.0 as isize {
                    let _ = SetForegroundWindow(windows::Win32::Foundation::HWND(
                        prev as *mut _,
                    ));
                    println!("[widget] 已把焦点还给上一个窗口");
                }
            }
            state.prev_foreground.store(0, Ordering::Relaxed);
            println!("[widget] 恢复 WS_EX_NOACTIVATE（不抢焦点）");
        }
    }
}

#[cfg(not(windows))]
fn set_activatable_inner(_app: &AppHandle, _activatable: bool) {
    // 非 Windows 平台不需要动态切换激活策略
}

/// 看门狗：只要当前不是"需要输入"状态，就确保 WS_EX_NOACTIVATE 在位。
/// 万一某个前端路径漏掉了恢复调用，最多 80ms 后也会被自动纠正 —— "绝不卡在可激活状态"。
#[cfg(windows)]
fn ensure_non_activating(window: &WebviewWindow) {
    let Some(hwnd) = hwnd_of(window) else {
        return;
    };
    apply_non_activating(hwnd, true);
}

#[cfg(not(windows))]
fn ensure_non_activating(_window: &WebviewWindow) {}

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
        .invoke_handler(tauri::generate_handler![
            set_expanded,
            set_pinned,
            get_status,
            set_activatable
        ])
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
