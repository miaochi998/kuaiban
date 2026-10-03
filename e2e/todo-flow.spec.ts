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

test("「日历」页签隐藏输入框（那里不该能随手加）", async ({ page }) => {
  await expect(page.locator(".add")).toBeVisible();
  await page.locator(".tab", { hasText: "日历" }).click();
  await expect(page.locator(".add")).toHaveCount(0);
  await expect(page.locator(".cal-grid")).toBeVisible();
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
  await expect(page.locator(".pin")).not.toHaveClass(/on/);
  await page.locator(".pin").click();
  await expect(page.locator(".pin")).toHaveClass(/on/);
});
