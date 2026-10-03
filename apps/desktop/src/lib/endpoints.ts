/**
 * 正式域名 —— **唯一的一处定义**。
 *
 * 所有对外访问地址都从这儿派生：API、更新清单、下载页。
 * 散着写迟早会出现"更新指向旧域名、API 指向新域名"这种查半天的怪问题。
 *
 * 本地开发时由 `VITE_KUAIBAN_SERVER` 覆盖（见 .env.example）。
 */
export const PRODUCTION_ORIGIN = "https://kuaiban.bonnei.com";

/** 同步服务端地址 */
export const SERVER_URL: string =
  (import.meta.env?.VITE_KUAIBAN_SERVER as string | undefined)?.replace(/\/+$/, "") ||
  PRODUCTION_ORIGIN;
