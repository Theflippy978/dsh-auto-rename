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
 * 未指定档位时的取值（`reasoningEffort` 配置项）。
 *
 * 不用 undefined 当「自动」：schemastery 的 volatile 字段解不出 undefined 与
 * 「没配」的区别，界面上也没法回显一个空下拉。
 */
export const AUTO_EFFORT = "auto";

/**
 * 默认参数。
 *
 * 标题长度只有**一个**旋钮：targetCjkCharacters。它换算成显示宽度预算 = ×2 个
 * 半角单位，中英文共用（12 字 = 24 单位 = 英文 24 个字符含空格）。英文不设词数
 * 上限 —— 单词字符数不一致，按词数约束没有意义。
 *
 * 默认值 targetCjkCharacters 取 12，换算为 24 个半角单位。
 *
 * maxOutputTokens 默认 256，避免推理预算不足导致标题为空。
 * 预算过小时推理会吃光 tokens，使 finish.kind 变为 max-tokens。
 * 上限只在 stop 之前生效，不会拖慢正常生成。
 */
export const DEFAULTS = Object.freeze({
  targetCjkCharacters: 12,
  maxInputBytes: 4096,
  maxOutputTokens: 256,
  timeoutMs: 60000,
  suggestionCount: 3,
  autoRenameEnabled: true,
  reasoningEffort: AUTO_EFFORT
});

/**
 * 推理预算下限。
 *
 * 推理模型的思考与答案共享预算，预算不足时思考会占满上限。
 *
 * 思考长度随机且无稳定上界，需以预算上限兜底。
 *
 * 下限取 schema 允许的上限 4096，为答案留出余量。maxTokens 只是上限，标题写不到
 * 那么长，stop 即返回，抬预算不拖慢正常生成；真正的护栏是 timeoutMs（默认 60 秒）。
 *
 * 该下限是当前模型能力下的固定取值。
 */
export const REASONING_TOKEN_FLOOR = 4096;

/**
 * 单次命名最多试几次（含首次）。
 *
 * 只对「推理把预算吃光」（finish=stop 前先撞 max-tokens）重试：这个模型的思考
 * 思考长度随机，同预算重跑有成功可能。其他失败
 * （tool-calls、空文本）重跑结果一样，不重试。
 *
 * 重试次数取 2，上限受调用成本约束。
 *
 * 每次重试拿**满额** timeoutMs（见 lib/index.js 的 attemptSignal）：共用超时会让
 * 重试只剩剩余预算，无法覆盖慢调用。代价是最坏总时长翻倍 —— 由
 * 「标题不该因为预算不够而静默失败」这个优先级换来的。
 */
export const TITLE_ATTEMPTS = 2;

/**
 * 「关掉推理」这一档在不同网关里叫什么，是不统一的。
 *
 * 常见写法是 `off`，也有模型把它声明成 `none`。两者语义相同：发出去之后模型不
 * 思考、只出答案。写死只认 `off` 会漏掉后者 —— 那种情况下推理其实真被关掉了，
 * 预算却照样被抬到地板，白给一个用不到的上限。
 *
 * 只在**模型自己声明的列表**里认这些名字，不去猜别的。
 */
const OFF_EFFORT_IDS = Object.freeze(["off", "none"]);

/** 这个最终生效的档位是不是「不思考」。modelInfo 用来限定「模型真声明了它」。 */
function isReasoningOff(modelInfo, effort) {
  if (typeof effort !== "string") return false;
  if (!OFF_EFFORT_IDS.includes(effort)) return false;
  const ids = (Array.isArray(modelInfo?.reasoning?.efforts) ? modelInfo.reasoning.efforts : [])
    .map((entry) => entry?.id)
    .filter((id) => typeof id === "string");
  return ids.includes(effort);
}

/**
 * 该给模型发哪个推理档位。
 *
 * 两档策略：
 *  - `auto`（默认）—— 命名是短任务，不值得开推理。模型声明了「关闭档」就真关掉；
 *    没声明就退到它支持的最低档（efforts 顺序由低到高）。
 *  - 具体档位 —— 显式指定就照办；但模型若没声明这一档（换模型后残留的旧
 *    配置），退回 auto 的判断而不是硬发。
 *
 * 返回 undefined 表示不发送该参数 —— 非推理模型，或调用方拿不到模型能力。
 *
 * 只从模型声明的档位列表中返回，避免越界 id。
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
 * 本次调用该给多大的 maxTokens。
 *
 * 只有两种情况不必抬预算：模型明确不是推理模型，或者真能把推理关掉（关闭档的
 * id 见 OFF_EFFORT_IDS，`off` 与 `none` 都算）。其余（含「读不到模型能力」）一律
 * 抬到下限 —— 猜错只是多一个用不到的上限，猜对的收益是标题不再因为被思考吃光
 * 而静默失败。
 *
 * 注意这只管「上限给多大」：某些网关会把档位再映射到别处，声明了关闭档也可能
 * 照旧思考。那种情况由 TITLE_ATTEMPTS 的重试兜住，不由这里的猜测兜住。
 *
 * 判断依据是**最终生效的档位**，不是「模型有没有关闭档」：显式选了它时
 * 预算也该降回原值。
 */
export function reasoningBudget(modelInfo, maxOutputTokens, mode = AUTO_EFFORT) {
  const effort = pickReasoningEffort(modelInfo, mode);
  // 能真关掉推理 → 预算不用抬。
  if (isReasoningOff(modelInfo, effort)) return maxOutputTokens;
  // 确认不是推理模型（探测成功但没有档位）→ 也不用抬。
  if (effort === undefined && modelInfo !== undefined) return maxOutputTokens;
  // 其余（在推理，或压根读不到）→ 抬到地板。
  return Math.max(maxOutputTokens, REASONING_TOKEN_FLOOR);
}

/**
 * 给设置面板的推理能力报告。
 *
 * `known:false` = 探测失败，界面据此说「读不到」，而不是谎报「不支持推理」。
 * `requested` 是配置的档位（auto 或具体 id），`effort` 是最终真发出去的。
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
    // 「这次真把推理关掉了」由 host 判定，界面只念结论。关闭档的 id 在不同网关
    // 叫法不一（见 OFF_EFFORT_IDS），client 半边是另一个 bundle、拿不到那份
    // 名单，各写一套迟早对不上。
    off: isReasoningOff(modelInfo, effort),
    maxOutputTokens: reasoningBudget(modelInfo, maxOutputTokens, mode)
  };
}

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
 * 合并默认值与当前配置。
 *
 * provider/model 必须成对出现：只配一个会让 route 失效，因此在入口拒绝并给出明确报错。
 *
 * targetWords 从宽度预算派生，写在展开之后以覆盖同名字段，且需为正整数。按
 * 「英文平均 6 个半角单位/词」折算，使提示词的目标与硬截断的预算一致，避免
 * 模型写出来再被截。
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
    // 派生值写在展开之后，确保 targetWords 由宽度预算计算而非沿用传入值。
    targetWords: wordsForBudget(titleWidthUnits(merged.targetCjkCharacters)),
    route: hasProvider ? { provider: merged.provider, model: merged.model } : undefined
  };
}

/**
 * 取最近 count 条人类消息。
 *
 * 自动命名（all-prompts 节拍）与手动弹窗建议共用：都从最新往前取，再翻回
 * 时间顺序；每条都按字节预算裁剪，拼帧后的 JSON 长度必须不超过 maxInputBytes，
 * 否则会抛错。
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

// emoji 主体、区域指示符、变体选择符、ZWJ、keycap；按码点匹配，不切碎代理对。
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D\u20E3]/gu;

/** 剥掉文本里的 emoji 与图形符号。 */
export function stripEmoji(text) {
  return String(text ?? "").replace(EMOJI, "");
}

/**
 * 从模型输出里取标题：第一个非空行，剥掉整行包裹的 `*`/`**`/`***` 强调。
 *
 * 只认第一行，因为模型可能把解释写在标题之后。
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
 * 从 executeSessionTitleLlm 的返回里取标题。
 *
 * 返回结构是 { blocks, finish, model }，需自行判定收尾并提取文本：
 * 只接受正常 stop、且没有任何 tool-call block，否则抛错让上层记日志。
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
 * 拼提示词。
 *
 * 提示词要求只返回一行标题，已有标题时追加四条稳定性规则以防抖动。
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
 * 超长后的「缩短重试」提示词。
 *
 * 第一次输出常常超过预算（Aim for about 是软要求）。与其让 clampTitle 硬切
 * （切掉后半句、切坏词），不如把已经生成的标题交回模型，要求它保留语义压到
 * 预算内。只调一次，仍超长就回落到 clampTitle，不为省几个字反复烧调用。
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

/** 把超长标题交给模型缩短时用的输入：只回显标题本身，不塞消息，避免它借机改话题。 */
export function frameShorten(title) {
  return `Shorten this session title to the required length:\n${title}`;
}

/** 把消息装进 JSON 再交给模型：消息文本因此无法伪造结构分隔符。 */
export function frameMessages(messages, currentTitle) {
  if (currentTitle !== undefined) {
    return `Update the session title from this JSON object:\n${JSON.stringify({ currentTitle, messages })}`;
  }
  return `Generate the session title from this JSON array of human messages:\n${JSON.stringify(messages)}`;
}

/**
 * 硬截断标题长度。
 *
 * 宿主不设有效的标题截断上限，长度需自行约束。
 *
 * 按显示宽度算，不按字符数：一个中日韩字占 2 个半角单位，其余（含空格）占 1 个。
 * 预算 = 中文字数上限 × 2，所以「中文 12 字」与「英文 24 字符（含空格）」等宽，
 * 不必再为英文单设一个数。
 *
 * 宿主另有一层更宽松的字节兜底，管不住长度，仍需自行截断。
 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/;

/** 标题的显示宽度预算（半角单位）。 */
export function titleWidthUnits(maxCjkCharacters) {
  return maxCjkCharacters * 2;
}

/**
 * 标题是否超出显示宽度预算。
 *
 * 与 clampTitle 同一套口径（CJK = 2 单位，其余含空格 = 1），但只回答「超没超」，
 * 不截断。缩短重试用它判断模型这次听没听进去长度要求。
 * 超长但整段无空格可退（URL、路由）时 clampTitle 会放弃截断——这里仍算超预算，
 * 让缩短逻辑有机会处理；处理不了再回到 clampTitle 的原样放行。
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
