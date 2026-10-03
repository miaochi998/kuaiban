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

  const doneRow = page.locator(".row", { hasText: "打卡" });
  await doneRow.hover();
  await doneRow.locator(".act.primary").click();

  await expect(page.locator(".head-count b")).toHaveText("0");
  await expect(page.locator(".row", { hasText: "打卡" })).toHaveCount(0);

  // 展开已完成区就能看到它
  await page.locator(".group-title.clickable").click();
  await expect(page.locator(".row.done", { hasText: "打卡" })).toBeVisible();
});

test("取消勾选能回到今天清单", async ({ page }) => {
  await page.fill(".add", "打卡");
  await page.press(".add", "Enter");
  const only = page.locator(".row").first();
  await only.hover();
  await only.locator(".act.primary").click();
  await page.locator(".group-title.clickable").click();

  const undone = page.locator(".row.done").first();
  await undone.hover();
  // 已完成的行里这个按钮变成「撤销」
  await undone.locator(".act.primary", { hasText: "撤销" }).click();
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
  await expect(hint).toContainText("重复的事");

  await page.reload();
  await expect(page.locator(".widget.expanded")).toBeVisible();
  await expect(page.locator(".hint-line")).not.toContainText("直接写时间");
  await expect(page.locator(".hint-line")).toContainText("重复的事");
});

test("学过的提示，换个页签也不会重新教一遍", async ({ page }) => {
  await expect(page.locator(".hint-line")).toContainText("直接写时间");
  await page.locator(".hint-close").click();

  // 随笔页签：time-shortcut 已学过，接着教"能写重复"（它在随笔页签也适用）
  await page.locator(".tab", { hasText: "随笔" }).click();
  await expect(page.locator(".hint-line")).toContainText("重复的事");
});

test("所有技巧都教完之后，只剩一行淡淡的常驻备忘（不再有 ✕）", async ({ page }) => {
  for (let i = 0; i < 10; i++) {
    const close = page.locator(".hint-close");
    if ((await close.count()) === 0) break;
    await close.click();
  }

  const hint = page.locator(".hint-line");
  await expect(hint).not.toHaveClass(/coach/);
  await expect(hint).toContainText("每周六");
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

  await page.locator(".rc-done").first().click();
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
  // 用「明天」的待办：它永远在未来。
  // （原来用今天的「23:59」，结果凌晨 00:00–04:00 跑测试时业务日还是昨天，
  //   23:59 已经过去了 —— 一个随运行时刻时灵时不灵的脆弱测试。）
  await page.locator(".tab", { hasText: "明天" }).click();
  await page.fill(".add", "10:00 还没到点的事");
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
  await page.locator(".head-icon").click();
  const sound = page.locator(".sp-toggle").first();
  await expect(sound).toHaveClass(/on/); // 默认开

  await sound.click();
  await expect(sound).not.toHaveClass(/on/);
});

test("设置里可以开关免打扰", async ({ page }) => {
  await page.locator(".head-icon").click();
  const dnd = page.locator(".sp-toggle").nth(1);
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
  await page.locator(".head-icon").click();

  const row = page.locator(".sp-row", { hasText: "早上汇总" });
  await expect(row.locator(".sp-toggle")).toHaveClass(/on/); // 默认开

  await row.locator(".sp-toggle").click();
  await expect(row.locator(".sp-toggle")).not.toHaveClass(/on/);
});

// ─────────────────────────────────────────────────────────────
// 编辑：点待办内容就能改时间 / 日期 / 重复规则
//
// 用户反馈：「添加的待办如果开始的时候没有添加时间，添加成功后想要给这条
// 待办加上时间的话怎么操作？」—— 原来根本改不了。以及「循环待办怎么添加？
// 从当前的软件界面无法添加」—— 数据模型支持重复，但界面一直没有入口。
// ─────────────────────────────────────────────────────────────

test("点待办内容打开编辑面板", async ({ page }) => {
  await page.fill(".add", "买咖啡豆");
  await page.press(".add", "Enter");

  await page.locator(".row", { hasText: "买咖啡豆" }).locator(".body").click();
  await expect(page.locator(".edit-sheet")).toBeVisible();
  await expect(page.locator(".es-title")).toContainText("编辑");
  // 内容已填好，可以直接改
  await expect(page.locator(".es-title-input")).toHaveValue("买咖啡豆");
});

test("给原本没时间的待办补上时间（用户问的第一件事）", async ({ page }) => {
  const errors = collectErrors(page);

  await page.fill(".add", "买咖啡豆");
  await page.press(".add", "Enter");
  await page.locator(".row", { hasText: "买咖啡豆" }).locator(".body").click();

  await page.locator(".es-time").fill("09:30");
  await page.locator(".es-btn.primary").click();

  await expect(page.locator(".edit-sheet")).toHaveCount(0);
  await expect(page.locator(".row", { hasText: "买咖啡豆" }).locator(".time")).toHaveText("09:30");
  expect(errors).toEqual([]);
});

test("在编辑面板里把待办设成「每周六」（用户问的循环待办）", async ({ page }) => {
  await page.fill(".add", "交周报");
  await page.press(".add", "Enter");
  await page.locator(".row", { hasText: "交周报" }).locator(".body").click();

  await page.locator(".es-chip", { hasText: "每周" }).click();
  await page.locator(".es-chip.round", { hasText: "六" }).click();
  await page.locator(".es-btn.primary").click();

  await expect(page.locator(".row", { hasText: "交周报" }).locator(".repeat")).toHaveText("🔁 每周六");
});

test("编辑面板：选每周却没选星期几时不给保存", async ({ page }) => {
  await page.fill(".add", "开会");
  await page.press(".add", "Enter");
  await page.locator(".row", { hasText: "开会" }).locator(".body").click();

  await page.locator(".es-chip", { hasText: "每周" }).click();
  await expect(page.locator(".es-error")).toContainText("星期几");
  await expect(page.locator(".es-btn.primary")).toBeDisabled();
});

test("编辑面板：时间写错会提示，也保存不了", async ({ page }) => {
  await page.fill(".add", "开会");
  await page.press(".add", "Enter");
  await page.locator(".row", { hasText: "开会" }).locator(".body").click();

  await page.locator(".es-time").fill("25:99");
  await expect(page.locator(".es-error")).toContainText("时间格式");
  await expect(page.locator(".es-btn.primary")).toBeDisabled();
});

test("编辑面板：可以取消，不改动任何东西", async ({ page }) => {
  await page.fill(".add", "原样");
  await page.press(".add", "Enter");
  await page.locator(".row", { hasText: "原样" }).locator(".body").click();

  await page.locator(".es-title-input").fill("改过的");
  await page.locator(".es-btn", { hasText: "取消" }).click();

  await expect(page.locator(".edit-sheet")).toHaveCount(0);
  await expect(page.locator(".row", { hasText: "原样" })).toBeVisible();
  await expect(page.locator(".row", { hasText: "改过的" })).toHaveCount(0);
});

test("编辑面板：可以删除", async ({ page }) => {
  await page.fill(".add", "要删的");
  await page.press(".add", "Enter");
  await page.locator(".row", { hasText: "要删的" }).locator(".body").click();

  await page.locator(".es-btn.danger").click();
  await expect(page.locator(".edit-sheet")).toHaveCount(0);
  await expect(page.locator(".row", { hasText: "要删的" })).toHaveCount(0);
});

// ─────────────────────────────────────────────────────────────
// 输入框里直接写重复与中文时间
// ─────────────────────────────────────────────────────────────

test("输入「每周六 10:00 例会」→ 建出带重复的待办", async ({ page }) => {
  await page.fill(".add", "每周六 10:00 例会");
  await page.press(".add", "Enter");

  const row = page.locator(".row", { hasText: "例会" });
  await expect(row).toBeVisible();
  await expect(row.locator(".repeat")).toHaveText("🔁 每周六");
  await expect(row.locator(".time")).toHaveText("10:00");
});

test("输入「每天 9:30 吃药」→ 每天重复", async ({ page }) => {
  await page.fill(".add", "每天 9:30 吃药");
  await page.press(".add", "Enter");
  await expect(page.locator(".row", { hasText: "吃药" }).locator(".repeat")).toHaveText("🔁 每天");
});

test("输入「下午2:30 去游泳」→ 识别成 14:30（用户问的第二件事）", async ({ page }) => {
  await page.fill(".add", "下午2:30 去游泳");
  await page.press(".add", "Enter");

  const row = page.locator(".row", { hasText: "去游泳" });
  await expect(row).toBeVisible();
  await expect(row.locator(".title")).toHaveText("去游泳");
  await expect(row.locator(".time")).toHaveText("14:30");
});

test("输入「工作日 打卡」→ 工作日重复；建在周末会顺延到下一个工作日并明确告知", async ({ page }) => {
  const errors = collectErrors(page);
  await page.fill(".add", "工作日 打卡");
  await page.press(".add", "Enter");

  const row = page.locator(".row", { hasText: "打卡" });
  const dow = new Date().getDay(); // 0 = 周日, 6 = 周六

  if (dow === 0 || dow === 6) {
    // 周末：今天本来就不该有这条待办……
    await expect(row).toHaveCount(0);
    // ……但绝不能让它"悄悄地消失"。起始日会被对齐到下一个工作日，
    // 提示里必须说清从哪天开始（曾经就是这里没声没息，用户以为数据丢了）。
    await expect(page.locator(".toast")).toContainText("按重复规则从");
  } else {
    await expect(row.locator(".repeat")).toHaveText("🔁 工作日");
  }
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 以后的事不能直接勾完成
//
// 用户的原话：「明天的待办不应该可以标记已完成，如果今天还有时间去做明天的
// 事情的话，应该将明天的待办移到今天然后再标记完成。日历中未来的时间的待办
// 也应该是同样的逻辑。」
// ─────────────────────────────────────────────────────────────

test("明天的事没有「完成」，只能先「搬到今天」", async ({ page }) => {
  await page.locator(".tab", { hasText: "明天" }).click();
  await page.fill(".add", "明天的事");
  await page.press(".add", "Enter");

  const row = page.locator(".row", { hasText: "明天的事" });
  await expect(row.locator(".future-tag")).toContainText("以后的事");
  await row.hover();
  // 未来的事**没有**「完成」，只能先搬
  await expect(row.locator(".act.primary")).toHaveCount(0);
  await expect(row.locator(".act", { hasText: "搬到今天" })).toBeVisible();
});

test("搬到今天之后左侧就换成「完成」", async ({ page }) => {
  await page.locator(".tab", { hasText: "明天" }).click();
  await page.fill(".add", "提前做");
  await page.press(".add", "Enter");

  const row = page.locator(".row", { hasText: "提前做" });
  await row.hover();
  await row.locator(".act", { hasText: "搬到今天" }).click();

  await page.locator(".tab", { hasText: "今天" }).click();
  const todayRow = page.locator(".row", { hasText: "提前做" });
  await todayRow.hover();
  // 搬到今天之后，「完成」就出现了
  await expect(todayRow.locator(".act.primary")).toHaveText("完成");
  await todayRow.locator(".act.primary").click();
  await expect(todayRow).toHaveCount(0);
});

test("日历里未来的日期同样不能勾完成", async ({ page }) => {
  await page.locator(".tab", { hasText: "日历" }).click();
  await page
    .locator(".cal-cell:not(.dim)")
    .filter({ hasText: /^20$/ })
    .first()
    .click();
  await page.fill(".add", "20号的事");
  await page.press(".add", "Enter");

  const row = page.locator(".row", { hasText: "20号的事" });
  await row.hover();
  await expect(row.locator(".act.primary")).toHaveCount(0);
  await expect(row.locator(".act", { hasText: "搬到今天" })).toBeVisible();
});

test("今天的事照常可以完成", async ({ page }) => {
  await page.fill(".add", "今天的事");
  await page.press(".add", "Enter");

  const row = page.locator(".row", { hasText: "今天的事" });
  await row.hover();
  await expect(row.locator(".act.primary")).toHaveText("完成");
});

// ─────────────────────────────────────────────────────────────
// 随笔不是待办：没有「完成」
//
// 用户原话：「随笔就像记事本一样，只是用来记录自己的想法和灵感的，
// 不需要标记完成，只有把随笔排上时间后才会将随笔更改为待办」。
// ─────────────────────────────────────────────────────────────

test("随笔里没有「完成」按钮 —— 它只是记事本", async ({ page }) => {
  const errors = collectErrors(page);
  await page.locator(".tab", { hasText: "随笔" }).click();
  await page.fill(".add", "一个灵感");
  await page.press(".add", "Enter");

  const row = page.locator(".row", { hasText: "一个灵感" });
  await row.hover();

  await expect(row.locator(".act.primary")).toHaveCount(0); // 没有「完成」
  await expect(row.locator(".act", { hasText: "排今天" })).toBeVisible();
  await expect(row.locator(".act.danger")).toBeVisible(); // 但可以删
  expect(errors).toEqual([]);
});

test("随笔排上日期之后就变成待办，这时才有「完成」", async ({ page }) => {
  await page.locator(".tab", { hasText: "随笔" }).click();
  await page.fill(".add", "一个灵感");
  await page.press(".add", "Enter");

  const row = page.locator(".row", { hasText: "一个灵感" });
  await row.hover();
  await row.locator(".act", { hasText: "排今天" }).click();

  await page.locator(".tab", { hasText: "今天" }).click();
  const scheduled = page.locator(".row", { hasText: "一个灵感" });
  await scheduled.hover();
  await expect(scheduled.locator(".act.primary")).toHaveText("完成");
});

// ─────────────────────────────────────────────────────────────
// 「完成」和「删」一样是悬停才出现的小按钮
//
// 用户原话：「建议将完成了使用圆圈打钩的逻辑修改为与删除一样的效果：
// 当鼠标悬停时显示"完成"和"删"两个小按钮，这样最能直接明白是什么意思」。
// ─────────────────────────────────────────────────────────────

test("「完成」和「删」一样，悬停才出现", async ({ page }) => {
  await page.fill(".add", "悬停看看");
  await page.press(".add", "Enter");

  const row = page.locator(".row", { hasText: "悬停看看" });
  // 不悬停：什么都没有 —— 常驻会让每一行看起来都像"已完成"
  // 不悬停：整组操作透明且点不到（opacity 不会继承，所以查容器）
  await expect(row.locator(".actions")).toHaveCSS("opacity", "0");
  await expect(row.locator(".actions")).toHaveCSS("pointer-events", "none");

  await row.hover();
  await expect(row.locator(".actions")).toHaveCSS("opacity", "1");
  await expect(row.locator(".act.primary", { hasText: "完成" })).toBeVisible();
  await expect(row.locator(".act.danger", { hasText: "删" })).toBeVisible();
});

test("悬停之后可以直接点「完成」", async ({ page }) => {
  await page.fill(".add", "直接完成");
  await page.press(".add", "Enter");

  const row = page.locator(".row", { hasText: "直接完成" });
  await row.hover();
  await row.locator(".act.primary").click();
  await expect(row).toHaveCount(0);
});

test("逾期行悬停后同时有「完成」和「搬今天」", async ({ page }) => {
  await page.fill(".add", "拖了很久的事");
  await page.press(".add", "Enter");

  // 用编辑面板把日期改到三天前，造一条逾期
  const past = new Date();
  past.setDate(past.getDate() - 3);
  const key = `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, "0")}-${String(past.getDate()).padStart(2, "0")}`;

  await page.locator(".row", { hasText: "拖了很久的事" }).locator(".body").click();
  await page.locator(".es-date").fill(key);
  await page.locator(".es-btn.primary").click();

  const row = page.locator(".row", { hasText: "拖了很久的事" });
  await expect(row.locator(".act.primary")).toHaveText("完成");
  await row.hover();
  await expect(row.locator(".act", { hasText: "搬今天" })).toBeVisible();
});
test("藏起来的时候点不到（不会误点看不见的「删」）", async ({ page }) => {
  await page.fill(".add", "别误删");
  await page.press(".add", "Enter");

  const row = page.locator(".row", { hasText: "别误删" });
  // 不悬停 → 按钮不可点击（pointer-events: none）
  await expect(row.locator(".actions")).toHaveCSS("pointer-events", "none");

  await row.hover();
  await expect(row.locator(".actions")).toHaveCSS("pointer-events", "auto");
});

test("已完成的行里按钮变成「撤销」", async ({ page }) => {
  await page.fill(".add", "做完的事");
  await page.press(".add", "Enter");

  const row = page.locator(".row", { hasText: "做完的事" });
  await row.hover();
  await row.locator(".act.primary").click();

  await page.locator(".group-title", { hasText: "已完成" }).click();
  const doneRow = page.locator(".row.done", { hasText: "做完的事" });
  await doneRow.hover();
  await expect(doneRow.locator(".act.primary")).toHaveText("撤销");
});

// ─────────────────────────────────────────────────────────────
// 账号与同步（离线优先）
//
// 核心约定：**不登录也是一等公民**。服务器没部署、断网、公司网络出问题，
// 都不该让人记不了事。登录只是为了多设备同步。
// ─────────────────────────────────────────────────────────────

test("未登录时不显示同步状态点 —— 一个没有文字的点只会让人猜", async ({ page }) => {
  // 状态点是"提示"，不是"装饰"：只有同步中 / 出错 / 有待上传才出现
  await expect(page.locator(".sync-dot")).toHaveCount(0);
  // 设置入口始终在
  await expect(page.locator(".head-icon")).toBeVisible();
});

test("设置占满整个面板：提醒卡片、页签、底部输入框都不该混进来", async ({ page }) => {
  // 先造一条到点的提醒，确认它平时确实在
  await page.fill(".add", "00:01 到点的事");
  await page.press(".add", "Enter");
  await expect(page.locator(".reminder-card")).toBeVisible();

  await page.locator(".head-icon").click();

  await expect(page.locator(".settings-panel")).toBeVisible();
  await expect(page.locator(".reminder-card")).toHaveCount(0); // 提醒内容不该混进来
  await expect(page.locator(".tabs")).toHaveCount(0); // 功能切换标签不该在
  await expect(page.locator(".foot")).toHaveCount(0); // 底部发送框与提示不该在
  await expect(page.locator(".scroll")).toHaveCount(0); // 清单也不该在

  // 关掉之后一切恢复
  await page.locator(".sp-close").click();
  await expect(page.locator(".settings-panel")).toHaveCount(0);
  await expect(page.locator(".tabs")).toBeVisible();
  await expect(page.locator(".foot")).toBeVisible();
  await expect(page.locator(".reminder-card")).toBeVisible();
});

test("设置里说清「不登录也能用」，并把登录入口摆出来", async ({ page }) => {
  await page.locator(".head-icon").click();

  await expect(page.locator(".settings-panel")).toContainText("只存在这台电脑上");
  await expect(page.locator('input[placeholder="登录名"]')).toBeVisible();
  await expect(page.locator('input[placeholder="密码"]')).toBeVisible();
  // 默认服务器地址已经填好，用户不用去查
  await expect(page.locator('input[placeholder^="http"]')).toHaveValue(/^http/);
});

test("不登录照样能记待办 —— 这是离线优先的底线", async ({ page }) => {
  const errors = collectErrors(page);

  await page.fill(".add", "没登录也能记");
  await page.press(".add", "Enter");

  await expect(page.locator(".row", { hasText: "没登录也能记" })).toBeVisible();
  await expect(page.locator(".sync-dot")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("登录失败会给一句人话，而不是一直转圈", async ({ page }) => {
  await page.locator(".head-icon").click();
  await page.locator('input[placeholder="登录名"]').fill("someone");
  await page.locator('input[placeholder="密码"]').fill("password123");
  await page.locator(".sp-wide").click();

  // 不断言具体文案：本机可能真起了服务端（那时是"登录名或密码不对"），
  // 也可能没有（"连不上服务器"）。要守的性质是**一定给出一句人话、而且不会卡住**。
  await expect(page.locator(".sp-error")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".sp-error")).not.toBeEmpty();
  await expect(page.locator(".sp-wide")).toBeEnabled(); // 不能卡在"登录中…"
});

test("同步失败不影响本地记录", async ({ page }) => {
  await page.locator(".head-icon").click();
  await page.locator('input[placeholder="登录名"]').fill("someone");
  await page.locator('input[placeholder="密码"]').fill("password123");
  await page.locator(".sp-wide").click();
  await expect(page.locator(".sp-error")).toBeVisible({ timeout: 20_000 });

  await page.locator(".sp-close").click();
  await page.fill(".add", "断网也要能记");
  await page.press(".add", "Enter");
  await expect(page.locator(".row", { hasText: "断网也要能记" })).toBeVisible();
});
