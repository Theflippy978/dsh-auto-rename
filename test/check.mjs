/**
 * 本插件唯一有分支的逻辑的自检：配置合并 + 源消息挑选。
 *
 * 无框架、无 fixture，直接 `node test/check.mjs`。这两处一旦写错，症状分别是
 * 「改了设置没反应」和「拿不到消息所以永不命名」——都不会报错，所以必须由
 * 断言守住。
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DEFAULTS, clampTitle, pickRecentMessages, pickSourceMessages, readVolatile, resolveConfig, titleWidthUnits } from "../lib/config.js";

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
const paired = resolveConfig({ provider: "magpie", model: "group/never-stuck" });
assert.deepEqual(paired.route, { provider: "magpie", model: "group/never-stuck" });

// 半对必须抛错（静默失效是最坏的结果）
assert.throws(() => resolveConfig({ provider: "magpie" }), /must be configured together/);
assert.throws(() => resolveConfig({ model: "group/never-stuck" }), /must be configured together/);

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
// 但官方 generateSessionTitleWithLlm 要求它是正整数（提示词也要用），
// 所以从宽度预算折算：预算 = 字数 × 2 个半角单位，一个英文词按 6 单位估。
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

// ---- pickSourceMessages ----

// host 交来的真实形状：{ seq, text }
assert.deepEqual(pickSourceMessages([{ seq: 3, text: "写一个 DSH 插件" }]), [
  { seq: 3, text: "写一个 DSH 插件" }
]);

// 只取第一条
assert.deepEqual(pickSourceMessages([{ seq: 1, text: "first" }, { seq: 2, text: "second" }]), [
  { seq: 1, text: "first" }
]);

// 空白文本跳过，继续找下一条
assert.deepEqual(pickSourceMessages([{ seq: 1, text: "   " }, { seq: 2, text: "real" }]), [
  { seq: 2, text: "real" }
]);

// 空/坏输入不得抛错（host 可能在没有用户消息时就调用）
assert.deepEqual(pickSourceMessages([]), []);
assert.deepEqual(pickSourceMessages(undefined), []);
assert.deepEqual(pickSourceMessages([null, { seq: 1 }]), []);

// ---- pickRecentMessages：手动弹窗用最近几条 ----

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
// 表现为「建议获取失败」，所以裁剪只能在我们这边做。
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

// 单条也要守预算（自动命名走的是 pickSourceMessages）
const single = pickSourceMessages([{ seq: 7, text: long }], 4096);
assert.ok(Buffer.byteLength(JSON.stringify(single), "utf8") <= 4096);
assert.equal(single[0].seq, 7);

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
  clampTitle("magpie/group/never-stuck-longer", 12),
  "magpie/group/never-stuck-longer",
  "a single unbreakable token is left whole rather than chopped"
);
assert.equal(clampTitle("", 12), "");
assert.equal(clampTitle(undefined, 12), undefined);

console.log("check ok: resolveConfig + pickSourceMessages + pickRecentMessages + clampTitle");
