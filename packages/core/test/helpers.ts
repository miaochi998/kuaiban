import { createTodo, type NewTodoInput, type Todo } from "../src";

let seq = 0;

/**
 * 造一条待办。
 *
 * id 用**零填充**的序号：这样 id 的字符串序 == 创建顺序。
 * （否则 t9 和 t10 会按字典序排成 t10 < t9，让依赖"创建顺序"的断言随机失败 —— 踩过。）
 */
export function todo(input: NewTodoInput, nowIso = "2026-06-15T09:00:00"): Todo {
  seq += 1;
  return createTodo(input, { now: new Date(nowIso), id: `t${String(seq).padStart(4, "0")}` });
}

/** 本地时刻（不带 Z，按本地时区解析），保证测试不依赖运行机器的时区 */
export function local(iso: string): Date {
  return new Date(iso);
}

// 2026 年 6 月的一周，避开任何夏令时切换日
export const MON = "2026-06-15";
export const TUE = "2026-06-16";
export const WED = "2026-06-17";
export const THU = "2026-06-18";
export const FRI = "2026-06-19";
export const SAT = "2026-06-20";
export const SUN = "2026-06-21";
