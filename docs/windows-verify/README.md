# 快办 — Windows 挂件外壳验证报告（v1）

> 执行人：Windows 侧开发代理　｜　分支：`feat/windows-shell-verify`　｜　基线：`main@266bf14`
> 目标：在真 Windows 机器上实测挂件外壳行为（不抢焦点 / 不占任务栏 / 贴边悬停 / 输入框可打字 / 托盘），
> 修掉 Windows 专属代码里过不去的地方，并把结论交回 macOS 侧 review。

---

## 0. 结论速览

| 项 | 结果 | 一句话依据 |
|---|---|---|
| A 不抢焦点 | ✅ **通过**（含一处必须说明的取舍） | 悬停 / 点面板空白 / 勾选待办 / 点 📌 全过程中前台窗口一直是编辑器；面板开着时打字仍然进编辑器。**唯一点输入框会主动夺取焦点**（见 A 项备注，这是"能打字"的前提） |
| B 不占任务栏 | ✅ **通过** | UI Automation 枚举任务栏按钮列表里没有「快办」；Alt+Tab 切窗器截图里也没有（附截图） |
| C 贴边 / 悬停 / 收起 | ✅ **通过** | 窗口物理矩形 (3330,660)–(3840,1500)，右边缘正好 = 屏幕宽 3840，垂直居中；悬停展开；移开 1.58–1.63 秒收起；📌 钉住后不收起 |
| D 收起时不挡其他窗口 | ✅ **通过** | 收起态 `WindowFromPoint` 在挂件矩形内两点都命中底层窗口；展开态同两点命中挂件 |
| E 输入框能打字 | ✅ **通过** | 点输入框→打字→回车，新待办出现在「今天」列表，角标 6→7（附截图） |
| F 系统托盘 | ✅ **通过** | 托盘图标存在（UIA 名称「快办」）；菜单两项齐全；「显示 / 隐藏面板」能切换；「退出快办」真正退出（进程数 1→0，退出码 0） |
| G 高 DPI / 多显示器 | ⚠️ **部分通过** | 本机就是 **150% 缩放**：窗口物理右边缘 = 3840 = 屏幕宽，窄条精确贴住物理右边缘；**100% / 125% 未实测**（需改系统显示设置），多显示器**无设备可测**，仅做代码层分析 |

**最重要的两个发现**

1. **任务书第 6.1 节的假设被实测否证**：这段 `#[cfg(windows)]` 代码**原本就能在 Windows 上编译通过**（0 error / 0 warning，见"发现的问题"第 1 条）。
   仍然按建议改成了 raw-window-handle 写法，理由不是"编不过"，而是"不该依赖两个 windows crate 版本的裸指针布局"。
2. **第 6.2 节的问题确认存在，而且比预想的更凶**：`WS_EX_NOACTIVATE` 确实让输入框完全打不进字；
   而常见的"顺手补一句 `SetFocus`"会把 WebView2 拖进 **每秒上千次的 focus/blur 死循环**，键盘输入全丢（第 3 条有日志证据）。
   最终方案：**只 `SetForegroundWindow`，不 `SetFocus`；激活状态只由"点输入框"这一个显式动作驱动，绝不由 focus 事件驱动**。

---

## 1. 环境

| 项 | 值 |
|---|---|
| 系统 | Windows 11 专业工作站版 **build 26300**，x64 |
| 显示器 | **1 台**；物理分辨率 **3840 × 2160**，刷新 59Hz |
| 缩放 | **150%**（`AppliedDPI=144`，逻辑分辨率 2560 × 1440） |
| Node / pnpm | v22.20.0 / 10.23.0（corepack 启用） |
| Rust | rustc 1.91.0（`x86_64-pc-windows-msvc`）/ cargo 1.91.0 |
| WebView2 Runtime | 154.0.4258.48（系统已自带） |
| Git | 2.51.1.windows.1（SSH key 已配好，直接 `git clone git@github.com:...`） |

### 1.1 这台机器上没有 Visual Studio Build Tools —— 替代构建环境（重要）

本机**没有管理员权限**，装不了 `Microsoft.VisualStudio.2022.BuildTools`。而 Windows 上构建这个项目实际需要三样东西：

1. **C/C++ 编译器**：`tauri-build → embed-resource → vswhom-sys` 要编译一个 `vswhom.cpp`（缺 `cl.exe` 时构建直接失败）
2. **资源编译器**：`embed-resource` 要编译 Windows 资源（图标 + 应用清单）
3. **MSVC CRT + Windows SDK 的库**：链接 Rust 的 msvc 目标

用**全部不需要管理员的便携方案**解决了，配置写在 `%USERPROFILE%\.cargo\config.toml`（**不进仓库**）：

```toml
[target.x86_64-pc-windows-msvc]
linker = '$env:USERPROFILE\.rustup\toolchains\stable-x86_64-pc-windows-msvc\lib\rustlib\x86_64-pc-windows-msvc\bin\rust-lld.exe'
rustflags = ['-Lnative=F:\tools\xwin-sdk\crt\lib\x86_64',
             '-Lnative=F:\tools\xwin-sdk\sdk\lib\ucrt\x86_64',
             '-Lnative=F:\tools\xwin-sdk\sdk\lib\um\x86_64']

[env]                                  # 供 build script（vswhom-sys / embed-resource）读取
CC_x86_64_pc_windows_msvc   = '...\llvm\bin\clang-cl.exe'
CXX_x86_64_pc_windows_msvc  = '...\llvm\bin\clang-cl.exe'
AR_x86_64_pc_windows_msvc   = '...\llvm\bin\llvm-lib.exe'
CFLAGS_x86_64_pc_windows_msvc   = '/I F:\tools\xwin-sdk\crt\include /I F:\tools\xwin-sdk\sdk\include\ucrt /I F:\tools\xwin-sdk\sdk\include\shared /I F:\tools\xwin-sdk\sdk\include\um'
CXXFLAGS_x86_64_pc_windows_msvc = '（同上）'
RC = '...\llvm\bin\llvm-rc.exe'
```

组件来源（都是解压即用，无需安装）：

| 需要的东西 | 用的什么 | 备注 |
|---|---|---|
| MSVC CRT + Windows SDK 库/头 | [`xwin`](https://github.com/Jake-Shadle/xwin) 0.10.0 `splat`（直接抓微软官方包，SDK 10.0.26100） | 约 1.5GB |
| 链接器 | rustup 自带的 `rust-lld`（`rustc` 会传 `-flavor link`，只有 `rust-lld.exe` 认；`lib/rustlib/…/bin/gcc-ld/lld-link.exe` 不认这个参数） | 踩坑点 |
| C++ 编译器 / 资源编译器 | 便携版 LLVM 23.1.2 的 `clang-cl` / `llvm-rc` / `llvm-lib` | 约 860MB（`.tar.xz`） |
| Rust 目标 | `rustup default stable-x86_64-pc-windows-msvc` | 本机原本默认是 gnu |

> 结论：**"没有 VS Build Tools 也能构建"这条路是通的**，可以给 CI / 以后的构建机参考。
> 但如果那台机器有管理员权限，直接装 VS Build Tools 仍然更省事（配置更少、坑更少）。

### 1.2 截图脚本的坑（任务书附录 A 的脚本会截错）

本机 150% 缩放 + WebView2 硬件合成，两个坑叠在一起：

- PowerShell（.NET WinForms）进程**是 DPI 不感知的**，`Screen.Bounds` 返回 2560×1440（逻辑），`CopyFromScreen` 截出来是**被缩小的 2560×1440** 图；
- GDI `BitBlt` 不带 `CAPTUREBLT` 时**抓不到 WebView2 的合成层**，挂件直接"消失"在截图里（第一轮我因此一度以为挂件没渲染）。

本目录里的 [`shot.ps1`](./shot.ps1) 是修正版：独立进程 + `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` + `BitBlt(SRCCOPY|CAPTUREBLT)`，
截出来是**真实物理像素 3840×2160**。用法：`pwsh -NoProfile -File shot.ps1 -Out x.png [-CropX -CropY -CropW -CropH -Zoom]`。

---

## 2. 验证结果（逐项实测）

### A 不抢焦点 ✅

实测步骤与证据（编辑器用本机的 `notepad.exe`，它被 IFEO 重定向到 Notepad2，pid 8328，文件 `F:\tools\verify\focus-target.txt`）：

| 步骤 | 结果 | 证据 |
|---|---|---|
| 编辑器里打字（基线） | ✅ | 文件内容含 `KB-A1` |
| 鼠标移到屏幕最右窄条 → 面板展开 | ✅ 焦点未变 | 展开瞬间前台仍是 Notepad2 |
| 点面板**空白处** | ✅ 焦点未变 | 前台 pid 8328 |
| 勾选一条待办「周会」 | ✅ 焦点未变、勾选生效 | 前台 pid 8328 + 截图 `03-focus-notepad-active.png` |
| 点 📌 钉住 | ✅ 焦点未变 | 前台 pid 8328 |
| 面板开着时在键盘上打字 | ✅ 进编辑器 | 文件追加 `KB-A2`（不是进挂件） |

**必须说清楚的取舍：点"输入框"那一下会夺取焦点。**
任务书 A 的第 3 步列了"点一下输入框"，同时又要求随后"打字仍然进入记事本"；
但 E 项要求输入框必须能打字 —— **在 Windows 上这两件事在物理上互斥**：
输入框要收到键盘输入，就必须让本窗口成为前台窗口。

本实现的选择是：**只有"用户明确点输入框"这一个动作会让挂件夺取焦点**，并且立刻在以下任一情况归还：

- 输入框 blur（用户点到别处）→ 实测点回编辑器后 800ms 内 `NOACTIVATE` 已装回、打字立刻回到编辑器（文件追加 `KB-A3`）；
- 面板收起 / 按 Esc → Rust 侧强制归还（还有 80ms 轮询看门狗兜底）。

所以 A 项对"悬停、点空白、勾选、钉住、面板开着打字"全部成立；**只有"点输入框"这一下是有意的例外**，这也是 E 项能通过的前提。

### B 不占任务栏 ✅

- **任务栏按钮（UI Automation 实测）**：`1363575665 - RustDesk` / `# 任务: 在 Windows 上… - DeepSeek Harness` / `1.桌面待办清单 - 小黄条 - Google Chrome` / `* 未命名 - Notepad2` / `focus-target.txt […] - Notepad2` —— **没有「快办」**（截图 `07-taskbar-no-widget.png`）。
- **Alt+Tab 切窗器**：真按 Alt+Tab 后截图，5 个条目全是别的窗口，**没有「快办」**（截图 `08-alttab-switcher.png`）。
- **窗口扩展样式**：`WS_EX_TOOLWINDOW` 在位（这是"不进任务栏 / 不进 Alt+Tab"的文档化依据）；同时我们发现并修掉了 `WS_EX_APPWINDOW` 与它打架的问题（见"发现的问题"第 4 条）。

### C 贴边 + 悬停展开 + 移开收起（Windows 复验）✅

| 内容 | 实测 |
|---|---|
| 精确贴边 | 挂件窗口物理矩形 **L=3330 T=660 R=3840 B=1500（510×840）**；右边缘 3840 **= 屏幕宽 3840**；垂直中心 660+420 = 1080 = 2160/2 ✅ |
| 窄条宽度 | 可见窄条占物理 x 3822–3840（12 逻辑 px × 1.5）✅ |
| 悬停展开 | 鼠标移到物理 (3830,1080)（可见窄条正中）→ 展开（`WS_EX_TRANSPARENT` 摘掉）✅ |
| 移开收起 | 移开后 **1.58s**（第一次）/ **1.63s**（第二次）收起 → 前端 1.5s 延迟 + 80ms 轮询，符合设计 ✅ |
| 📌 钉住 | 钉住后移开 2.5s 仍保持展开；再点一下取消钉住后移开正常收起 ✅ |
| Esc 收起 | 前端 `Escape`：输入框有焦点时先交还键盘焦点再收起 ✅ |

### D 收起状态下不挡其他窗口 ✅

用 `WindowFromPoint`（Windows 自己的命中测试，`WS_EX_TRANSPARENT` 会被跳过）探测挂件矩形内的两个点：

| 探测点（物理） | 收起态 | 展开态 |
|---|---|---|
| (3500,1310) 面板中部 | pid 8328 `Scintilla`（底下的编辑器）→ 穿透 ✅ | pid 11244 `Chrome_RenderWidgetHostHWND`，root = 挂件 ✅ |
| (3700,900) 面板上部 | pid 12008 `Chrome_RenderWidgetHostHWND`（底下的 DSH 窗口）→ 穿透 ✅ | root = 挂件 ✅ |

### E 输入框能正常打字 ✅

- 点输入框 → 挂件成为前台（预期的例外），扩展样式变为 `0x00000198`（**`WS_EX_NOACTIVATE` 已摘掉**）；
- 输入 `kuaiban-typing-ok` 回车 → 「今天」列表新增一条、角标 6→7、输入框清空（截图 `04-input-typing.png`、`05-input-added.png`）；
- 点回编辑器 → 扩展样式变回 `0x08000198`（**`NOACTIVATE` 已装回**），且**不是**卡在可激活状态（随后打字进编辑器）。

### F 系统托盘 ✅

| 内容 | 实测 |
|---|---|
| 图标存在 | UI Automation 找到 `SystemTray.NormalButton`，名称 **「快办」**，物理矩形 (3171,2002,60,60)，位于「隐藏的图标」面板内（截图 `09-tray-icon.png`） |
| 右键菜单 | 菜单项：**「显示 / 隐藏面板」**、**「退出快办」**（截图 `10-tray-menu.png`） |
| 显示 / 隐藏面板 | 点击后挂件面板状态确实切换 ✅ |
| 退出快办 | 点击后 `desktop.exe` 进程数 **1 → 0**，`pnpm dev` 任务以**退出码 0** 结束（干净退出，不是崩溃）✅ |
| 左键点图标 | 切换面板显示 / 隐藏 ✅ |

> 方法说明：本机 Win11 的托盘"隐藏的图标"是 XAML 岛浮层，**注入式鼠标点击（`mouse_event`）它不认**。
> 因此托盘部分的点击是通过 **UI Automation 的 Invoke / 聚焦后按"菜单键"** 完成的——效果与真人右键/左键一致，
> 但报告里如实标注：**没有用真实鼠标点过托盘图标**。

### G 高 DPI / 多显示器 ⚠️

| 内容 | 实测 / 说明 |
|---|---|
| 150% 缩放贴边 | ✅ **本机就是 150%**：窗口物理右边缘 = 3840 = 屏幕宽，窄条物理 x 3822–3840，垂直居中 |
| 150% 悬停命中 | ✅ 鼠标放在**可见窄条**上能展开（这里踩过一个坑：不同 pwsh 调用的 DPI 感知模式不同，早期脚本把坐标整体缩放了 1.5，导致"悬停可见窄条没反应"的假象；用 `GetPhysicalCursorPos` 自校正后确认代码本身没问题） |
| 100% / 125% | ❌ **未实测**。改缩放要动这台机器的系统显示设置（还可能要求注销），我没有擅自修改用户的环境。代码路径是按 `monitor.scale_factor()` 计算的（`x = 屏宽 − 面板宽×scale`），150% 已实机验证，100% 是它的退化情形；**125% 建议后续补一次** |
| 多显示器 | ❌ **无设备可测**（本机仅 1 台）。代码层注意点见"发现的问题"第 6 条 |

---

## 3. 代码改动

改动范围严格限制在"外壳层的平台桥接代码"里，**没有动 `docs/` 任何设计文档、没有动 README 架构描述、没有把 Windows 专属依赖加进跨平台 `[dependencies]`、也没有删掉任何"不抢焦点"逻辑**。

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| `apps/desktop/src-tauri/src/lib.rs` | ① 取 HWND 改走 `raw-window-handle`（`hwnd_of`）；② 新增 `set_activatable` 命令与 `set_activatable_inner`（动态摘/装 `WS_EX_NOACTIVATE`）；③ 扩展样式统一收敛到 `apply_non_activating`（`NOACTIVATE` / `TOOLWINDOW` / 清掉 `APPWINDOW`）；④ `WidgetState` 增加 `activatable`、`prev_foreground`；⑤ 面板收起时强制恢复"不抢焦点"；⑥ 80ms 轮询里加看门狗，兜底重装 `NOACTIVATE`；⑦ 注释写清为什么不能 `SetFocus` | 见"发现的问题"第 2、3、4 条 |
| `apps/desktop/src-tauri/Cargo.toml` | `windows` 0.58 → **0.62**（对齐 tauri 2.12 实际依赖的版本，+ `Win32_UI_Input_KeyboardAndMouse` feature）；`[target.'cfg(windows)'.dependencies]` 里新增 **`raw-window-handle = "0.6"`** | ①HWND 类型不再依赖版本一致；②不再同时编译两份 windows crate。**只加在 windows target 下** |
| `apps/desktop/src-tauri/Cargo.lock` | 依赖图更新（删掉 windows 0.58 子树、`desktop` 增加 raw-window-handle） | 随 Cargo.toml |
| `apps/desktop/src/App.vue` | **只为"输入框唤起焦点"加了必要逻辑**：`ref="draftEl"`、`@mousedown="grabKeyboard"`、`@blur="releaseKeyboard"`、面板收起时释放、Esc 时释放 | 尽量少改 vue（任务书要求） |
| `docs/windows-verify/`（新增） | 本报告 + 12 张实测截图 + 修正版截图脚本 | 交付物 |

### 3.1 关键实现：「不抢焦点」与「能输入」如何共存

```
平时（默认）：
  扩展样式 = WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | (LAYERED/TRANSPARENT 由 Tauri 管)
  → 点面板任何地方都不激活窗口、不夺走焦点；输入框打不了字（这是 NOACTIVATE 的代价）

用户点输入框（唯一触发点：前端的 @mousedown，不是 @focus）：
  Rust set_activatable(true)
    → 记住当前前台窗口（稍后归还）
    → 摘掉 WS_EX_NOACTIVATE
    → SetForegroundWindow(我们的窗口)          ← 只有这一步
    → 【不做】SetFocus(顶层 HWND)               ← 就是这一步会把 WebView2 拖进死循环

归还（三条路径，任一触发）：
  ① 输入框 @blur                → set_activatable(false)
  ② 面板收起 / Esc（Rust 强制）  → set_activatable_inner(false)
  ③ 80ms 轮询看门狗             → 只要 activatable == false 且 NOACTIVATE 不在位，就补上
  → 装回 WS_EX_NOACTIVATE；仅当焦点仍在自己身上时，才把前台还给之前那个窗口
```

三次实测验证了"绝不卡在可激活状态"：点回编辑器后 800ms 内 `NOACTIVATE` 已恢复、随后打字进编辑器（文件追加 `KB-A3`）。

### 3.2 新增依赖

- `raw-window-handle = "0.6"`（仅 `cfg(windows)`）——本就在依赖树里（tauri/wry 用 0.6.2），不增加编译量；
- `windows` 0.58 → 0.62 —— 版本对齐后**少编译一份 windows crate**。

### 3.3 commit

见文末"分支与提交"。

---

## 4. 发现的问题与建议

### 1）任务书 6.1 的假设不成立：原代码在 Windows 上**能编译**

原假设："`window.hwnd()` 返回的 HWND 与 Cargo.toml 里 windows crate 版本不是同一个类型 → 大概率编译不过"。

**实测：能编过。** 把 `main` 那版 `lib.rs` + `Cargo.toml` 原样还原后 `cargo check`：

```
Compiling desktop v0.1.0 (F:\kuaiban\apps\desktop\src-tauri)
Finished `dev` profile [unoptimized + debuginfo] target(s) in 24.85s
（error 0 条、warning 0 条）
```

原因：原代码写的是 `HWND(handle.0 as _)` —— 它先取 tauri 那份 `windows`（0.62）的 `HWND` 的裸指针字段，
再用 `as _` 转成本 crate（0.58）`HWND` 的字段类型，跨版本被"硬转"绕过去了。

**仍然改了，但理由不同**：这等于把"两个 crate 版本里 `HWND` 都是 `pub *mut c_void`"当成隐含契约，
而且会同时编译两份 windows crate。改成 `raw-window-handle` + 版本对齐 0.62 之后，
HWND 的获取与 crate 版本无关，依赖树也少一份。**结论是"加固"，不是"修复编译错误"。**

### 2）6.2 确认：`WS_EX_NOACTIVATE` 让输入框彻底打不进字 —— 且"顺手补 SetFocus"会引发死循环

- 确认：带着 `WS_EX_NOACTIVATE` 时，点输入框能拿到 DOM focus（有焦点圈、有光标），但**键盘输入全部丢失**（第一轮实测：输入的内容没进输入框，反而落到了底下的编辑器里）。
- **踩到的真实大坑**：一开始的写法是"摘掉 `NOACTIVATE` + `SetForegroundWindow` + `SetFocus(顶层 HWND)`"，前端在 `@mousedown` 和 `@focus` 两处都申请激活。结果：

```
[fe] grab(mousedown)
[fe] grab(focus-event)
[dbg] true  prev_fg=0x1602AA setfg_ok=true fg_after=0xA0676 self=0xA0676
[fe] release(blur)
[widget] 已把焦点还给上一个窗口
[dbg] false fg_now=0xA0676 self=true
[fe] grab(focus-event)          ← 又来了
[dbg] true  ...
[fe] release(blur)
...（每秒上千次，日志被刷爆，键盘输入全丢）
```

成因链：**`SetFocus(顶层窗口)` 会把 WebView2 子窗口的焦点顶掉 → 输入框立刻 `blur` → 前端释放激活 → 挂件失活 → WebView2 让输入框重新 `focus` → `@focus` 监听又申请激活 → 回到第一步**。
两个动作合起来构成闭环。

**最终方案（已写入代码注释）**：只 `SetForegroundWindow`，**不** `SetFocus`；**激活只由"点输入框"这个显式动作驱动，不由 focus 事件驱动**。
修好后日志里一次点击只有一行 `[widget] 输入框取得键盘焦点`，输入框正常收字。

> 留给 macOS 侧的一句话：`set_activatable` 这条命令在 macOS 上是空操作（`ActivationPolicy::Accessory` 已够用），
> **不要在 macOS 上照抄"focus 事件触发激活"**，同一个坑在别的平台换个形式还会出现。

### 3）建议把"申请键盘焦点"收进平台桥接层，别让界面层直呼平台命名命令

现在 `App.vue` 里直接 `invoke("set_activatable", …)` —— 名字里就带着"激活"这种 Windows 概念。
按四层架构的本意，界面层不该知道平台细节。建议后续加一层薄封装（如 `apps/desktop/src/bridge/window.ts`），
UI 只调 `requestKeyboardFocus()` / `releaseKeyboardFocus()`，由桥接层按平台决定怎么实现（Windows 切 `WS_EX_NOACTIVATE`，macOS 空操作，将来 Linux 再说）。
本次为了"尽量少改 vue + 不动架构"没有顺手做，**留给 macOS 侧决定**。

### 4）任务栏：`WS_EX_APPWINDOW` 与 `WS_EX_TOOLWINDOW` 同时在位（已修）

实测窗口扩展样式原本是 `0x080C01B8`，同时含 `WS_EX_TOOLWINDOW` **和** `WS_EX_APPWINDOW`。
根因：tao 创建窗口时按 `WindowFlags` 会带上 `APPWINDOW`（`tao/src/platform_impl/windows/window_state.rs:255`），
而 Tauri 的 `skipTaskbar: true` 是在窗口创建后调 **`ITaskbarList::DeleteTab`** 把按钮摘掉（`tao/.../window.rs:1543`）——**位还留着**。
两条路各有各的脾气（`DeleteTab` 只是 shell 层的"请摘掉"，explorer 重启等场景下有可能被重新画出来；tao 自己也为此专门处理了 `S_U_TASKBAR_RESTART`）。

现在 `apply_non_activating` 里统一把 `WS_EX_APPWINDOW` 摘掉、`WS_EX_TOOLWINDOW` 补上（Windows 上"托盘常驻窗口"的标准做法），
实测样式变为 `0x080801B8`（TOPMOST|TRANSPARENT|TOOLWINDOW|NOACTIVATE|LAYERED），任务栏按钮确实不存在（UIA 复核）。

### 5）悬停命中区是"整个窗口高度"，不是"看得见的窄条"

Rust 侧命中区是窗口最右侧 12 逻辑 px、**纵向覆盖整个窗口（560 逻辑 px，约占屏幕 80%）**；
而可见窄条只有 152 逻辑 px 高。也就是说：**在屏幕最右边缘、窄条上下方那些"什么都没有"的位置悬停，面板也会滑出来**。
macOS 注释说这是刻意的"更宽的命中区"。这属于产品手感问题，**不是 bug**，但值得和 macOS 侧确认要不要收紧到可见窄条的高度（否则用户可能在"空白处"被突然弹出的面板吓到）。

### 6）多显示器 / 显示器变化：只做了一次性布局，未尽事宜

`apply_layout` 只在启动时跑一次，用的是 `current_monitor()` 或 `primary_monitor()`：

- 单显示器（本机）没问题；
- 多显示器下，窗口创建后（还没定位）的"当前显示器"未必是用户想要的那块；**没有**处理"显示器拔插 / 分辨率变化 / 缩放变化"；
- 悬停判定用的是窗口自身的 `outer_position/size`，**在同一块显示器内是自洽的**，但窗口若被移到另一块屏幕，窄条仍然贴的是"当前窗口所在屏的右边缘"（行为可接受，但需要明确）。

建议：把 `apply_layout` 挂到"显示器变化"事件上（Tauri 有 `on_window_event` / monitor 相关 API），并明确"挂件跟随哪块屏"的产品规则。**本次没有实现**（超出外壳验证范围，且本机无法验证）。

### 7）托盘唤起的面板不会自动收起（小）

从托盘菜单点「显示面板」时，鼠标并没有"进入过窗口"，所以前端收不到 `mouseleave`，**1.5 秒自动收起不会触发**，面板会一直开着，直到用户把鼠标划过面板再移开，或再用托盘菜单隐藏。
可以理解为"托盘显式显示 = 一直显示"，但它和"平时不烦你"的定位略有张力。建议 macOS 侧统一一下语义（要么显式显示即钉住并在标题栏体现，要么显式显示后也走一遍自动收起计时）。

### 8）给 macOS 侧的其它同步建议

- 本次唯一的界面改动是"输入框唤起焦点"，**没有碰任何业务/布局代码**；`App.vue` 的假数据、样式都没动。
- `.vue` 里 `@mousedown` + `@blur` 的成对写法建议保留（Windows 必需）；如果将来做平台桥接层，直接搬过去即可。
- 截图脚本建议用本目录的 `shot.ps1`（附录 A 那版在 150% + 硬件合成下会截丢挂件）。
- 本机 `notepad.exe` 被 IFEO 重定向到 Notepad2，如果你按任务书用记事本复现，看到 Notepad2 是正常的。

---

## 5. 附：证据文件清单

| 文件 | 内容 |
|---|---|
| `01-collapsed-strip.png` | 全屏（物理 3840×2160）：挂件收起，右边缘一条窄条 |
| `01b-strip-detail.png` | 窄条放大：可见角标「6」，紧贴物理右边缘 |
| `02-expanded-panel.png` / `02b-panel-detail.png` | 悬停后展开的面板（150% 缩放下文字清晰） |
| `03-focus-notepad-active.png` | **A 项对照**：面板开着、刚勾选完待办，编辑器仍是前台窗口 |
| `04-input-typing.png` | **E 项**：输入框里成功输入文字 |
| `05-input-added.png` | **E 项**：回车后新待办进入「今天」列表，角标 +1 |
| `06-pinned.png` | 📌 钉住状态 |
| `07-taskbar-no-widget.png` | **B 项**：任务栏（含托盘区），没有「快办」按钮 |
| `08-alttab-switcher.png` | **B 项**：真按 Alt+Tab 的切窗器，5 项里没有「快办」 |
| `09-tray-icon.png` | **F 项**：托盘图标「快办」 |
| `10-tray-menu.png` | **F 项**：右键菜单「显示 / 隐藏面板」「退出快办」 |
| `shot.ps1` | 修正版截图脚本（DPI 感知 + CAPTUREBLT） |
