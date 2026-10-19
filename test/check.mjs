/**
 * 本插件唯一有分支的逻辑的自检：配置合并 + 源消息挑选。
 *
 * 无框架、无 fixture，直接 `node test/check.mjs`。这两处一旦写错，症状分别是
 * 「改了设置没反应」和「拿不到消息所以永不命名」——都不会报错，所以必须由
 * 断言守住。
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  DEFAULTS,
  REASONING_TOKEN_FLOOR,
  buildSystemPrompt,
  clampTitle,
  describeReasoning,
  frameMessages,
  pickReasoningEffort,
  pickRecentMessages,
  readVolatile,
  reasoningBudget,
  resolveConfig,
  titleFromOutput,
  titleFromResponse,
  titleWidthUnits
} from "../lib/config.js";

// ---- readVolatile：schemastery volatile 引用必须解包 ----
// 这是实测踩到的坑：volatile 字段运行时是 {get(){...}} 引用对象，直接读拿到 {},
// 表现为「设置改了没反应」且不报错。用真实 schemastery 的 Config 造一个来守。
{
  let z;
  try {
    z = createRequire(import.meta.url)("@deepseek-ai/schemastery");
  } catch {
    z = undefined;
  }
  if (z === undefined) {
    console.log("check: schemastery not linked, volatile regression check skipped");
  } else {
    const Schema = z.default ?? z;
    const VolatileConfig = Schema.object({
      suggestionCount: Schema.number().step(1).min(1).max(5).volatile(),
      autoRenameEnabled: Schema.boolean().volatile()
    });
    const resolved = VolatileConfig({ suggestionCount: 4 });
    // 先确认前提成立：未解包时确实是对象（否则这个回归测试没有意义）
    assert.equal(typeof resolved.suggestionCount, "object", "volatile value must be a ref object (premise)");
    assert.equal(readVolatile(resolved.suggestionCount), 4, "readVolatile must unwrap the ref");
    assert.equal(resolveConfig(resolved).suggestionCount, 4, "resolveConfig must unwrap volatile refs");
    assert.equal(typeof resolveConfig(resolved).suggestionCount, "number");
    // 未设置的 volatile 字段解出来是 undefined，不能覆盖默认值
    assert.equal(resolveConfig(resolved).autoRenameEnabled, DEFAULTS.autoRenameEnabled);
  }
}

// ---- readVolatile：裸值原样返回 ----
assert.equal(readVolatile(5), 5);
assert.equal(readVolatile("x"), "x");
assert.equal(readVolatile(true), true);
assert.equal(readVolatile(undefined), undefined);
assert.equal(readVolatile(null), undefined);
assert.equal(readVolatile({ get: () => 42 }), 42);

// ---- resolveConfig ----

// 空配置：全默认，无显式路由（跟随对话主模型）
const empty = resolveConfig();
assert.equal(empty.route, undefined, "empty config must not pin a route");
assert.equal(empty.targetCjkCharacters, 12, "empty config keeps defaults");
assert.equal(empty.autoRenameEnabled, true, "auto rename is on by default");

// 显式成对：解出 route
const paired = resolveConfig({ provider: "acme", model: "nested/main" });
assert.deepEqual(paired.route, { provider: "acme", model: "nested/main" });

// 半对必须抛错（静默失效是最坏的结果）
assert.throws(() => resolveConfig({ provider: "acme" }), /must be configured together/);
assert.throws(() => resolveConfig({ model: "nested/main" }), /must be configured together/);

// 空字符串等同于未设置，不算「配了 provider」
assert.equal(resolveConfig({ provider: "", model: "" }).route, undefined);

// 覆盖生效，且未覆盖的字段保持默认
const overridden = resolveConfig({ suggestionCount: 2 });
assert.equal(overridden.suggestionCount, 2);
assert.equal(overridden.maxOutputTokens, DEFAULTS.maxOutputTokens);

// undefined 值不得覆盖默认（schemastery volatile 未设置时就是 undefined）
assert.equal(resolveConfig({ suggestionCount: undefined }).suggestionCount, DEFAULTS.suggestionCount);

// ---- targetWords 是派生值，不是用户旋钮 ----
// 用户口径：英文不设词数上限，只受「中文 12 字」换算出的显示宽度约束。
// 但官方提示词要求它是正整数，所以从宽度预算折算：
// 预算 = 字数 × 2 个半角单位，一个英文词按 6 单位估。
assert.equal(resolveConfig().targetWords, 4, "12 CJK -> 24 units -> 4 words");
// 用户存过的 targetWords 必须被派生值覆盖，否则它又变回第二个旋钮
assert.equal(resolveConfig({ targetWords: 99 }).targetWords, 4, "a stored targetWords is ignored");
assert.equal(
  resolveConfig({ targetCjkCharacters: 24 }).targetWords,
  8,
  "the derived word target tracks the width knob, not a fixed number"
);
assert.equal(
  resolveConfig({ targetCjkCharacters: 1 }).targetWords,
  1,
  "the shared implementation asserts targetWords is a positive integer"
);

// 关闭自动命名时仍要能解出配置（建议功能依赖它）
assert.equal(resolveConfig({ autoRenameEnabled: false }).autoRenameEnabled, false);

// ---- pickRecentMessages：自动命名与手动建议共用 ----

// 取最后 count 条，并保持时间顺序（不是倒序）
assert.deepEqual(
  pickRecentMessages([{ seq: 1, text: "a" }, { seq: 2, text: "b" }, { seq: 3, text: "c" }], 2),
  [{ seq: 2, text: "b" }, { seq: 3, text: "c" }],
  "must take the most recent rows in chronological order"
);

// 不足 count 时有多少给多少
assert.deepEqual(pickRecentMessages([{ seq: 1, text: "a" }], 3), [{ seq: 1, text: "a" }]);

// 跳过空白，且坏输入不抛
assert.deepEqual(pickRecentMessages([{ seq: 1, text: "  " }, { seq: 2, text: "b" }], 1), [{ seq: 2, text: "b" }]);
assert.deepEqual(pickRecentMessages([], 3), []);
assert.deepEqual(pickRecentMessages(undefined, 3), []);

// 字节预算：多条长消息必须整体落在 maxInputBytes 内。
// 官方 frameMessages 会 JSON.stringify 整个数组，超了它就抛错，
// 表现为「没被命名」/「建议获取失败」，所以裁剪只能在我们这边做。
const long = "问".repeat(2000); // 每个 3 字节
const budgeted = pickRecentMessages(
  [{ seq: 1, text: long }, { seq: 2, text: long }, { seq: 3, text: long }],
  3,
  4096
);
assert.equal(budgeted.length, 3);
assert.ok(
  Buffer.byteLength(JSON.stringify(budgeted), "utf8") <= 4096,
  `framed input must fit maxInputBytes, got ${Buffer.byteLength(JSON.stringify(budgeted), "utf8")}`
);
// seq 必须原样保留：它要进 session/title-llm-request 审计事件
assert.deepEqual(budgeted.map((row) => row.seq), [1, 2, 3]);

// 自动命名取 6 条（AUTO_SOURCE_MESSAGES）：条数多了预算摊薄，但整体仍必须守住
const many = Array.from({ length: 8 }, (_, index) => ({ seq: index + 1, text: long }));
const autoRows = pickRecentMessages(many, 6, 4096);
assert.equal(autoRows.length, 6, "auto naming takes the last 6 messages");
assert.deepEqual(autoRows.map((row) => row.seq), [3, 4, 5, 6, 7, 8]);
assert.ok(
  Buffer.byteLength(JSON.stringify(autoRows), "utf8") <= 4096,
  `auto framing must fit maxInputBytes, got ${Buffer.byteLength(JSON.stringify(autoRows), "utf8")}`
);

// ---- titleFromOutput：模型不守「只回一行」时只认第一行 ----
assert.equal(titleFromOutput("重构插件接线"), "重构插件接线");
// 标题在第一行、解释跟在后面
assert.equal(titleFromOutput("重构插件接线\n\n说明：改了 provider"), "重构插件接线");
assert.equal(titleFromOutput("  前后空白  "), "前后空白");
// 整行被星号包裹时剥掉（Markdown 强调）
assert.equal(titleFromOutput("**重构插件接线**"), "重构插件接线");
assert.equal(titleFromOutput("*单个星号*"), "单个星号");
// 星号出现在内部说明不是包裹，保留原样
assert.equal(titleFromOutput("**a** and **b**"), "**a** and **b**");
assert.equal(titleFromOutput(""), "");
assert.equal(titleFromOutput(undefined), "");

// ---- titleFromResponse：收尾判定 ----
const textBlock = (text) => ({ type: "text", text });
assert.equal(
  titleFromResponse({ finish: { kind: "stop" }, blocks: [textBlock("会话标题")] }),
  "会话标题"
);
// 多个 text block 用空格拼接，仍只取第一行
assert.equal(
  titleFromResponse({ finish: { kind: "stop" }, blocks: [textBlock("会话"), textBlock("标题")] }),
  "会话 标题"
);
// tool-calls / max-tokens / 未知收尾都必须抛错，否则会把半截输出当标题
assert.throws(
  () => titleFromResponse({ finish: { kind: "tool-calls" }, blocks: [] }),
  /must contain text only/
);
assert.throws(
  () => titleFromResponse({ finish: { kind: "max-tokens" }, blocks: [] }),
  /reached maxOutputTokens/
);
assert.throws(() => titleFromResponse({ finish: { kind: "error" }, blocks: [] }), /unexpected finish/);
// 收尾正常但夹了 tool-call block 也不行
assert.throws(
  () => titleFromResponse({ finish: { kind: "stop" }, blocks: [{ type: "tool-call" }] }),
  /must contain text only/
);
// 空输出
assert.throws(() => titleFromResponse({ finish: { kind: "stop" }, blocks: [] }), /produced no text/);
assert.throws(
  () => titleFromResponse({ finish: { kind: "stop" }, blocks: [textBlock("   ")] }),
  /produced no text/
);

// ---- buildSystemPrompt / frameMessages ----
const prompt = buildSystemPrompt({ targetWords: 4, targetCjkCharacters: 12 }, false);
assert.ok(prompt.includes("about 4 words"), "the prompt must carry the derived word target");
assert.ok(prompt.includes("12 CJK characters"), "the prompt must carry the CJK target");
assert.ok(!prompt.includes("currentTitle"), "no anchor rules when there is no current title");
// 有锚点时追加四条稳定性规则，否则每轮刷新都会把标题改写成同义词
const anchored = buildSystemPrompt({ targetWords: 4, targetCjkCharacters: 12 }, true);
assert.ok(anchored.includes("currentTitle"));
assert.ok(anchored.includes("return it exactly unchanged"));
assert.ok(anchored.includes("Do not reword, polish"));
assert.ok(anchored.length > prompt.length);

const rows = [{ seq: 1, text: "第一句" }];
assert.equal(
  frameMessages(rows, undefined),
  `Generate the session title from this JSON array of human messages:\n${JSON.stringify(rows)}`
);
assert.equal(
  frameMessages(rows, "旧标题"),
  `Update the session title from this JSON object:\n${JSON.stringify({ currentTitle: "旧标题", messages: rows })}`
);

// ---- clampTitle：官方完全不截，长度只能自己守 ----
// 口径是显示宽度（半角单位）：中日韩字算 2，其余含空格算 1。
// 预算 = 中文字数上限 × 2，所以「中文 12 字」与「英文 24 字符（含空格）」等宽，
// 不必再为英文单设一个数（用户 2026-10-14 的口径）。

assert.equal(titleWidthUnits(12), 24, "12 CJK chars budget 24 half-width units");
assert.equal(clampTitle("代码改动审阅与大量提问", 12), "代码改动审阅与大量提问", "11 CJK = 22 units, inside the 24 budget");
assert.equal(clampTitle("一二三四五六七八九十甲乙丙丁", 12), "一二三四五六七八九十甲乙", "hard cap at 12 CJK");
// 顿号是宽字符，同样占 2 个单位：预算 8 只装得下「一二、三」
assert.equal(clampTitle("一二、三四五", 4), "一二、三", "wide punctuation counts toward the width");
assert.equal(clampTitle("短标题、后面还有很长的话", 3), "短标题", "a trailing separator is dropped");
// 拉丁按字符算：24 单位 = 24 个英文字符（含空格）
assert.equal(clampTitle("Rename sessions", 12), "Rename sessions", "15 units is inside 24");
assert.equal(clampTitle("Rename sessions automatically", 12), "Rename sessions", "cuts at the last whole word");
// 整段没有空格时（标识符、URL、provider/model 路由）宁可不截：残词比超宽更糟，
// 宿主那层 maxTitleBytes（80 字节）仍会兜住极端长度。
// 必须用**超过** 24 单位的串：恰好 24 字符根本不进截断分支，断言就成了恒真废话。
assert.equal(
  clampTitle("acme/nested/main-longer", 12),
  "acme/nested/main-longer",
  "a single unbreakable token is left whole rather than chopped"
);
assert.equal(clampTitle("", 12), "");
assert.equal(clampTitle(undefined, 12), undefined);

// ---- 推理档位：关得掉就关，关不掉退最低档，非推理模型不传 ----
// 用户四项要求的第 1、2 条全落在这一个函数里。选错的症状是「命名悄悄多花几秒
// 且偶尔超长失败」，不报错，所以必须由断言守住。
{
  const efforts = (...ids) => ({ reasoning: { efforts: ids.map((id) => ({ id, name: id })) } });

  // 非推理模型 / 探测失败：不发送该参数。宿主对「没声明 reasoning 却传了档位」
  // 会抛 UNSUPPORTED_REASONING_EFFORT，所以这里必须是 undefined。
  assert.equal(pickReasoningEffort(undefined), undefined, "no model info → no effort is sent");
  assert.equal(pickReasoningEffort({}), undefined, "a model without reasoning → no effort is sent");
  assert.equal(pickReasoningEffort(efforts()), undefined, "an empty effort list → no effort is sent");

  // 声明了 off 就真关（第 1 条）。
  assert.equal(pickReasoningEffort(efforts("off", "low", "high")), "off", "off wins when the model offers it");
  assert.equal(pickReasoningEffort(efforts("low", "high", "off")), "off", "order does not matter");

  // 没有 off 就退最低档（第 2 条）。efforts 顺序即由低到高。
  assert.equal(pickReasoningEffort(efforts("low", "high", "max")), "low", "no off → the lowest effort");
  assert.equal(pickReasoningEffort(efforts("minimal")), "minimal", "a single effort is the lowest one");

  // 绝不返回模型没声明的 id —— 那会抛 UNSUPPORTED_REASONING_EFFORT，整次命名失败。
  for (const info of [undefined, {}, efforts(), efforts("low", "high"), efforts("off", "low")]) {
    const picked = pickReasoningEffort(info);
    if (picked !== undefined) {
      assert.ok(
        info.reasoning.efforts.some((effort) => effort.id === picked),
        `picked "${picked}" must come from the model's own list`
      );
    }
  }

  // 用户显式指定档位：模型有这个档位就照办（auto 的判断让位）。
  assert.equal(pickReasoningEffort(efforts("low", "high"), "high"), "high", "an explicit effort is honored");
  assert.equal(pickReasoningEffort(efforts("off", "low"), "low"), "low", "explicit low beats auto's off");
  // 换模型后残留的旧档位：不能硬发（会抛错），退回 auto 的判断。
  assert.equal(pickReasoningEffort(efforts("low", "high"), "max"), "low", "an unsupported explicit effort falls back");
  assert.equal(pickReasoningEffort(efforts("off", "low"), "max"), "off", "fallback keeps auto's preference for off");
  assert.equal(pickReasoningEffort(efforts("low"), "off"), "low", "asking for off on a model without it falls back");
  // "auto" 与「没配」等价。
  assert.equal(pickReasoningEffort(efforts("low", "high"), "auto"), "low", "auto is the documented default");
}

// ---- 推理预算：只有「真在推理且关不掉」才抬上限 ----
// maxTokens 与答案共享：@earendil-works/pi-ai 的 MIN_ANSWER_TOKENS=1024，预算不足时
// 它把 thinking budget 压成 0 却照样发 reasoning_effort，模型照样思考、照样吃光
// 上限，标题为空且界面静默。抬上限是唯一能从外部干预的地方。
{
  const efforts = (...ids) => ({ reasoning: { efforts: ids.map((id) => ({ id, name: id })) } });

  assert.equal(reasoningBudget(efforts(), 256), 256, "a non-reasoning model needs no extra room");
  assert.equal(reasoningBudget({}, 256), 256, "same for a model that declares no reasoning at all");
  assert.equal(reasoningBudget(efforts("off", "low"), 256), 256, "reasoning that can be turned off needs no room");
  // 关闭档在不同网关里也叫 `none`。声明成 none 时推理真被关掉，预算就不该再抬
  // 到地板 —— 否则只是白给一个用不到的上限。
  assert.equal(reasoningBudget(efforts("none", "low"), 256), 256, "a none-id off level needs no room either");
  assert.equal(pickReasoningEffort(efforts("none", "low")), "none", "none is picked as the off level");
  assert.equal(
    pickReasoningEffort(efforts("low", "none")),
    "none",
    "the off level wins regardless of where the model lists it"
  );
  assert.equal(
    reasoningBudget(efforts("low", "high", "max"), 256),
    REASONING_TOKEN_FLOOR,
    "a model that always reasons gets the floor"
  );
  assert.equal(reasoningBudget(undefined, 256), REASONING_TOKEN_FLOOR, "an unreadable model is treated as reasoning");
  assert.equal(
    reasoningBudget(efforts("low"), 4096),
    4096,
    "a user budget above the floor is never lowered"
  );
  // 显式选 off（模型支持）→ 不必抬预算，与 auto 的 off 一致。
  assert.equal(reasoningBudget(efforts("off", "low"), 256, "off"), 256, "an explicit off needs no room either");
  // 显式选高档 → 照样在推理，预算要抬。
  assert.equal(
    reasoningBudget(efforts("low", "high"), 256, "high"),
    REASONING_TOKEN_FLOOR,
    "an explicit reasoning effort still needs the floor"
  );
  // 实测校准：64/256/1024 全被吃光，2048 也有一次 reasoning=2048 → stop=length、答案 0 token。
  // 成功案例的 reasoning 最高 3172，所以下限必须高过它，给答案留余量。
  assert.ok(REASONING_TOKEN_FLOOR >= 4096, "the floor covers the worst observed reasoning and still leaves room");
}

// ---- 推理能力报告：设置面板据此说人话，四种状态不能混 ----
{
  const info = {
    reasoning: {
      efforts: [
        { id: "low", name: "Low" },
        { id: "high", name: "High" }
      ],
      defaultEffort: "high"
    }
  };
  assert.deepEqual(describeReasoning(info, 256), {
    known: true,
    efforts: ["low", "high"],
    defaultEffort: "high",
    requested: "auto",
    effort: "low",
    off: false,
    maxOutputTokens: REASONING_TOKEN_FLOOR
  });
  // 探测失败必须报 known:false，界面才能说「读不到」而不是谎报「不支持推理」。
  assert.deepEqual(describeReasoning(undefined, 256), {
    known: false,
    efforts: [],
    defaultEffort: undefined,
    requested: "auto",
    effort: null,
    off: false,
    maxOutputTokens: REASONING_TOKEN_FLOOR
  });
  // 非推理模型：known 为 true、efforts 为空 —— 与「读不到」是两种不同的说法。
  const plain = describeReasoning({}, 256);
  assert.equal(plain.known, true);
  assert.deepEqual(plain.efforts, []);
  assert.equal(plain.effort, null);
  assert.equal(plain.off, false);
  assert.equal(plain.maxOutputTokens, 256, "a non-reasoning model keeps the configured budget");

  const effortsOf = (...ids) => ({ reasoning: { efforts: ids.map((id) => ({ id, name: id })) } });
  // 关闭档判定交给 host：界面只念 `off` 这个结论，不自己认档位 id —— client 半边
  // 是另一个 bundle，import 不到那份名单，各写一套迟早对不上。
  assert.equal(describeReasoning(effortsOf("off", "low"), 256).off, true, "a declared off is reported as off");
  assert.equal(describeReasoning(effortsOf("none", "low"), 256).off, true, "a declared none is reported as off too");
  // 模型没声明关闭档，用户手填 none 也不算「关掉了」：档位会回退，off 必须 false。
  assert.equal(describeReasoning(effortsOf("low", "high"), 256, "none").off, false, "an undeclared none is a fallback, not an off");
  assert.equal(describeReasoning(effortsOf("low", "high"), 256, "off").off, false, "an undeclared off is a fallback too");
}

console.log(
  "check ok: resolveConfig + pickRecentMessages + titleFromOutput + titleFromResponse + prompts + clampTitle + reasoning"
);
