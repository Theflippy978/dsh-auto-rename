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

/**
 * 默认参数。
 *
 * 标题长度只有**一个**旋钮：targetCjkCharacters。它换算成显示宽度预算 = ×2 个
 * 半角单位，中英文共用（12 字 = 24 单位 = 英文 24 个字符含空格）。英文不设词数
 * 上限 —— 单词字符数不一致，按词数约束没有意义（用户 2026-10-14）。
 *
 * 其余值与 dsh-base 的 session-title-first-prompt-llm 一致（官方
 * targetCjkCharacters 是 10，这里按用户要求放宽到 12）。
 */
export const DEFAULTS = Object.freeze({
  targetCjkCharacters: 12,
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

/** 一个英文词按平均 5 字符 + 1 空格估：6 个半角单位。 */
const AVERAGE_WORD_UNITS = 6;

function wordsForBudget(units) {
  return Math.max(1, Math.floor(units / AVERAGE_WORD_UNITS));
}

/**
 * 合并默认值与用户配置。
 *
 * provider/model 必须成对出现：只配一个会让 route 静默失效（session-title-llm
 * 内部有同款校验），所以在入口就拒绝，让用户看到明确的报错而不是「改了没反应」。
 *
 * targetWords 不再是用户旋钮，而是从宽度预算派生（写在展开之后，所以即便旧
 * profile 里还存着这个字段也会被覆盖）：官方共享实现要求它是正整数
 * （assertPositiveInteger），提示词里也要用。按「英文平均 6 个半角单位/词」折算，
 * 使提示词的目标与硬截断的预算一致，避免模型写出来再被截。
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
    // 派生值写在展开之后：即便旧 profile 里还存着 targetWords 也会被覆盖，
    // 它已经不是用户能配的旋钮了
    targetWords: wordsForBudget(titleWidthUnits(merged.targetCjkCharacters)),
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
export function pickSourceMessages(messages, maxInputBytes = DEFAULTS.maxInputBytes) {
  const rows = Array.isArray(messages) ? messages : [];
  for (const row of rows) {
    if (row && typeof row.text === "string" && row.text.trim() !== "") {
      return [clipToBytes(row, rowBudget(maxInputBytes, 1))];
    }
  }
  return [];
}

/**
 * 取最近 count 条人类消息，用于手动弹窗的建议。
 *
 * 与 pickSourceMessages 相反：那里是「首条定名」，这里是「用最近的对话重新
 * 概括」。从最新往前取，再翻回时间顺序；每条都按字节预算裁剪，保证官方
 * frameMessages 的 JSON.stringify 不会超过 maxInputBytes（超了它会直接抛错，
 * 表现为「建议获取失败」）。
 */
export function pickRecentMessages(messages, count = 3, maxInputBytes = DEFAULTS.maxInputBytes) {
  const rows = (Array.isArray(messages) ? messages : []).filter(
    (row) => row && typeof row.text === "string" && row.text.trim() !== ""
  );
  const total = Number.isFinite(count) && count > 0 ? Math.floor(count) : 3;
  const budget = rowBudget(maxInputBytes, total);
  return rows.slice(-total).map((row) => clipToBytes(row, budget));
}

/**
 * 单条消息的字节预算。
 *
 * 预留 256 字节给 frameMessages 的固定前缀与 JSON 结构；再除以 2 抵掉
 * JSON.stringify 转义（换行、引号）最坏情况下的膨胀。
 */
function rowBudget(maxInputBytes, rows) {
  return Math.max(64, Math.floor((maxInputBytes - 256) / rows / 2));
}

/** 按 UTF-8 字节数裁剪一条消息的文本，seq 保持不变（它要进审计事件）。 */
function clipToBytes(row, budget) {
  const bytes = new TextEncoder();
  if (bytes.encode(row.text).length <= budget) return row;
  let text = row.text;
  while (text.length > 0 && bytes.encode(text).length > budget) text = text.slice(0, -Math.ceil(text.length / 10));
  return { seq: row.seq, text };
}

/**
 * 硬截断标题长度。
 *
 * 官方 normalizeSessionTitle 的调用方传的是 Number.MAX_SAFE_INTEGER —— 也就是
 * 完全不截，模型给多长留多长，所以「别太长」只能自己守住。
 *
 * 按显示宽度算，不按字符数：一个中日韩字占 2 个半角单位，其余（含空格）占 1 个。
 * 预算 = 中文字数上限 × 2，所以「中文 12 字」与「英文 24 字符（含空格）」等宽，
 * 不必再为英文单设一个数（用户 2026-10-14 的口径）。
 *
 * 宿主还有一层 maxTitleBytes（官方配 80 字节 ≈ 26 个汉字），但那是远得多的兜底，
 * 管不住「太长」，所以这里必须自己截。
 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/;

/** 标题的显示宽度预算（半角单位）。 */
export function titleWidthUnits(maxCjkCharacters) {
  return maxCjkCharacters * 2;
}

export function clampTitle(title, maxCjkCharacters) {
  if (typeof title !== "string" || title === "") return title;
  const budget = titleWidthUnits(maxCjkCharacters);
  let used = 0;
  let cut = -1;
  for (let index = 0; index < title.length; index++) {
    used += CJK.test(title[index]) ? 2 : 1;
    if (used > budget) {
      cut = index;
      break;
    }
  }
  if (cut < 0) return title;
  let head = title.slice(0, cut);
  // 切进拉丁词中间会留下 "sessio" 这种残词。能回退到上一个空格就回退；
  // 回退不了（整段没有空格，如标识符、URL）就干脆不截 —— 超宽比残词好，
  // 宿主那层 maxTitleBytes 仍会兜住极端长度。
  if (!CJK.test(title[cut]) && !/\s/.test(title[cut])) {
    const lastSpace = head.lastIndexOf(" ");
    if (lastSpace <= 0) return title;
    head = head.slice(0, lastSpace);
  }
  return head.replace(/[\s，。、；：,.;:!?]+$/, "");
}
