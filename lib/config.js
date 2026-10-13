/**
 * dsh-auto-rename —— 纯逻辑层。
 *
 * 这个文件刻意不 import 任何东西：配置合并与源消息挑选是插件里唯一有分支的
 * 逻辑，把它们与 Cordis/schemastery 的接线分开，就能在没有 node_modules 的
 * 情况下直接跑 test/check.mjs 验证。
 */

export const NS = "dsh-auto-rename";

/**
 * Provider 身份。host 的 runProvider 会把 registration.provider.id 写进
 * session/title 的 source.provider，所以这个 id 本身就是标题来源标记。
 */
export const PROVIDER_ID = NS;

/** 与 dsh-base 的 session-title-first-prompt-llm 对齐的默认参数。 */
export const DEFAULTS = Object.freeze({
  targetWords: 5,
  targetCjkCharacters: 10,
  maxInputBytes: 4096,
  maxOutputTokens: 64,
  timeoutMs: 60000,
  suggestionCount: 3,
  autoRenameEnabled: true
});

/**
 * 解开 schemastery 的 volatile 引用。
 *
 * volatile 字段在运行时是「引用对象」（改值就地提交、不必重挂载），不是裸值：
 * 直接读会拿到 {}，表现为「设置改了没反应」且不报错。带 .get() 就取真值；
 * 裸值（本地测试直接构造的普通对象）原样返回。
 */
export function readVolatile(field) {
  if (field === undefined || field === null) return undefined;
  if (typeof field === "object" && typeof field.get === "function") return field.get();
  return field;
}

/**
 * 合并默认值与用户配置。
 *
 * provider/model 必须成对出现：只配一个会让 route 静默失效（session-title-llm
 * 内部有同款校验），所以在入口就拒绝，让用户看到明确的报错而不是「改了没反应」。
 */
export function resolveConfig(raw) {
  const merged = { ...DEFAULTS };
  for (const [key, value] of Object.entries(raw ?? {})) {
    const unwrapped = readVolatile(value);
    if (unwrapped !== undefined) merged[key] = unwrapped;
  }
  const hasProvider = typeof merged.provider === "string" && merged.provider !== "";
  const hasModel = typeof merged.model === "string" && merged.model !== "";
  if (hasProvider !== hasModel) {
    throw new Error(`${NS}: provider and model must be configured together`);
  }
  return {
    ...merged,
    route: hasProvider ? { provider: merged.provider, model: merged.model } : undefined
  };
}

/**
 * 从 host 交来的源消息里挑出用于命名的文本。
 *
 * 形状提醒：host 的 collectSessionTitleMessages 交来的是 `{ seq, text }`
 * （已按 user/message + source.kind==="user" + 非空文本过滤过），不是
 * `{ role, content }`。这里只做防御性筛选，不再二次判定角色。
 *
 * 只取第一条：与内置 first-prompt provider 的语义一致（用首条消息命名）。
 */
export function pickSourceMessages(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  for (const row of rows) {
    if (row && typeof row.text === "string" && row.text.trim() !== "") return [row];
  }
  return [];
}
