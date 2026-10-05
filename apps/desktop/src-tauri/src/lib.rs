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
//!   * 展开后由前端 mouseleave + 1.5 秒延迟收起；Rust 侧主要负责「展开」，
//!     另有一道明显更长（3 秒）的兜底收起，防止前端收不到该事件时面板永远卡住。
//!   * 不抢焦点：Windows 上必须设 WS_EX_NOACTIVATE，否则点一下挂件会把
//!     用户正在用的窗口夺走焦点 —— 那这个软件就没法用了。

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::time::Duration;

// 托盘与系统菜单只在桌面端存在（Android 上没有这两样），单独一组导入。
#[cfg(desktop)]
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent,
};
use tauri_plugin_sql::{Migration, MigrationKind};

/// 主窗口 label（与 tauri.conf.json 一致）
const WIDGET_LABEL: &str = "main";

/// 面板宽度（逻辑像素）—— 与 tauri.conf.json / CSS 保持一致
const PANEL_WIDTH: f64 = 340.0;
/// 面板最大高度（逻辑像素），实际取屏幕高度的 80% 与它的小值
const PANEL_MAX_HEIGHT: f64 = 560.0;
/// 收起时露在屏幕右侧的窄条宽度（逻辑像素），也是悬停命中区的宽度
const STRIP_WIDTH: f64 = 12.0;
/// 收起时**可见**窄条的高度（逻辑像素）。
///
/// ⚠️ 跨层契约：必须与 `apps/desktop/src/App.vue` 里 `.strip { height: 152px }` 保持一致。
/// 改一个必须同时改另一个 —— 否则"看得见的窄条"与"能触发悬停的区域"会对不上，
/// 表现为「鼠标明明没碰到窄条，面板却自己弹出来了」。
const STRIP_HEIGHT: f64 = 152.0;
/// 悬停命中区在窄条上下各外扩的手感容差（逻辑像素）。
/// 纯粹是为了让鼠标不至于因为差一两个像素就悬停不上，不宜放大。
const STRIP_HIT_PADDING: f64 = 8.0;
/// 鼠标坐标轮询间隔（毫秒）
const POLL_INTERVAL_MS: u64 = 80;
/// 兜底收起阈值：面板展开、未钉住，但鼠标**连续**在窗口外超过这么久（毫秒）→ 强制收起。
///
/// 为什么需要这道兜底：前端靠 `mouseleave` + 1.5 秒延迟收起，但存在收不到该事件的路径
/// —— 例如从托盘唤起后面板被钉住、用户点了 📌 取消钉住时 mouseleave 已经先一步因
/// `pinned` 为 true 而被忽略 —— 面板就会永远卡在展开状态。
///
/// ⚠️ 必须**明显大于**前端 `App.vue` 里的 `COLLAPSE_DELAY_MS`(1500ms)，
/// 否则会抢在前端正常收起之前把面板收掉，破坏「移开 1.5 秒才收起」的手感。这里取 2 倍。
const OUTSIDE_COLLAPSE_MS: u64 = 3_000;
/// 把上面的毫秒阈值折算成轮询次数（3000 / 80 = 38 次）
const OUTSIDE_STREAK_LIMIT: u32 = OUTSIDE_COLLAPSE_MS.div_ceil(POLL_INTERVAL_MS) as u32;
/// 判定「鼠标在窗口之外」时预留的余量（逻辑像素），避免鼠标贴着边缘时来回抖动
const OUTSIDE_MARGIN: f64 = 24.0;

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
    #[cfg_attr(not(windows), allow(dead_code))]
    prev_foreground: AtomicIsize,
    /// 有「未处理的到点提醒」时置位：这段时间内**不要**自动收起面板，
    /// 否则提醒卡片刚弹出来就会被兜底收起，用户根本没看见。
    hold_open: AtomicBool,
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

/// 设置「钉住」状态；`pinned = true` 时立即展开。
///
/// 抽成 `_inner` 是因为托盘也要用：**从托盘显式显示面板等价于钉住**（见 `tray_toggle`）。
fn set_pinned_inner(app: &AppHandle, pinned: bool) {
    let state = app.state::<WidgetState>();
    state.pinned.store(pinned, Ordering::Relaxed);

    if pinned {
        // 钉住立刻展开
        set_expanded_inner(app, true);
    }

    // 无论展开状态有没有变化，都要补发一次事件：
    // `set_expanded_inner` 在"状态没变"时会提前 return、不发事件，
    // 那条路径下前端就看不到 pinned 的变化（例如托盘钉住一个已经展开的面板）。
    let _ = app.emit("widget:state", state.status());
}

#[tauri::command]
fn set_pinned(app: AppHandle, pinned: bool) {
    set_pinned_inner(&app, pinned);
}

#[tauri::command]
fn get_status(app: AppHandle) -> WidgetStatus {
    app.state::<WidgetState>().status()
}

/// 有未处理的到点提醒时由前端置位，避免面板被"鼠标移开 3 秒"的兜底收起。
/// 提醒全部处理完后前端会复位，面板随即恢复正常行为。
///
/// 参数刻意叫 `hold`（单词）而不是 `hold_open`：Tauri 会把 JS 侧的 camelCase
/// 转成 Rust 的 snake_case，单词名可以完全绕开这个转换，少一个看不见的失败点。
#[tauri::command]
fn set_hold_open(app: AppHandle, hold: bool) {
    app.state::<WidgetState>().hold_open.store(hold, Ordering::Relaxed);
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
    // 「鼠标连续在窗口之外」的轮询计数，只服务于兜底收起（见 OUTSIDE_STREAK_LIMIT）
    let mut outside_streak: u32 = 0;

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

        let pinned = state.pinned.load(Ordering::Relaxed);
        let expanded = state.expanded.load(Ordering::Relaxed);

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

        let left = win_pos.x as f64;
        let right = left + win_size.width as f64;
        let top = win_pos.y as f64;
        let bottom = top + win_size.height as f64;
        // 面板是垂直居中的（见 apply_layout），所以窗口纵向中心就是可见窄条的纵向中心
        let center_y = (top + bottom) / 2.0;

        // 钉住状态：展开与收起完全交给前端 📌 和托盘，轮询不插手
        if pinned {
            outside_streak = 0;
            continue;
        }

        // ── 兜底收起 ──
        // 只在"已展开"时生效。正常情况下前端 mouseleave 会在 1.5 秒后收起，
        // 这里仅仅是为了防止前端收不到该事件时面板永远卡住。
        // 阈值 3 秒 > 前端 1.5 秒，正常路径下永远不会抢跑。
        if expanded {
            // 用户正在输入时绝不收起：Windows 下 activatable = true 等价于「输入框有焦点」。
            // 否则鼠标一离开窗口，就会把正在输入的面板收掉、草稿白打。
            // ⚠️ 非 Windows 平台该标志恒为 false，这条保护不生效
            //    （macOS 的同类问题必须在前端 App.vue 的 scheduleCollapse 里修）。
            //
            // 有未处理的到点提醒时同样不收起：提醒卡片正是要让人看见的，
            // 弹出来 3 秒就被兜底收走等于没提醒。
            if state.activatable.load(Ordering::Relaxed) || state.hold_open.load(Ordering::Relaxed) {
                outside_streak = 0;
                continue;
            }

            let margin = OUTSIDE_MARGIN * scale;
            let outside = cursor.x < left - margin
                || cursor.x > right + margin
                || cursor.y < top - margin
                || cursor.y > bottom + margin;

            if outside {
                outside_streak += 1;
                if outside_streak >= OUTSIDE_STREAK_LIMIT {
                    outside_streak = 0;
                    set_expanded_inner(&app, false);
                }
            } else {
                outside_streak = 0;
            }
            continue;
        }

        // ── 悬停展开 ──
        outside_streak = 0;

        let strip = STRIP_WIDTH * scale;
        // 命中区的纵向半高 = 可见窄条半高 + 手感容差
        let half_hit = (STRIP_HEIGHT / 2.0 + STRIP_HIT_PADDING) * scale;

        // 命中区：屏幕最右侧 STRIP_WIDTH 宽、纵向**以可见窄条为准**的那一段。
        // 注意不是整个窗口高度 —— 否则在窄条上下方的空白处悬停也会弹出面板，
        // 用户会被莫名其妙弹出来的面板吓到。
        let in_strip = cursor.x >= right - strip
            && cursor.x <= right + 2.0
            && cursor.y >= center_y - half_hit
            && cursor.y <= center_y + half_hit;

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

/// macOS：让窗口在**不是 key window** 时也能收到 `mouseMoved` 事件。
///
/// ## 为什么必须做（这是用户反馈的真实 bug）
///
/// `NSWindow.acceptsMouseMovedEvents` **默认是 false**，而 AppKit 只在窗口是
/// key window 时才无条件投递 `mouseMoved`。我们的挂件是辅助窗口
/// （`ActivationPolicy::Accessory`），**永远不是 key** —— 于是 WebView 收不到
/// 任何鼠标移动事件，CSS `:hover` 一直不更新：
///
/// - 首次展开面板后，鼠标移到待办上**不出现**「完成 / 删」
/// - 随便点一下（窗口因此变成 key），之后再悬停就正常了
///
/// 打开这个开关后，非 key 窗口也能收到 mouseMoved，悬停立刻可用，
/// 而且**不需要**把窗口变成 key —— 也就不会抢焦点，正好符合"不打断其他窗口"这条铁律。
#[cfg(target_os = "macos")]
fn enable_mouse_moved_events(window: &WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let Ok(ptr) = window.ns_window() else {
        eprintln!("[widget] 拿不到 NSWindow，无法开启 acceptsMouseMovedEvents");
        return;
    };
    if ptr.is_null() {
        return;
    }

    // SAFETY: ns_window() 返回有效的 NSWindow 指针；本函数在 setup（主线程）里调用，
    // 且 AppKit 的窗口属性只能在主线程访问。
    unsafe {
        let ns_window = ptr as *mut AnyObject;
        let _: () = msg_send![ns_window, setAcceptsMouseMovedEvents: true];
    }
    println!("[widget] 已开启 acceptsMouseMovedEvents（非 key 窗口也能收到鼠标移动 → 悬停可用）");
}

#[cfg(not(target_os = "macos"))]
fn enable_mouse_moved_events(_window: &WebviewWindow) {
    // 仅 macOS 需要：Windows 的窗口消息模型不存在这个问题。
}

/// 记录「用户正在挂件里输入」这一状态，并（仅 Windows）相应切换窗口的激活策略。
///
/// ⚠️ 这个标志**所有平台都要正确维护**，不能只在 Windows 上记：
/// Rust 侧的兜底收起（`spawn_hover_watcher` 里那道 3 秒的）要靠它避免
/// "打字打到一半、鼠标一移开面板就被收走、草稿白打"。
/// Windows 上它额外决定窗口要不要临时变成可激活（否则输入框根本收不到键盘输入）。
fn set_activatable_inner(app: &AppHandle, activatable: bool) {
    let state = app.state::<WidgetState>();
    // 状态没变就不做后续动作（前端 mousedown / blur 可能重复调用）
    if state.activatable.swap(activatable, Ordering::Relaxed) == activatable {
        return;
    }
    apply_activatable(app, activatable);
}

#[cfg(windows)]
fn apply_activatable(app: &AppHandle, activatable: bool) {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow};

    let state = app.state::<WidgetState>();
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
fn apply_activatable(_app: &AppHandle, _activatable: bool) {
    // macOS 用 ActivationPolicy::Accessory 一次性搞定，不需要动态切换窗口激活策略。
    // 但上面的 activatable 标志已经记下了 —— Rust 侧兜底收起靠它避免打字时被收走。
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

#[cfg(desktop)]
/// 托盘「显示 / 隐藏面板」菜单项与托盘图标左键点击的**统一**行为。
///
/// 语义约定（用户已拍板）：**从托盘显式显示面板 = 钉住**。
/// 原因：从托盘唤起时鼠标并没有进入过窗口，前端收不到 `mouseleave`，
/// 所以 1.5 秒自动收起不会触发 —— 不钉住的话面板会一直开着，用户也不知道为什么。
/// 钉住后 📌 会亮起来，语义变得清晰：「这是你从托盘叫出来的」。
fn tray_toggle(app: &AppHandle) {
    let state = app.state::<WidgetState>();
    let expanded = state.expanded.load(Ordering::Relaxed);

    if expanded {
        // 隐藏：**先取消钉住，再收起**。
        // 顺序不能反 —— `set_expanded` 命令里有「钉住时拒绝收起」的判断，
        // 虽然这里直接调 inner 绕过了它，但保持"先解锁再关"的顺序更不容易踩坑。
        set_pinned_inner(app, false);
        set_expanded_inner(app, false);
    } else {
        set_pinned_inner(app, true);
    }
}

#[cfg(desktop)]
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItemBuilder::with_id("toggle", "显示 / 隐藏面板").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出快办").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&toggle, &quit]).build()?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("快办")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => tray_toggle(app),
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
                // 左键点击与菜单项「显示 / 隐藏面板」行为完全一致
                tray_toggle(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────
// 数据库迁移
// ─────────────────────────────────────────────────────────────

/// SQLite 数据库的逻辑名。
///
/// `sqlite:` 前缀是 tauri-plugin-sql 的路径约定；实际文件落在系统的应用数据目录下
/// （macOS: ~/Library/Application Support/com.kuaiban.app/，Windows: %APPDATA%）。
/// 单文件的好处：用户换电脑时把这个文件拷走就带走了全部数据。
pub const DB_URL: &str = "sqlite:kuaiban.db";

/// 数据库迁移。
///
/// 表结构是**与大脑的约定**（对应 packages/shared 里的 `Todo` 类型）：
/// - 列名一律 snake_case，字段名 camelCase，映射在 `apps/desktop/src/data/todo-row.ts`。
/// - `repeat` 与 `skipped_dates` 存 **JSON 文本**。
///   为什么不拆成关联表：重复规则是一个封闭的小联合类型（5 种），
///   拆表会让读写都变成多次往返，而它从不参与 SQL 查询条件 —— 存 JSON 更简单也更快。
/// - `remind` 用 INTEGER 0/1（SQLite 没有原生 boolean）。
/// - 软删除靠 `deleted_at`，**不做物理删除**：同步规则是"删除优先"，
///   服务端需要看到"这条被删了"这个事实，而不是"查不到这条"。
///
/// SQL 放在 `src-tauri/migrations/*.sql`，用 `include_str!` 在编译期嵌进来。
/// 这样做是为了**消除重复定义**：同一份 SQL 也被 TS 侧的真库往返测试读取
/// （`apps/desktop/test/sqlite-roundtrip.test.ts`），
/// 于是"Rust 建的表"和"TS 读写的表"不可能再对不上。
///
/// 刻意拆成 3 个版本而不是 1 个多语句迁移：SQLite 驱动对"一次执行多条语句"的
/// 支持依实现而异，拆开可以确保每条都真的执行了（否则索引可能被静默跳过）。
/// 版本号只增不改 —— 已经发布过的版本改了也不会重跑。
fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create_todos",
            sql: include_str!("../migrations/001_create_todos.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "index_todos_date",
            sql: include_str!("../migrations/002_index_todos_date.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "index_todos_updated_at",
            sql: include_str!("../migrations/003_index_todos_updated_at.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

// ─────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // ⚠️ 单实例插件必须**第一个**注册（插件文档的要求），
        // 否则它来不及拦住第二个实例，别的插件就已经跑起来了。
        //
        // 为什么必须有它：挂件的待办列表是内存副本，两个实例各持一份，
        // A 里加的待办 B 看不到（要重启才同步）。用户会以为"数据丢了"。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 第二个实例试图启动时，把已经在跑的那个叫出来 ——
            // 让用户明白"程序就在这里，不是没反应"。
            set_expanded_inner(app, true);
        }))
        .plugin(tauri_plugin_opener::init())
        // 在线更新。真正干活的是前端（这样更新提示能融进挂件的界面），
        // 这里只把能力挂上去。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(DB_URL, migrations())
                .build(),
        )
        .manage(WidgetState::default())
        .invoke_handler(tauri::generate_handler![
            set_expanded,
            set_pinned,
            get_status,
            set_activatable,
            set_hold_open
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
                // 不点一下就不响应悬停的修复，见 enable_mouse_moved_events
                enable_mouse_moved_events(&window);
                // 初始为收起状态：鼠标穿透
                let _ = window.set_ignore_cursor_events(true);
                let _ = window.show();
            }

            // 调试开关：`KUAIBAN_DEBUG_EXPANDED=1` 时启动即展开并钉住。
            //
            // 为什么需要它：挂件默认收起，展开要靠"鼠标悬停"。
            // 而自动化验证（截图 / 脚本）没法真的把光标移过去 ——
            // 合成鼠标事件需要进程具备"辅助功能"权限，拿不到就静默失效。
            // 有了这个开关，才能对**真实应用**做端到端截图验证
            // （SQLite 读出来的数据到底有没有正确渲染到面板上）。
            // 不设这个环境变量时行为完全不变。
            if std::env::var("KUAIBAN_DEBUG_EXPANDED").as_deref() == Ok("1") {
                let state = app.state::<WidgetState>();
                state.pinned.store(true, Ordering::Relaxed);
                set_expanded_inner(&handle, true);
                println!("[widget] KUAIBAN_DEBUG_EXPANDED=1 —— 启动即展开（调试用）");
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
