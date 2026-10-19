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
 * 用户没指定档位时的取值（`reasoningEffort` 配置项）。
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
 * 上限 —— 单词字符数不一致，按词数约束没有意义（用户 2026-10-14）。
 *
 * 其余值与 dsh-base 的 session-title-first-prompt-llm 一致（官方
 * targetCjkCharacters 是 10，这里按用户要求放宽到 12）。
 *
 * ⚠️ maxOutputTokens 默认 256，**不是**官方的 64。官方 64 只在非推理模型上够用：
 * 推理模型会先用预算产出 reasoning 块，64 token 时 finish.kind 直接是 max-tokens、
 * 标题为空。2026-10-18 实测阈值：64 必失败 / 128 起成功 / 256 稳定。
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
 * 推理模型与答案共享 max_tokens：@earendil-works/pi-ai 的 simple-options 里
 * MIN_ANSWER_TOKENS = 1024，预算不足时它把 thinking budget 压成 0 却照样发
 * reasoning_effort，模型照样思考、照样吃 token。
 *
 * 实测（同一个推理模型，按预算分组的截断率）：64 全部被吃光、256 全部、
 * 1024 全部（reasoning=1023/1024，答案 0 token）、2048 也有一次全吃光
 * （reasoning=2048 → stop=length、27 秒、标题为空）。成功案例的 reasoning 跨度
 * 325–3172，方差极大且 effort=low 也不收敛 —— 这个模型的思考长度基本无上限。
 *
 * 所以取 schema 允许的上限 4096 当地板：覆盖已观测到的最坏 3172，留约 900 token
 * 给答案。maxTokens 只是上限，标题写不到那么长，stop 即返回，抬预算不拖慢正常
 * 生成；真正的护栏是 timeoutMs（默认 60 秒）。
 *
 * ⚠️ 这个数是实测校准值，不是理论值：换模型（尤其换到推理更啰嗦的）后要重测。
 */
export const REASONING_TOKEN_FLOOR = 4096;

/**
 * 单次命名最多试几次（含首次）。
 *
 * 只对「推理把预算吃光」（finish=stop 前先撞 max-tokens）重试：这个模型的思考
 * 长度是随机的（实测 325–3172），同预算重跑的期望成功率远高于 0。其他失败
 * （tool-calls、空文本）重跑结果一样，不重试。
 *
 * ⚠️ 不要调大：每次重试都是一次完整 LLM 调用，而自动命名在 all-prompts 节拍下
 * 每轮都可能触发。2 次已经把「偶发吃满」的漏标率压到可接受。
 *
 * 每次重试拿**满额** timeoutMs（见 lib/index.js 的 attemptSignal）：两次尝试若
 * 共用一份 60 秒预算，第一次用掉 40 秒后重试只剩 20 秒，慢模型（实测单次
 * 25–40 秒）就永远赶不上，重试等于白试。代价是最坏总时长翻倍 —— 由
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
 *  - 具体档位 —— 用户显式指定就照办；但模型若没声明这一档（换模型后残留的旧
 *    配置），退回 auto 的判断而不是硬发。
 *
 * 返回 undefined 表示不发送该参数 —— 非推理模型，或调用方拿不到模型能力。
 *
 * ⚠️ 绝不能返回模型不支持的 id：宿主 resolveCallWithInfo 会抛
 * UNSUPPORTED_REASONING_EFFORT，整次命名直接失败。这里只从模型自己声明的
 * 列表里挑，所以不可能越界 —— 显式档位也一样要过这道校验。
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
 * 判断依据是**最终生效的档位**，不是「模型有没有关闭档」：用户显式选了它时
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
 * `requested` 是用户配的档位（auto 或具体 id），`effort` 是最终真发出去的。
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
 * 取最近 count 条人类消息。
 *
 * 自动命名（all-prompts 节拍）与手动弹窗建议共用：都从最新往前取，再翻回
 * 时间顺序；每条都按字节预算裁剪，保证官方 frameMessages 的 JSON.stringify
 * 不会超过 maxInputBytes（超了它会直接抛错，表现为「没被命名」/「建议获取失败」）。
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
 * 从模型输出里取标题：第一个非空行，剥掉整行包裹的 `*`/`**`/`***` 强调。
 *
 * 与官方 all-prompts provider 的 titleFromOutput 逐字一致 —— 模型不守「只回
 * 一行」的规矩时会把标题写在最前面、解释跟在后面，所以只认第一行。
 */
const EMPHASIS_WRAPPER = /^(?<marker>\*{1,3})(?<inner>\S(?:.*\S)?)\k<marker>$/u;

export function titleFromOutput(text) {
  const line = String(text ?? "").split(/\r?\n/u).map((item) => item.trim()).find((item) => item.length > 0) ?? "";
  const groups = EMPHASIS_WRAPPER.exec(line)?.groups;
  const marker = groups?.marker;
  const inner = groups?.inner;
  return marker === undefined || inner === undefined || inner.includes(marker) ? line : inner;
}

/**
 * 从 executeSessionTitleLlm 的返回里取标题。
 *
 * 它返回的是 `{ blocks, finish, model }`，**不是**标题字符串（旧版
 * generateSessionTitleWithLlm 才返回标题）。所以收尾判定得自己做：
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
 * 前半段与官方 all-prompts 一致；有旧标题时追加的四条稳定性规则也照抄 ——
 * 少了它们，每轮刷新都会把标题改写成同义词，标题就一直在抖。
 */
export function buildSystemPrompt(config, hasCurrentTitle) {
  return [
    "Create a concise title for an AI coding-assistant session from the supplied human messages.",
    "Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.",
    "Use the language of the messages.",
    `Aim for about ${config.targetWords} words in non-CJK languages or ${config.targetCjkCharacters} CJK characters.`,
    "If the messages give little to name, still return a short best-effort title, such as Greeting, instead of explaining.",
    ...(hasCurrentTitle
      ? [
          "An existing title is supplied as currentTitle. If it still accurately describes the main topic or task, return it exactly unchanged.",
          'Follow-up questions, additional details within the same topic, acknowledgements such as "thanks", and requests to continue do not by themselves justify a title change.',
          "Do not reword, polish, shorten, or replace synonyms in an adequate title. Keeping its exact wording takes priority over the target length.",
          "Change the title only when the messages materially change or expand the main topic or task so that the existing title is no longer accurate."
        ]
      : [])
  ].join("\n");
}

/** 把消息装进 JSON 再交给模型：用户文本因此无法伪造结构分隔符。 */
export function frameMessages(messages, currentTitle) {
  if (currentTitle !== undefined) {
    return `Update the session title from this JSON object:\n${JSON.stringify({ currentTitle, messages })}`;
  }
  return `Generate the session title from this JSON array of human messages:\n${JSON.stringify(messages)}`;
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
