/**
 * 纯逻辑层：配置合并、源消息挑选、推理档位与标题长度处理。
 *
 * 本文件不导入任何依赖，便于独立验证。
 */

export const NS = "dsh-auto-rename";

/** Provider 身份标识，与标题来源标记一致。 */
export const PROVIDER_ID = NS;

/**
 * 未指定推理档位时的取值。
 *
 * 用显式值而非 undefined 表示「自动」，便于区分「未配置」并在界面回显。
 */
export const AUTO_EFFORT = "auto";

/**
 * 默认参数。
 *
 * 标题长度只用一个旋钮 targetCjkCharacters，按 2 倍换算成显示宽度预算，
 * 中英文共用：12 个中文字等于 24 个半角单位。英文不单独设词数上限。
 *
 * maxOutputTokens 默认 256。推理时思考与答案共享预算，过小的预算会让输出
 * 在 stop 之前撞上 max-tokens，导致标题为空。
 */
export const DEFAULTS = Object.freeze({
  targetCjkCharacters: 12,
  maxInputBytes: 4096,
  maxOutputTokens: 256,
  timeoutMs: 60000,
  suggestionCount: 3,
  autoRenameEnabled: true,
  allowUnlock: true,
  reasoningEffort: AUTO_EFFORT
});

/**
 * 推理预算下限。
 *
 * 推理模型的思考与答案共享预算，思考没有稳定上界，预算不足时会占满上限。
 * 下限取 4096，为答案留出余量。maxTokens 只是上限，标题较短时遇 stop 即返回，
 * 因此抬预算不增加正常生成的耗时；超时由 timeoutMs 约束。
 */
export const REASONING_TOKEN_FLOOR = 4096;

/**
 * 单次命名最多尝试几次（含首次）。
 *
 * 只对推理耗尽预算（stop 前先撞 max-tokens）重试：思考长度不定，
 * 同预算重跑可能成功。tool-calls、空文本等失败重跑结果相同，不重试。
 *
 * 每次尝试都拿满额的 timeoutMs。共用同一个超时会让重试只剩剩余预算，
 * 覆盖不了慢调用，代价是最坏总时长翻倍。
 */
export const TITLE_ATTEMPTS = 2;

/**
 * 表示「关闭推理」的档位标识，不同模型的写法不统一。
 *
 * 常见的是 off，也有模型声明为 none，两者语义相同。
 * 只在模型自己声明的档位列表里匹配这些标识，不推测其他写法。
 */
const OFF_EFFORT_IDS = Object.freeze(["off", "none"]);

/** 判断生效档位是否为「不思考」；modelInfo 用于确认该档位由模型声明。 */
function isReasoningOff(modelInfo, effort) {
  if (typeof effort !== "string") return false;
  if (!OFF_EFFORT_IDS.includes(effort)) return false;
  const ids = (Array.isArray(modelInfo?.reasoning?.efforts) ? modelInfo.reasoning.efforts : [])
    .map((entry) => entry?.id)
    .filter((id) => typeof id === "string");
  return ids.includes(effort);
}

/**
 * 选择本次调用要发送的推理档位。
 *
 * 两种策略：
 *  - auto（默认）：模型声明了关闭档就用它，否则退到支持的最低档（efforts 由低到高）。
 *  - 具体档位：显式指定就用它；模型未声明该档位时回退到 auto 的判断。
 *
 * 返回 undefined 表示不发送该参数：非推理模型，或拿不到模型能力。
 * 返回值始终取自模型声明的档位列表，不会出现列表外的 id。
 */
export function pickReasoningEffort(modelInfo, mode = AUTO_EFFORT) {
  const efforts = Array.isArray(modelInfo?.reasoning?.efforts) ? modelInfo.reasoning.efforts : [];
  if (efforts.length === 0) return undefined;
  const ids = efforts.map((effort) => effort?.id).filter((id) => typeof id === "string");
  if (typeof mode === "string" && mode !== AUTO_EFFORT && ids.includes(mode)) return mode;
  for (const offId of OFF_EFFORT_IDS) if (ids.includes(offId)) return offId;
  return efforts[0]?.id;
}

/**
 * 计算本次调用使用的 maxTokens。
 *
 * 两种情况沿用原值：模型不是推理模型，或最终生效档位是关闭推理。
 * 其余情况（含读不到模型能力）抬到下限。抬错只是多一个用不到的上限；
 * 抬对的收益是标题不再因思考吃光预算而为空。
 *
 * 这里的判断依据是最终生效档位，而非模型是否声明了关闭档：
 * 显式选了关闭档时，预算同样降回原值。
 */
export function reasoningBudget(modelInfo, maxOutputTokens, mode = AUTO_EFFORT) {
  const effort = pickReasoningEffort(modelInfo, mode);
  // 关闭推理：沿用原值。
  if (isReasoningOff(modelInfo, effort)) return maxOutputTokens;
  // 非推理模型（探测成功但没有档位）：沿用原值。
  if (effort === undefined && modelInfo !== undefined) return maxOutputTokens;
  // 其余情况（推理中，或读不到能力）：抬到下限。
  return Math.max(maxOutputTokens, REASONING_TOKEN_FLOOR);
}

/**
 * 供设置面板显示的推理能力报告。
 *
 * known 为 false 表示能力探测失败，与「不支持推理」区分。
 * requested 是配置的档位（auto 或具体 id），effort 是最终发出的档位。
 */
export function describeReasoning(modelInfo, maxOutputTokens, mode = AUTO_EFFORT) {
  const efforts = Array.isArray(modelInfo?.reasoning?.efforts) ? modelInfo.reasoning.efforts : [];
  const ids = efforts.map((effort) => effort?.id).filter((id) => typeof id === "string");
  const effort = pickReasoningEffort(modelInfo, mode) ?? null;
  return {
    known: modelInfo !== undefined,
    efforts: ids,
    defaultEffort: modelInfo?.reasoning?.defaultEffort,
    requested: typeof mode === "string" && mode !== "" ? mode : AUTO_EFFORT,
    effort,
    // 关闭推理与否由本模块判定后直接给出结论，调用方无需重复识别档位标识。
    off: isReasoningOff(modelInfo, effort),
    maxOutputTokens: reasoningBudget(modelInfo, maxOutputTokens, mode)
  };
}

/**
 * 取出 volatile 字段的真实值。
 *
 * volatile 字段在运行时是带 .get() 的引用对象，直接读会得到容器而非值。
 * 有 .get() 就取返回值；普通值原样返回。
 */
export function readVolatile(field) {
  if (field === undefined || field === null) return undefined;
  if (typeof field === "object" && typeof field.get === "function") return field.get();
  return field;
}

/** 一个英文词按 5 个字符加 1 个空格估算，占 6 个半角单位。 */
const AVERAGE_WORD_UNITS = 6;

function wordsForBudget(units) {
  return Math.max(1, Math.floor(units / AVERAGE_WORD_UNITS));
}

/**
 * 合并默认值与当前配置。
 *
 * provider 与 model 必须同时配置，否则 route 无效，在入口处拒绝。
 *
 * targetWords 在展开之后由宽度预算派生并覆盖同名字段，保证为正整数。
 * 按英文平均 6 个半角单位/词折算，使提示词目标与截断预算一致。
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
    // 派生值放在展开之后，确保 targetWords 由宽度预算计算而非沿用传入值。
    targetWords: wordsForBudget(titleWidthUnits(merged.targetCjkCharacters)),
    route: hasProvider ? { provider: merged.provider, model: merged.model } : undefined
  };
}

/**
 * 取最近 count 条非空人类消息。
 *
 * 从最新往前取，再翻回时间顺序。每条按字节预算裁剪，
 * 使拼帧后的 JSON 长度不超过 maxInputBytes。
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
 * 计算单条消息的字节预算。
 *
 * 预留 256 字节给帧的固定前缀与 JSON 结构，再除以 2 抵消
 * JSON.stringify 对换行、引号等字符转义时的膨胀。
 */
function rowBudget(maxInputBytes, rows) {
  return Math.max(64, Math.floor((maxInputBytes - 256) / rows / 2));
}

/** 按 UTF-8 字节数裁剪消息文本，seq 保持不变。 */
function clipToBytes(row, budget) {
  const bytes = new TextEncoder();
  if (bytes.encode(row.text).length <= budget) return row;
  let text = row.text;
  while (text.length > 0 && bytes.encode(text).length > budget) text = text.slice(0, -Math.ceil(text.length / 10));
  return { seq: row.seq, text };
}

// 匹配 emoji 主体、区域指示符、变体选择符、ZWJ 与 keycap；按码点匹配，不切碎代理对。
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D\u20E3]/gu;

/** 剥掉文本里的 emoji 与图形符号。 */
export function stripEmoji(text) {
  return String(text ?? "").replace(EMOJI, "");
}

/**
 * 从模型输出中取标题：取第一个非空行，剥掉整行包裹的星号强调。
 *
 * 只取第一行，模型可能把解释写在标题之后。
 * 返回前剥掉 emoji 与首尾空白。
 */
const EMPHASIS_WRAPPER = /^(?<marker>\*{1,3})(?<inner>\S(?:.*\S)?)\k<marker>$/u;

export function titleFromOutput(text) {
  const line = String(text ?? "").split(/\r?\n/u).map((item) => item.trim()).find((item) => item.length > 0) ?? "";
  const groups = EMPHASIS_WRAPPER.exec(line)?.groups;
  const marker = groups?.marker;
  const inner = groups?.inner;
  const title = marker === undefined || inner === undefined || inner.includes(marker) ? line : inner;
  return stripEmoji(title).trim();
}

/**
 * 从执行层返回值中提取标题。
 *
 * 返回值形如 { blocks, finish, model }。只接受正常 stop 且不含 tool-call 的结果，
 * 其余情况抛错交给上层记录。
 */
export function titleFromResponse(response) {
  const finish = response?.finish?.kind;
  if (finish === "tool-calls") throw new Error("session-title-llm: title output must contain text only");
  if (finish === "max-tokens") throw new Error("session-title-llm: title output reached maxOutputTokens");
  if (finish !== "stop") throw new Error(`session-title-llm: unexpected finish "${String(finish)}"`);
  const blocks = Array.isArray(response.blocks) ? response.blocks : [];
  if (blocks.some((block) => block?.type === "tool-call")) {
    throw new Error("session-title-llm: title output must contain text only");
  }
  const text = blocks.filter((block) => block?.type === "text").map((block) => block.text).join(" ");
  const title = titleFromOutput(text);
  if (title.length === 0) throw new Error("session-title-llm: title model produced no text");
  return title;
}

/**
 * 拼装命名提示词。
 *
 * 要求只返回一行标题；有既有标题时追加四条稳定性规则，避免无谓改写。
 */
export function buildSystemPrompt(config, hasCurrentTitle) {
  return [
    "Create a concise title for an AI coding-assistant session from the supplied human messages.",
    "Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.",
    "Do not include emojis, pictographs, or decorative symbols in the title.",
    "Use the language of the messages.",
    `Aim for about ${config.targetWords} words in non-CJK languages or ${config.targetCjkCharacters} CJK characters.`,
    "If the messages give little to name, still return a short best-effort title, such as Greeting, instead of explaining.",
    ...(hasCurrentTitle
      ? [
          "An existing title is supplied as currentTitle. Compare it against the topic of the messages below, not against an earlier version of the title.",
          'If the messages stay on the same topic — follow-up questions, added detail, acknowledgements such as "thanks", and requests to continue — return it exactly unchanged; do not reword, polish, or swap in synonyms.',
          "If the messages introduce a different or expanded topic, task, or problem that the current title no longer describes, write a new title that names the current topic. Do not keep a title that has become inaccurate.",
          "Decide only from the messages supplied now: a title that still fits is kept byte-for-byte, one that no longer fits is replaced even if it was accurate earlier."
        ]
      : [])
  ].join("\n");
}

/**
 * 超长标题的缩短重试提示词。
 *
 * 长度要求在提示词里是软约束，首次输出可能超预算。把已生成的标题交回模型，
 * 要求保留语义并压到预算内，避免硬截断丢掉后半句或切坏词。
 * 只重试一次，仍超长则回落到 clampTitle。
 */
export function buildShortenPrompt(config) {
  return [
    "A session title was generated but it is too long for the interface.",
    `Rewrite the same title to fit within ${config.targetCjkCharacters} CJK characters (or ${titleWidthUnits(config.targetCjkCharacters)} half-width units); 1 CJK character counts as 2 units.`,
    "Keep the meaning and the topic exactly; only make it shorter. Do not introduce new information.",
    "Do not include emojis, pictographs, or decorative symbols in the title.",
    "Return only the shortened title on one line, in plain text of natural language, with no quotes, prefix, explanation, Markdown, or code."
  ].join("\n");
}

/** 缩短重试的输入：只回显标题本身，不带消息，避免模型改动话题。 */
export function frameShorten(title) {
  return `Shorten this session title to the required length:\n${title}`;
}

/** 把消息装进 JSON 再交给模型，使消息文本无法伪造结构分隔符。 */
export function frameMessages(messages, currentTitle) {
  if (currentTitle !== undefined) {
    return `Update the session title from this JSON object:\n${JSON.stringify({ currentTitle, messages })}`;
  }
  return `Generate the session title from this JSON array of human messages:\n${JSON.stringify(messages)}`;
}

/**
 * 按显示宽度硬截断标题，而非按字符数。
 *
 * 一个中日韩字占 2 个半角单位，其余字符（含空格）占 1 个。
 * 预算为中文字数上限的 2 倍，因此 12 个中文字与 24 个半角字符等宽，
 * 英文无需单设上限。
 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/;

/** 标题的显示宽度预算（半角单位）。 */
export function titleWidthUnits(maxCjkCharacters) {
  return maxCjkCharacters * 2;
}

/**
 * 判断标题是否超出显示宽度预算，不截断。
 *
 * 口径与 clampTitle 一致（CJK 记 2 单位，其余含空格记 1），供缩短重试判断结果是否合格。
 * 整段无空格的超长文本（URL、路由）虽被 clampTitle 放弃截断，这里仍算超预算，
 * 以便缩短逻辑再处理一次。
 */
export function titleExceedsBudget(title, maxCjkCharacters) {
  if (typeof title !== "string" || title === "") return false;
  const budget = titleWidthUnits(maxCjkCharacters);
  let used = 0;
  for (let index = 0; index < title.length; index++) {
    used += CJK.test(title[index]) ? 2 : 1;
    if (used > budget) return true;
  }
  return false;
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
  // 切进拉丁词中间会留下残词，能回退到上一个空格就回退。
  // 整段没有空格（标识符、URL）时无法回退，此时保留原样：超宽比残词可接受。
  if (!CJK.test(title[cut]) && !/\s/.test(title[cut])) {
    const lastSpace = head.lastIndexOf(" ");
    if (lastSpace <= 0) return title;
    head = head.slice(0, lastSpace);
  }
  return head.replace(/[\s，。、；：,.;:!?]+$/, "");
}
