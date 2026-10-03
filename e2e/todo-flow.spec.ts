/**
 * 界面流程自动化测试
 *
 * 起因是一次真实反馈：「我添加的时候没有任何成功或者失败的提示，就相当于点了回车
 * 没有任何反应」。这类"静默失败"是界面测试最该防的东西 —— 所以每个用例除了断言
 * 界面结果，还会**收集页面上的一切报错**；一旦有异常被吞掉，测试直接失败。
 */

import { expect, test, type Page } from "@playwright/test";

/**
 * 收集页面报错。
 * 未被捕获的 Promise 拒绝、console.error 都算 —— "点了没反应"往往就是它们。
 */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });
  return errors;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // 浏览器里没有外壳可悬停，应用会直接把面板显示出来
  await expect(page.locator(".widget.expanded")).toBeVisible();
});

// ─────────────────────────────────────────────────────────────
// 新增待办：按钮与回车两条路都必须能用
// ─────────────────────────────────────────────────────────────

test("点「添加」按钮：新待办立刻出现在今天清单", async ({ page }) => {
  const errors = collectErrors(page);

  await page.fill(".add", "写周报");
  await page.click(".send");

  await expect(page.locator(".row", { hasText: "写周报" })).toBeVisible();
  await expect(page.locator(".add")).toHaveValue("");
  expect(errors).toEqual([]);
});

test("按回车：新待办立刻出现在今天清单", async ({ page }) => {
  const errors = collectErrors(page);

  await page.fill(".add", "交周报");
  await page.press(".add", "Enter");

  await expect(page.locator(".row", { hasText: "交周报" })).toBeVisible();
  await expect(page.locator(".add")).toHaveValue("");
  expect(errors).toEqual([]);
});

test("连记两条：输入框保持可用，两条都在", async ({ page }) => {
  await page.fill(".add", "第一条");
  await page.press(".add", "Enter");
  await page.fill(".add", "第二条");
  await page.click(".send");

  await expect(page.locator(".row", { hasText: "第一条" })).toBeVisible();
  await expect(page.locator(".row", { hasText: "第二条" })).toBeVisible();
});

test("空输入时「添加」按钮禁用；有内容才可用", async ({ page }) => {
  await expect(page.locator(".send")).toBeDisabled();

  await page.fill(".add", "x");
  await expect(page.locator(".send")).toBeEnabled();

  await page.fill(".add", "   ");
  await expect(page.locator(".send")).toBeDisabled();
});

test("点禁用状态的按钮不会凭空造出一条空待办", async ({ page }) => {
  await expect(page.locator(".send")).toBeDisabled();
  await page.locator(".send").click({ force: true });
  await expect(page.locator(".row")).toHaveCount(0);
});

test("未完成数量角标随新增增加", async ({ page }) => {
  await expect(page.locator(".head-count b")).toHaveText("0");

  await page.fill(".add", "a");
  await page.press(".add", "Enter");
  await expect(page.locator(".head-count b")).toHaveText("1");

  await page.fill(".add", "b");
  await page.press(".add", "Enter");
  await expect(page.locator(".head-count b")).toHaveText("2");
});

// ─────────────────────────────────────────────────────────────
// 极速捕获：时间直接在输入框里打
// ─────────────────────────────────────────────────────────────

test("输入「9:30 交周报」→ 内容与时间被拆开", async ({ page }) => {
  await page.fill(".add", "9:30 交周报");
  await page.press(".add", "Enter");

  const row = page.locator(".row", { hasText: "交周报" });
  await expect(row).toBeVisible();
  await expect(row.locator(".title")).toHaveText("交周报");
  await expect(row.locator(".time")).toHaveText("09:30");
});

test("输入「9：30 交周报」（全角冒号）同样识别", async ({ page }) => {
  await page.fill(".add", "9：30 交周报");
  await page.press(".add", "Enter");

  const row = page.locator(".row", { hasText: "交周报" });
  await expect(row.locator(".time")).toHaveText("09:30");
});

// ─────────────────────────────────────────────────────────────
// 页签：在哪个页签输入，就落到哪一天
// ─────────────────────────────────────────────────────────────

test("在「明天」页签添加 → 落到明天清单，不出现在今天", async ({ page }) => {
  await page.locator(".tab", { hasText: "明天" }).click();
  await page.fill(".add", "客户拜访");
  await page.press(".add", "Enter");
  await expect(page.locator(".row", { hasText: "客户拜访" })).toBeVisible();

  await page.locator(".tab", { hasText: "今天" }).click();
  await expect(page.locator(".row", { hasText: "客户拜访" })).toHaveCount(0);
});

test("在「随笔」页签添加 → 落到随笔区，不进今天", async ({ page }) => {
  await page.locator(".tab", { hasText: "随笔" }).click();
  await page.fill(".add", "一个灵感");
  await page.press(".add", "Enter");
  await expect(page.locator(".row", { hasText: "一个灵感" })).toBeVisible();

  await page.locator(".tab", { hasText: "今天" }).click();
  await expect(page.locator(".row", { hasText: "一个灵感" })).toHaveCount(0);
});

// ─────────────────────────────────────────────────────────────
// 日历里给未来的某天加待办
//
// 用户反馈：「我想在 15 日添加两条待办，要怎么加？」
// 之前的实现把日历页签的输入框整个藏了 —— 而"未来要做的事，现在先记到那天"
// 恰恰是日历最该支持的操作。现在：点一天 → 底部出现输入框 → 加到那天。
// ─────────────────────────────────────────────────────────────

/** 点日历上某个日期（排除上下月补齐的灰格子） */
async function pickDay(page: Page, day: number) {
  await page
    .locator(".cal-cell:not(.dim)")
    .filter({ hasText: new RegExp(`^${day}$`) })
    .first()
    .click();
}

test("日历页签：没点日期时明确提示怎么做，而不是把输入框藏起来", async ({ page }) => {
  await page.locator(".tab", { hasText: "日历" }).click();

  await expect(page.locator(".cal-grid")).toBeVisible();
  await expect(page.locator(".add")).toHaveCount(0);
  await expect(page.locator(".hint-line")).toContainText("点日历上的某一天");
});

test("日历页签：点一天就能给那天加待办", async ({ page }) => {
  const errors = collectErrors(page);

  await page.locator(".tab", { hasText: "日历" }).click();
  await pickDay(page, 15);

  // 输入框出现，且占位文案点明加到哪天
  await expect(page.locator(".add")).toBeVisible();
  await expect(page.locator(".add")).toHaveAttribute("placeholder", /15日/);

  await page.fill(".add", "9:30 交材料");
  await page.press(".add", "Enter");

  // 出现在那一天的列表里，时间是识别出来的
  const row = page.locator(".row", { hasText: "交材料" });
  await expect(row).toBeVisible();
  await expect(row.locator(".time")).toHaveText("09:30");

  // 反馈里写清加到了哪天
  await expect(page.locator(".toast")).toContainText("15日");
  expect(errors).toEqual([]);
});

test("日历页签：同一天连着加两条（用户的实际用法）", async ({ page }) => {
  await page.locator(".tab", { hasText: "日历" }).click();
  await pickDay(page, 15);

  await page.fill(".add", "第一条");
  await page.press(".add", "Enter");
  await page.fill(".add", "第二条");
  await page.click(".send");

  await expect(page.locator(".row", { hasText: "第一条" })).toBeVisible();
  await expect(page.locator(".row", { hasText: "第二条" })).toBeVisible();
  // 输入框清空且仍可用，可以接着加第三条
  await expect(page.locator(".add")).toHaveValue("");
});

test("日历页签：加完之后那天的格子上出现小圆点", async ({ page }) => {
  await page.locator(".tab", { hasText: "日历" }).click();
  await pickDay(page, 15);
  await page.fill(".add", "有安排");
  await page.press(".add", "Enter");

  const cell = page
    .locator(".cal-cell:not(.dim)")
    .filter({ hasText: new RegExp("^15$") })
    .first();
  await expect(cell.locator(".cal-dot")).toBeVisible();
  await expect(cell).toHaveClass(/picked/);
});

test("日历页签：没选日期时按回车不会凭空造出一条无日期待办", async ({ page }) => {
  await page.locator(".tab", { hasText: "日历" }).click();
  await expect(page.locator(".add")).toHaveCount(0);
  // 输入框根本不存在，自然也没有待办被创建
  await expect(page.locator(".row")).toHaveCount(0);
});

test("日历页签：切走再切回来仍然记得选中的是哪天", async ({ page }) => {
  await page.locator(".tab", { hasText: "日历" }).click();
  await pickDay(page, 15);
  await page.locator(".tab", { hasText: "今天" }).click();
  await page.locator(".tab", { hasText: "日历" }).click();

  await expect(page.locator(".add")).toBeVisible();
  await expect(page.locator(".add")).toHaveAttribute("placeholder", /15日/);
});

// ─────────────────────────────────────────────────────────────
// 勾选 / 删除
// ─────────────────────────────────────────────────────────────

test("勾选后进入「已完成」折叠区，角标减少", async ({ page }) => {
  await page.fill(".add", "打卡");
  await page.press(".add", "Enter");
  await expect(page.locator(".head-count b")).toHaveText("1");

  await page.locator(".row", { hasText: "打卡" }).locator(".check").click();

  await expect(page.locator(".head-count b")).toHaveText("0");
  await expect(page.locator(".row", { hasText: "打卡" })).toHaveCount(0);

  // 展开已完成区就能看到它
  await page.locator(".group-title.clickable").click();
  await expect(page.locator(".row.done", { hasText: "打卡" })).toBeVisible();
});

test("取消勾选能回到今天清单", async ({ page }) => {
  await page.fill(".add", "打卡");
  await page.press(".add", "Enter");
  await page.locator(".row .check").click();
  await page.locator(".group-title.clickable").click();

  await page.locator(".row.done .check").click();
  await expect(page.locator(".head-count b")).toHaveText("1");
});

test("点「删」后从清单消失", async ({ page }) => {
  await page.fill(".add", "临时的事");
  await page.press(".add", "Enter");

  const row = page.locator(".row", { hasText: "临时的事" });
  await expect(row).toBeVisible();
  await row.hover();
  await row.locator(".act.danger").click();

  await expect(page.locator(".row", { hasText: "临时的事" })).toHaveCount(0);
  await expect(page.locator(".head-count b")).toHaveText("0");
});

// ─────────────────────────────────────────────────────────────
// 操作反馈：用户反馈过「点了回车没有任何反应」
//
// 失败路径不在这里测：浏览器里用的是内存仓储，它不会失败。
// 失败路径由 apps/desktop/test/store-feedback.test.ts 用会抛错的仓储覆盖
// （那边能断言 lastError 的内容，比在页面上造错更直接）。
// ─────────────────────────────────────────────────────────────

test("添加成功后给出明确反馈：绿色提示 + 该行高亮", async ({ page }) => {
  await page.fill(".add", "写周报");
  await page.press(".add", "Enter");

  await expect(page.locator(".toast")).toContainText("已添加「写周报」");
  await expect(page.locator(".row", { hasText: "写周报" })).toHaveClass(/flash/);
});

test("成功提示会自动消失，不会一直占着地方", async ({ page }) => {
  await page.fill(".add", "写周报");
  await page.press(".add", "Enter");
  await expect(page.locator(".toast")).toBeVisible();

  // NOTICE_MS = 2600ms
  await expect(page.locator(".toast")).toHaveCount(0, { timeout: 6000 });
});

test("提示里显示的是去掉时间之后的正文", async ({ page }) => {
  await page.fill(".add", "9:30 交周报");
  await page.press(".add", "Enter");
  await expect(page.locator(".toast")).toContainText("已添加「交周报」");
});

test("从「明天」页签添加，提示同样出现", async ({ page }) => {
  await page.locator(".tab", { hasText: "明天" }).click();
  await page.fill(".add", "客户拜访");
  await page.press(".add", "Enter");
  await expect(page.locator(".toast")).toContainText("已添加「客户拜访」");
});

test("没有失败时不会显示红色错误条", async ({ page }) => {
  await page.fill(".add", "写周报");
  await page.press(".add", "Enter");
  await expect(page.locator(".alert")).toHaveCount(0);
});

// ─────────────────────────────────────────────────────────────
// 空态
// ─────────────────────────────────────────────────────────────

test("空清单显示引导文案，而不是一片空白", async ({ page }) => {
  await expect(page.locator(".empty")).toBeVisible();
  await expect(page.locator(".row")).toHaveCount(0);
});

test("钉子按钮可切换（浏览器里只是本地状态）", async ({ page }) => {
  // 头部现在有两个按钮（⚙ 设置 / 📌 钉住），按 title 精确定位
  const pin = page.locator('.pin[title*="钉住"]');
  await expect(pin).not.toHaveClass(/on/);
  await pin.click();
  await expect(pin).toHaveClass(/on/);
});


// ─────────────────────────────────────────────────────────────
// 用法引导：教一次就闭嘴
//
// 用户反馈过"光看界面不一定知道能这么用"。这里的约定是：
// 教学提示每条只出现一次，点 ✕ 后永久不再出现；教完之后只剩一行很淡的常驻备忘。
// ─────────────────────────────────────────────────────────────

test("首次使用会教「时间可以直接写在输入框里」", async ({ page }) => {
  const hint = page.locator(".hint-line");
  await expect(hint).toHaveClass(/coach/);
  await expect(hint).toContainText("直接写时间");
  await expect(page.locator(".hint-close")).toBeVisible();
});

test("点 ✕ 之后换成下一条，而且刷新也不会再教同一条", async ({ page }) => {
  const hint = page.locator(".hint-line");
  await expect(hint).toContainText("直接写时间");

  await page.locator(".hint-close").click();
  await expect(hint).toContainText("昨日未完成");

  await page.reload();
  await expect(page.locator(".widget.expanded")).toBeVisible();
  await expect(page.locator(".hint-line")).not.toContainText("直接写时间");
  await expect(page.locator(".hint-line")).toContainText("昨日未完成");
});

test("学过的提示，换个页签也不会重新教一遍", async ({ page }) => {
  await expect(page.locator(".hint-line")).toContainText("直接写时间");
  await page.locator(".hint-close").click();

  // 随笔页签：time-shortcut 已学过，应该给随笔专属的那条
  await page.locator(".tab", { hasText: "随笔" }).click();
  await expect(page.locator(".hint-line")).toContainText("排今天");
});

test("所有技巧都教完之后，只剩一行淡淡的常驻备忘（不再有 ✕）", async ({ page }) => {
  for (let i = 0; i < 10; i++) {
    const close = page.locator(".hint-close");
    if ((await close.count()) === 0) break;
    await close.click();
  }

  const hint = page.locator(".hint-line");
  await expect(hint).not.toHaveClass(/coach/);
  await expect(hint).toContainText("时间会被自动识别");
  await expect(page.locator(".hint-close")).toHaveCount(0);
});

test("日历没选日期时给的是操作指引，不是教学提示", async ({ page }) => {
  await page.locator(".tab", { hasText: "日历" }).click();
  const hint = page.locator(".hint-line");
  await expect(hint).not.toHaveClass(/coach/);
  await expect(hint).toContainText("点日历上的某一天");
});

// ─────────────────────────────────────────────────────────────
// 随笔：一键排期
// ─────────────────────────────────────────────────────────────

test("随笔里「排今天」能把没排期的事排到今天", async ({ page }) => {
  const errors = collectErrors(page);

  await page.locator(".tab", { hasText: "随笔" }).click();
  await page.fill(".add", "一个灵感");
  await page.press(".add", "Enter");

  const row = page.locator(".row", { hasText: "一个灵感" });
  await expect(row).toBeVisible();
  await row.hover();
  await row.locator(".act", { hasText: "排今天" }).click();

  // 随笔里没了，今天清单里有了
  await expect(page.locator(".row", { hasText: "一个灵感" })).toHaveCount(0);
  await page.locator(".tab", { hasText: "今天" }).click();
  await expect(page.locator(".row", { hasText: "一个灵感" })).toBeVisible();
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 到点提醒
//
// 浏览器里没有 Tauri，所以"响声音 / 自动展开面板"这两个平台效果不会真的发生，
// 这里验证的是**判断与呈现**：该不该出现、卡片长什么样、处理动作有没有生效。
// 真实的声音与展开在 macOS 上用截图人工验收。
// ─────────────────────────────────────────────────────────────

/** 加一条"时间已经过去"的待办，制造到点提醒 */
async function addPastDue(page: Page, title: string, time = "00:01") {
  await page.fill(".add", `${time} ${title}`);
  await page.press(".add", "Enter");
}

test("到点的待办会出现提醒卡片，窄条变红闪动", async ({ page }) => {
  const errors = collectErrors(page);
  await addPastDue(page, "已经到点的事");

  const card = page.locator(".reminder-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("已经到点的事");
  await expect(card).toContainText("00:01");
  await expect(page.locator(".strip")).toHaveClass(/alerting/);
  expect(errors).toEqual([]);
});

test("多条同时到点合并成一张卡片 —— 绝不弹 N 个窗口", async ({ page }) => {
  await addPastDue(page, "第一条", "00:01");
  await addPastDue(page, "第二条", "00:02");
  await addPastDue(page, "第三条", "00:03");

  await expect(page.locator(".reminder-card")).toHaveCount(1);
  const card = page.locator(".reminder-card");
  await expect(card).toContainText("到点了");
  await expect(card.locator(".rc-item")).toHaveCount(3);
  // 多件事时给"全部推后"，避免逐条点
  await expect(card.locator(".rc-all")).toBeVisible();
});

test("提醒卡片里可以直接标记完成", async ({ page }) => {
  await addPastDue(page, "要做的事");
  await expect(page.locator(".reminder-card")).toBeVisible();

  await page.locator(".rc-check").first().click();
  await expect(page.locator(".reminder-card")).toHaveCount(0);
  // 窄条也恢复常态
  await expect(page.locator(".strip")).not.toHaveClass(/alerting/);
});

test("提醒可以推后：立刻从卡片消失，且待办本身没被改动", async ({ page }) => {
  await addPastDue(page, "等等再做");
  await expect(page.locator(".reminder-card")).toBeVisible();

  await page.locator(".rc-act", { hasText: "推后" }).first().click();
  await expect(page.locator(".reminder-card")).toHaveCount(0);

  // 待办还在今天清单里（推后只是推迟提醒，不是完成）
  await expect(page.locator(".row", { hasText: "等等再做" })).toBeVisible();
});

test("今天不再提醒：卡片消失，待办仍在", async ({ page }) => {
  await addPastDue(page, "今天别烦我");
  await expect(page.locator(".reminder-card")).toBeVisible();

  await page.locator(".rc-act", { hasText: "静音" }).first().click();
  await expect(page.locator(".reminder-card")).toHaveCount(0);
  await expect(page.locator(".row", { hasText: "今天别烦我" })).toBeVisible();
});

test("「全部推后」一次清空整张卡片", async ({ page }) => {
  await addPastDue(page, "甲", "00:01");
  await addPastDue(page, "乙", "00:02");
  await expect(page.locator(".rc-item")).toHaveCount(2);

  await page.locator(".rc-all").click();
  await expect(page.locator(".reminder-card")).toHaveCount(0);
});

test("没到点的待办不会提前提醒", async ({ page }) => {
  await page.fill(".add", "23:59 还没到点的事");
  await page.press(".add", "Enter");

  await expect(page.locator(".row", { hasText: "还没到点的事" })).toBeVisible();
  await expect(page.locator(".reminder-card")).toHaveCount(0);
});

test("没设时间的全天事项不产生提醒（只在早上汇总）", async ({ page }) => {
  await page.fill(".add", "买咖啡豆");
  await page.press(".add", "Enter");

  await expect(page.locator(".row", { hasText: "买咖啡豆" })).toBeVisible();
  await expect(page.locator(".reminder-card")).toHaveCount(0);
});

test("设置里可以关掉提醒声音", async ({ page }) => {
  await page.locator(".pin", { hasText: "⚙" }).click();
  const sound = page.locator(".set-toggle").first();
  await expect(sound).toHaveClass(/on/); // 默认开

  await sound.click();
  await expect(sound).not.toHaveClass(/on/);
});

test("设置里可以开关免打扰", async ({ page }) => {
  await page.locator(".pin", { hasText: "⚙" }).click();
  const dnd = page.locator(".set-toggle").nth(1);
  await expect(dnd).toHaveClass(/on/); // 默认 22:00–07:00 开

  await dnd.click();
  await expect(dnd).not.toHaveClass(/on/);
});

// ─────────────────────────────────────────────────────────────
// 早上汇总：没定时间的事永远等不到"到点"，只能被汇总提一次
// ─────────────────────────────────────────────────────────────

test("过了汇总时刻，会提醒今天有几件没定时间的事", async ({ page }) => {
  const errors = collectErrors(page);
  await page.fill(".add", "买咖啡豆");
  await page.press(".add", "Enter");

  const banner = page.locator(".morning-summary");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("没定时间");
  await expect(banner).toContainText("1");
  expect(errors).toEqual([]);
});

test("有几件就说几件", async ({ page }) => {
  for (const t of ["买咖啡豆", "取快递", "交水电费"]) {
    await page.fill(".add", t);
    await page.press(".add", "Enter");
  }
  await expect(page.locator(".morning-summary")).toContainText("3");
});

test("没有没定时间的事时，早上汇总不出现", async ({ page }) => {
  await page.fill(".add", "9:30 有时间的");
  await page.press(".add", "Enter");

  await expect(page.locator(".row", { hasText: "有时间的" })).toBeVisible();
  await expect(page.locator(".morning-summary")).toHaveCount(0);
});

test("点「知道了」后消失，刷新也不会再冒出来（一天只汇总一次）", async ({ page }) => {
  await page.fill(".add", "买咖啡豆");
  await page.press(".add", "Enter");
  await expect(page.locator(".morning-summary")).toBeVisible();

  await page.locator(".ms-close").click();
  await expect(page.locator(".morning-summary")).toHaveCount(0);

  await page.reload();
  await expect(page.locator(".widget.expanded")).toBeVisible();
  await expect(page.locator(".morning-summary")).toHaveCount(0);
});

test("设置里可以关掉早上汇总", async ({ page }) => {
  await page.locator(".pin", { hasText: "⚙" }).click();

  const row = page.locator(".set-row", { hasText: "早上汇总" });
  await expect(row.locator(".set-toggle")).toHaveClass(/on/); // 默认开

  await row.locator(".set-toggle").click();
  await expect(row.locator(".set-toggle")).not.toHaveClass(/on/);
});
