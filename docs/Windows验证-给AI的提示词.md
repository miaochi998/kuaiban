# 给 Windows 侧 AI 的提示词

> 用途：在 Windows 开发机上验证并修复「快办」挂件的外壳行为。
> 把下面「提示词正文」整段复制给 Windows 机器的 DSH 新对话即可。

---

## 提示词正文（从这里开始复制）

# 任务：在 Windows 上验证并修复「快办」桌面挂件的外壳行为

## 0. 你的身份与最终目标

你是「快办」项目在 Windows 侧的开发代理。项目在 macOS 侧已完成挂件原型，
现在需要你在这台 Windows 机器上**验证并修复 Windows 专属的系统行为**，
最后把修复推回仓库的一个分支，并输出结构化报告。

**成功标准**：第 5 节验证清单**全部通过**；若有做不到的项，必须如实说明原因，
而不是假装通过。

---

## 1. 项目背景（30 秒读懂）

「快办」是一个给"自制力差、记忆力差、做事没条理"的人用的桌面待办工具。
一句话定位：**一个会自己记着事、到点会喊你、平时不烦你的桌面小挂件。**

产品形态：
- 平时缩在**屏幕最右侧**，只露一条约 12px 宽的窄条 + 未完成数量角标
- 鼠标悬停 → 面板滑出；鼠标移开 1.5 秒 → 自动收起
- 面板内容是"今天清单"：昨日未完成 / 今天 / 已完成 / 快速输入
- **绝不抢焦点**：用户点挂件时，不能打断他正在打字的窗口
- 到点提醒、托盘常驻、开机自启（提醒与自启本次不涉及）

技术架构（**必须遵守**）：
- 四层：界面层 / 大脑层 / 平台桥接层 / 外壳层
- **铁律：业务逻辑（大脑层）里绝不允许出现任何平台专属代码。**
- 你这次的工作**全部**属于"外壳层"的平台桥接代码，
  这是整个项目唯一允许写平台代码的地方。

先读这两个文档再动手：
- `docs/技术选型-v0.1.md` —— 第 2 节四层架构与铁律、第 3.1 节 Windows 能力清单
- `README.md` —— 项目结构与当前进度

---

## 2. 第一步：拿到代码

仓库：`github.com/miaochi998/kuaiban`（**私有仓库**）

在当前项目目录里克隆：

```
gh repo clone miaochi998/kuaiban .
```

如果失败，按顺序尝试：

1. `gh auth status` —— 若已登录且有该仓库权限 → 用 `gh repo clone`
2. `ssh -T git@github.com` —— 若返回成功问候 → 用 `git clone git@github.com:miaochi998/kuaiban.git .`
3. 都不可用 → **停下来**，给用户一条可直接复制的命令（`gh auth login`），
   并说明这是本次唯一需要他操作的一步（一次性 GitHub 登录）。
   **不要用其他方式绕过，也不要改仓库可见性。**

拿到代码后建分支：

```
git checkout -b feat/windows-shell-verify
```

---

## 3. 第二步：准备 Windows 开发环境

先**逐项检测**，缺什么装什么（优先用 winget）：

| 组件 | 检测 | 安装 |
|---|---|---|
| Node ≥ 20 | `node -v` | `winget install OpenJS.NodeJS.LTS` |
| pnpm | `pnpm -v` | `corepack enable` 或 `npm i -g pnpm` |
| Rust（MSVC） | `rustc --version`；`rustup target list --installed` 应含 `x86_64-pc-windows-msvc` | `winget install Rustlang.Rustup`，再 `rustup default stable-msvc` |
| MSVC C++ 生成工具 | 检查 VS Build Tools | `winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` |
| WebView2 Runtime | Win11 与多数 Win10 自带 | `winget install Microsoft.EdgeWebView2Runtime` |
| Git | `git --version` | `winget install Git.Git` |

> 注意：装完 MSVC Build Tools 和 Rust 后可能需要**重开终端**才生效。

---

## 4. 第三步：编译并跑起来

```
pnpm install
pnpm dev
```

`pnpm dev` 会：启动 Vite（端口 1420）→ 编译 Rust → 弹出挂件窗口。
首次编译 Rust 需要几分钟。报错见第 6 节。

---

## 5. 第四步：验证清单（本次任务的核心）

逐项**实测**，每项给出"通过 / 不通过 + 实测依据"。建议截图佐证（脚本见附录 A）。

### A. 不抢焦点【最高优先级】

测法：
1. 打开记事本，输入几个字（让光标闪在记事本里）
2. 鼠标移到屏幕最右侧窄条 → 面板展开
3. **点击面板空白处、勾选一条待办、点一下输入框**
4. 回头看记事本：标题栏是否仍是激活色？光标是否还在闪？
5. 直接在键盘上打字

预期：**焦点全程没被抢走**，打字仍然进入记事本。
不通过的表现：记事本标题栏变灰、或打字没反应。

### B. 不占任务栏

- 任务栏上**不应**出现快办图标
- `Alt+Tab` 列表里**不应**出现快办

### C. 贴边 + 悬停展开 + 移开收起（Windows 复验）

- 窄条紧贴屏幕**最右侧**、垂直居中
- 悬停 → 面板滑出；移开 → 1.5 秒后收起
- 点 📌 → 钉住不收起

### D. 收起状态下不挡其他窗口

- 收起时，把鼠标移到屏幕最右侧，滚轮/点击应作用在**底下的窗口**上，
  而不是被挂件吞掉

### E. 输入框能正常打字【很可能不通过，见 6.2】

- 点击面板底部输入框 → 能输入中英文 → 回车能新增一条

### F. 托盘

- 托盘有图标，右键有「显示 / 隐藏面板」「退出快办」，点退出能真正退出

### G. 高 DPI / 多显示器（有条件就测）

- 系统缩放非 100%（125% / 150%）时，窄条是否仍**精确贴住屏幕右边缘**？
- 有第二块显示器时，如实报告现状即可（**不要求实现**多屏跟随）

---

## 6. 第五步：修复 Windows 专属代码

相关代码全部在 `apps/desktop/src-tauri/src/lib.rs`，
标了 `#[cfg(windows)]` 的 `make_non_activating` 函数及相关部分。

### 6.1 问题一：这段代码从未在 Windows 上编译过

写它的机器是 macOS，而 `#[cfg(windows)]` 的代码在 macOS 上会被**完全跳过**。
所以**大概率编译不过**，这很正常，不要慌。

最可能的错误：`window.hwnd()` 返回的 `HWND` 与 `Cargo.toml` 里 `windows`
crate 版本的 `HWND` **不是同一个类型**（版本不一致导致类型不匹配）。

**推荐修法**（不依赖版本，最稳）——改用 `raw-window-handle`：

```rust
let handle = window.window_handle()?;          // tauri 实现了 HasWindowHandle
if let RawWindowHandle::Win32(h) = handle.as_raw() {
    let hwnd = HWND(h.hwnd.get() as *mut _);
    // ...
}
```

在 `[target.'cfg(windows)'.dependencies]` 里加 `raw-window-handle = "0.6"`。

另一条路是把 `windows` crate 版本对齐到 tauri 实际使用的版本
（`cargo tree -i windows` 可查）。两种都行，选能编过的。

### 6.2 问题二：WS_EX_NOACTIVATE 会让输入框完全打不了字【必须解决】

这是本次任务**最重要**的发现点。

`WS_EX_NOACTIVATE` 的作用就是"点击不激活窗口"，但代价是：
**这个窗口永远拿不到键盘焦点 → 底部"添加待办"输入框根本打不进字。**
而"随手记一条待办"是这个软件的核心功能，打不了字等于废了。

**期望解法（动态切换）**：
- 平时：挂件带 `WS_EX_NOACTIVATE`，点击不抢焦点（满足需求 A）
- 当用户**明确点击输入框**时：临时**移除** `WS_EX_NOACTIVATE`，
  并 `SetForegroundWindow(hwnd)` + `SetFocus(hwnd)`，让用户能输入
- 输入框失焦 / 面板收起 / 按 Esc 时：**恢复** `WS_EX_NOACTIVATE`

实现建议：
- Rust 侧加 Tauri command：`set_activatable(bool)`
- 前端在输入框 `focus` 时调 `set_activatable(true)`，`blur` 时调 `set_activatable(false)`
- 面板收起时也调 `set_activatable(false)`

**并且必须验证**：切到可激活状态后，用户去别的窗口打字**不会**被挂件抢走焦点
（即恢复要可靠，不能"卡"在可激活状态）。

如果你发现更好的做法（例如精细控制 `WM_MOUSEACTIVATE` 返回 `MA_NOACTIVATE`），
可以用，但必须在报告里说明为什么更好。

---

## 7. 硬性边界（不允许突破）

- ✅ 可以改：`apps/desktop/src-tauri/` 下的代码、`[target.'cfg(windows)'.dependencies]`
- ⚠️ 尽量少改：`apps/desktop/src/*.vue`（只允许为"输入框唤起焦点"加必要逻辑）
- ❌ 不允许改：`docs/` 下任何设计文档、README 的架构描述
- ❌ 不允许突破"平台代码只能待在平台桥接层"这条铁律
- ❌ 不允许把 Windows 专属依赖加到跨平台 `[dependencies]`
- ❌ 不允许为了"让它通过"而删掉不抢焦点的逻辑

如果某个需求在 Windows 上**确实做不到**，不要硬凑 —— **如实报告**，
并给出替代方案的取舍分析。这比"假装通过"有价值得多。

---

## 8. 交付物

### 8.1 结构化报告

按下面格式输出：

```
## Windows 挂件验证报告

### 环境
- Windows 版本 / 架构：
- 缩放比例（100% / 125% / 150%）：
- 显示器数量：
- Node / pnpm / Rust 版本：

### 验证结果
| 项 | 结果 | 实测依据 | 备注 |
|---|---|---|---|
| A 不抢焦点 | | | |
| B 不占任务栏 | | | |
| C 贴边/悬停/收起 | | | |
| D 收起不挡窗口 | | | |
| E 输入框可打字 | | | |
| F 托盘 | | | |
| G 高DPI/多显示器 | | | |

### 代码改动
- 改了哪些文件、为什么
- 关键实现（"不抢焦点"与"可输入"如何共存）
- 新增依赖
- commit hash

### 发现的问题与建议
（性能、动画流畅度、手感、DPI，以及任何你认为 macOS 侧需要同步修改的地方）
```

### 8.2 推送分支

```
git add -A
git commit -m "fix(windows): 验证并修复挂件外壳行为（不抢焦点 / 可输入 / 任务栏）"
git push -u origin feat/windows-shell-verify
```

推送后在报告里写明**分支名 + commit hash**，方便 macOS 侧 review 后合并。

### 8.3 截图

关键截图保存到 `docs/windows-verify/` 并一起提交，至少包含：
- 收起状态的窄条
- 展开的面板
- 不抢焦点的对照截图（记事本仍是激活状态）

---

## 9. 如果卡住了

- **编译错误**：优先解决；用 `cargo tree -i windows` 查版本冲突
- **装不上 MSVC / Rust**：报告具体报错，不要反复重试同一条命令
- **不抢焦点做不到**：这是关键决策点，停下来详细报告现象与分析
- **感觉方案要变**：先报告，不要擅自改架构

---

## 附录 A：PowerShell 截图脚本

```powershell
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$dir = "docs\windows-verify"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$bmp.Save("$dir\shot-$(Get-Date -Format 'HHmmss').png")
$g.Dispose(); $bmp.Dispose()
Write-Host "已保存到 $dir"
```

## 附录 B：本次涉及的关键文件

| 文件 | 作用 |
|---|---|
| `apps/desktop/src-tauri/src/lib.rs` | 挂件外壳：布局、悬停轮询、展开收起、托盘、不抢焦点 |
| `apps/desktop/src-tauri/tauri.conf.json` | 窗口配置：无边框、透明、置顶、skipTaskbar |
| `apps/desktop/src/App.vue` | 面板界面（原型，假数据） |
| `docs/技术选型-v0.1.md` | 架构与选型（第 2 节铁律、第 3.1 节 Windows 能力） |

## 附录 C：macOS 侧已经验证通过的行为（你只需复验，不必重新设计）

- 无边框 + 透明窗口、贴屏幕右边缘、垂直居中
- 收起时只露 12px 窄条 + 未完成数量角标
- 悬停展开（Rust 侧 80ms 轮询鼠标坐标，因为收起时鼠标穿透收不到事件）
- 移开 1.5 秒后收起（前端 mouseleave 延迟）
- 收起时鼠标穿透（`set_ignore_cursor_events(true)`）
- 📌 钉住 / 取消钉住、Esc 收起
- 系统托盘 + 右键菜单、关闭窗口只隐藏不退出
- 前端产物仅 68.8KB JS + 4.2KB CSS

（提示词正文到此结束）
