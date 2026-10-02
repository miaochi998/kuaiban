# 项目持久记忆 Project Memory

> 本文件由 dsh-memoir 插件维护：记录本项目历次会话的工作归纳、经验教训与行动指南，
> 作为未来 AGENTS 接手本项目时的行动指南；它是人类可读的投影，不是 system prompt 的完整注入内容。
> 新会话只注入有界的 Hot Memory，完整历史通过 memoir_read 按需检索。

## 工作记录 Work Log

- [2026-10-03 00:06] [工作记录] 快办（KuaiBan）业务逻辑设计 v0.2 定稿候选 — 项目：KUAIBAN 桌面待办清单工具。用户不懂编程，当前处于业务逻辑讨论阶段，尚未开始编码。

已确认的关键决策（用户逐条选择）：
1. 部署形态：从"纯本地单机"变更为【客户端 + 公司公网服务器 + 管理后台】三部分。公司有公网域名+HTTPS，可跑 Docker/Node。
2. 用户范围：全公司使用，50 人以内，每人数据独立互不可见，【不做共享待办】。
3. 账号：无注册功能，管理员手工建号（登录名+姓名+初始密码），首次登录强制改密，之后【永久记住登录】。忘记密码找管理员重置，错5次锁15分钟。
4. 隐私铁律：管理员只能管账号，【不能查看任何用户的待办内容】。理由是员工若知道能被翻就不会记真话。
5. 平台路线：先做 Windows，之后 macOS → Android → 鸿蒙 → iOS。架构必须【大脑/同步层/外壳 三层分离】，大脑与同步层全平台共用。
6. 逾期处理：昨日未完成自动带入今天清单顶部「昨日未完成(N)」区域，累计顺延次数，≥3次时提示改期/拆分/放弃。
7. 提醒：三级递进（L1闪动+响一声不抢焦点 → L2一分钟后气泡：完成/推后10分/推后1小时/今天不再提醒 → L3只累积角标）。多件事同时到点必须【合并为一条提醒】。
8. 重复任务：第一版支持 每天/每周/每月/工作日；用到时才生成实例；勾选只完成本次；编辑统一"改整个系列"。
9. 随笔：作为待办暂存区(Inbox)，日期为空即入随笔区，可一键"排期"转待办。全局快捷键 Ctrl+Alt+Q 极速捕获。
10. 一天的起点：凌晨 04:00（便于熬夜用户）。
11. 免打扰：默认 22:00–07:00，只闪图标不响不弹。
12. 桌面挂件：鼠标悬停展开，移开【延迟1.5秒】收起，输入时不收起，单击可钉住常显。不抢焦点、不占任务栏。
13. 升级：客户端自动更新（启动检查+静默下载+重启生效），服务器地址内置在安装包内。
14. 服务端刻意做"笨"：只做认证/存数据/增量同步/判冲突，不含业务逻辑。冲突规则：后改的赢、删除优先。
15. 离线优先：断网必须照常可用，本地先写，联网补传，挂件显示同步状态点。

产出文档：docs/快办-业务逻辑设计-v0.1.md（单机版，已过时）、docs/快办-业务逻辑设计-v0.2.md（当前权威版本）。

待确认：管理员是否需备用、服务器域名是否已有、停用账号数据保留期、提醒声音方案、是否先小范围试用。
- [2026-10-03 00:16] [工作记录] 快办技术选型：Tauri 2 + TypeScript + Web UI 四层架构 — 技术选型结论（docs/技术选型-v0.1.md）：

【核心结论】TypeScript + Web技术(Vue3+Vite)写界面 + Tauri 2 做外壳 + Node/Fastify/PostgreSQL 做服务端。pnpm monorepo 组织。

【四层架构】①界面层(Vue3，5平台共用) ②大脑层(纯TS零平台依赖，100%复用) ③平台桥接层(统一接口，各平台实现) ④外壳层(Tauri)。服务端与大脑同语言。

【铁律】packages/core 内绝对不允许出现任何平台专属代码，不许 import 窗口/托盘/通知/文件系统/HTTP。所有平台能力通过接口注入。检验方法：大脑包能在纯 Node 环境跑单测不报平台错误。守住这条铁律，将来加平台最坏也只是"重写外壳"。

【关键情报（已联网核实 2026-10）】
1. Tauri 有可行鸿蒙路径：社区分支 richerfu/tauri 的 feat/open-harmony，原理是 Rust 交叉编译成 .so → 前端零改动塞 rawfile → DevEco 工程壳 → HAP。2026-08 有完整实战记录(cnblogs qq8864 文章，含12条避坑清单)。官方 tauri issue #11112 跟踪但无官方支持。
2. uni-app x 从 4.61+ 官方支持纯血鸿蒙 NEXT（编译为 ArkTS），HBuilderX 4.71+ 支持鸿蒙PC；但官方自述"鸿蒙处于发展初期，能用，有坑，应降低期望"。致命短板：**无桌面端**，做不了贴边挂件。
3. Electron 无鸿蒙、无移动端。

【选择理由】Tauri 是唯一"桌面能力够用+能上移动端+鸿蒙有活路+体积小(5-15MB)"的方案。Flutter 能覆盖5平台但桌面挂件靠第三方插件硬撑且是Dart；uni-app x 鸿蒙最好但做不了桌面；Electron 桌面最舒服但上不了手机。

【Windows 挂件待用能力】无边框贴边(tauri decorations:false+transparent+always_on_top)、skip_taskbar、不抢焦点(Rust设 WS_EX_NOACTIVATE，隔离在桥接层)、set_ignore_cursor_events、tauri-plugin-{tray,autostart,notification,global-shortcut,sql,updater}。唯一需写Rust处是"不抢焦点"窗口行为。

【服务端】Node20+ / Fastify / PostgreSQL / Drizzle ORM / JWT长效令牌 / Docker Compose / Caddy自动HTTPS(消灭证书过期风险)。管理后台复用Vue3，接口层不提供查看用户待办内容的能力。

【monorepo结构】packages/{core,shared,ui} + apps/{desktop,server,admin} + docs。

【风险与回退】所有回退方案都是"换外壳"（如Tauri挂件做不出→换Electron），因为界面是Web、大脑是纯TS，业务代码不会白写。

【待解决现实问题】开发机是 Mac(M1)，但第一版目标 Windows。贴边/不抢焦点/托盘/自启在Mac上验证不了。建议：Mac日常开发 + Windows虚拟机(Parallels/UTM)快速验证 + 真Windows机做版本验收。

【下一步】最大技术风险是"Windows贴边挂件+不抢焦点"，应最先做最小原型验证而非最后。
- [2026-10-03 00:33] [工作记录] 快办挂件原型跑通（commit 266bf14） — 里程碑：Windows/macOS 挂件原型完成并跑通（commit 266bf14，已推送 GitHub 私有仓库 miaochi998/kuaiban）。

【仓库】https://github.com/miaochi998/kuaiban （私有）。本地 /Volumes/zhangchi/Development/project/nodejs/KUAIBAN。远程用 SSH（git@github.com:miaochi998/kuaiban.git），本机 gh CLI 已登录 miaochi998 且 SSH key 可用。

【已完成的技术骨架】
- pnpm monorepo：根 package.json（packageManager pnpm@10.23.0）、pnpm-workspace.yaml（apps/*, packages/*）
- apps/desktop：Tauri 2 + Vue 3 + Vite + TS，包名 @kuaiban/desktop
- 根脚本：pnpm dev = pnpm --filter @kuaiban/desktop tauri dev

【挂件原型的核心设计（重要，后续沿用）】
1. 窗口始终保持展开尺寸（340 x min(560, 屏高80%)），**不做窗口 resize**。收起靠 CSS translateX(100%) 滑出 + Rust 侧 set_ignore_cursor_events(true) 鼠标穿透 → 动画平滑、无缩放抖动、不挡其他窗口。
2. 收起时鼠标穿透 → 收不到 mouseenter 事件 → **悬停判定必须用轮询**：Rust 线程每 80ms 读 app.cursor_position() + window.outer_position()/outer_size()，命中窗口最右侧 12px 窄条即展开。
3. 收起由前端负责：documentElement 的 mouseleave/mouseout + 1500ms 延迟；pinned 时不收起。Rust 侧只管"展开"。
4. 状态唯一事实来源在 Rust（WidgetState：AtomicBool expanded/pinned），前端通过 invoke("get_status") + listen("widget:state") 同步。
5. Windows「不抢焦点」：#[cfg(windows)] 用 windows crate 的 GetWindowLongPtrW/SetWindowLongPtrW 设 WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW，通过 window.hwnd() 拿 HWND。
6. macOS：ActivationPolicy::Accessory 隐藏 Dock 图标；透明窗口需要 tauri features 加 "macos-private-api"（同时 tauri.conf.json 的 app.macOSPrivateApi: true，否则 build script 报 feature 不匹配）。
7. 托盘：tauri features ["tray-icon","image-png"]，TrayIconBuilder + MenuBuilder，用 app.default_window_icon()。关闭窗口用 api.prevent_close() 只隐藏不退出。
8. 构建结果：前端 68.8KB JS + 4.2KB CSS。

【环境】macOS arm64，Rust 1.99.0 已装在 ~/.cargo（PATH 需 export PATH="$HOME/.cargo/bin:$PATH"）。Node v24.11.1、pnpm 10.23.0。screencapture 因缺屏幕录制权限不可用，无法自动截图验证 UI。

【待办】Windows 真机验证 WS_EX_NOACTIVATE（不抢焦点）与不占任务栏；这两项 Mac 上无法验证。后续需建 packages/core（大脑，零平台依赖铁律）、packages/shared、apps/server、apps/admin。
- [2026-10-03 00:38] [工作记录] Mac 挂件验收通过；Windows 验证任务提示词已下发 — 【Mac 侧验收结论】用户在真机（macOS arm64）确认挂件原型体验良好，行为与设计一致：贴右边、悬停展开、移开 1.5 秒收起、鼠标穿透、📌 钉住、托盘菜单、Dock 无图标、输入框可输入。（不抢焦点/不占任务栏属 Windows 专属，Mac 上未验证也无法验证。）

【已交付】docs/Windows验证-给AI的提示词.md —— 可直接整段复制给 Windows 机器 DSH 新对话的自包含提示词。内容含：环境准备（winget 装 Node/pnpm/Rust-msvc/MSVC Build Tools/WebView2/Git）、编译运行、7 项验证清单（A不抢焦点 / B不占任务栏 / C贴边悬停收起 / D收起不挡窗口 / E输入框可打字 / F托盘 / G高DPI多显示器）、两个已知问题及修法、硬性边界、结构化报告格式、PowerShell 截图脚本。

【约定】Windows 侧在分支 feat/windows-shell-verify 上工作并推送，Mac 侧 review 后合并，避免与 main 冲突。截图存 docs/windows-verify/。

【约束】仓库 github.com/miaochi998/kuaiban 为私有仓库，Windows 机器首次访问需一次性 `gh auth login`（本流程中唯一需用户动手之处）。

【下一步】用户把 Windows 侧产出的《Windows 挂件验证报告》贴回 Mac 对话 → review 分支并合并 → 按真机手感调参（窄条宽度/收起延迟/面板宽度/DPI）→ 再开始建 packages/core（大脑）。归档：Mac 侧挂件仍在后台运行（后台 job bash-35，PID 78982），可用 job_kill 停止。

## 经验教训 Lessons Learned

- [2026-10-03 00:38] [经验教训] Windows 挂件：WS_EX_NOACTIVATE 与输入框不可输入的根本冲突及动态切换解法 — 【问题】Windows 上用 WS_EX_NOACTIVATE 实现「点击不抢焦点」时，窗口永远拿不到键盘焦点 → 挂件内的文本输入框完全无法输入。对「随手记一条待办」这类核心功能是致命的，属于需求内部矛盾。

【结论】不能一刀切常驻 WS_EX_NOACTIVATE，必须动态切换：
- 默认：带 WS_EX_NOACTIVATE（点击不抢焦点）
- 用户明确点击输入框时：临时移除 WS_EX_NOACTIVATE + SetForegroundWindow + SetFocus
- 输入框失焦 / 面板收起 / 按 Esc：恢复 WS_EX_NOACTIVATE
- Rust 侧提供 set_activatable(bool) command，前端在 input focus/blur 时调用
- 必须验证「恢复可靠」，不能卡在可激活状态而互相抢焦点

【适用范围/否定条件】仅 Windows 桌面挂件形态；macOS 用 ActivationPolicy::Accessory 不涉及此冲突。替代做法是精细控制 WM_MOUSEACTIVATE 返回 MA_NOACTIVATE，但需评估。

【关联的通用教训】#[cfg(windows)] 的代码在 macOS 上会被完全跳过、永不参与编译。在 Mac 上写 Windows 专属代码 = 未经验证的代码，必须安排真机编译验证。已知易错点：window.hwnd() 返回的 HWND 与自备 windows crate 版本的 HWND 常为不同类型（版本不一致 → 类型不匹配）；稳妥修法是改用 raw-window-handle 取 RawWindowHandle::Win32(h) 再 HWND(h.hwnd.get() as *mut _)，或把 windows crate 版本对齐 tauri 实际使用版本（cargo tree -i windows 查）。
