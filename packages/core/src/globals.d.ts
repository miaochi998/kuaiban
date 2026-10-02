/**
 * 最小全局类型声明。
 *
 * 大脑只需要 `crypto.randomUUID` 这一个能力。
 * 刻意**不**把 `DOM` 写进 tsconfig 的 `lib`：大脑要保持"最小运行环境假设"，
 * Node / 各家 WebView / 未来的鸿蒙外壳都得能跑。
 *
 * 声明得越小，越容易在编译期发现"不小心引入了平台专属 API"这种事 ——
 * 这正是"零平台依赖"这条铁律的守卫方式。
 */
declare global {
  // eslint-disable-next-line no-var
  var crypto: { randomUUID?: () => string } | undefined;
}

export {};
