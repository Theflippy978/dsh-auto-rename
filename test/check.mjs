/**
 * 本插件唯一有分支的逻辑的自检：配置合并 + 源消息挑选。
 *
 * 无框架、无 fixture，直接 `node test/check.mjs`。这两处一旦写错，症状分别是
 * 「改了设置没反应」和「拿不到消息所以永不命名」——都不会报错，所以必须由
 * 断言守住。
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DEFAULTS, pickSourceMessages, readVolatile, resolveConfig } from "../lib/config.js";

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
      targetWords: Schema.number().step(1).min(1).max(200).volatile(),
      autoRenameEnabled: Schema.boolean().volatile()
    });
    const resolved = VolatileConfig({ targetWords: 7 });
    // 先确认前提成立：未解包时确实是对象（否则这个回归测试没有意义）
    assert.equal(typeof resolved.targetWords, "object", "volatile value must be a ref object (premise)");
    assert.equal(readVolatile(resolved.targetWords), 7, "readVolatile must unwrap the ref");
    assert.equal(resolveConfig(resolved).targetWords, 7, "resolveConfig must unwrap volatile refs");
    assert.equal(typeof resolveConfig(resolved).targetWords, "number");
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
assert.equal(empty.targetWords, DEFAULTS.targetWords, "empty config keeps defaults");
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
const overridden = resolveConfig({ targetWords: 7, suggestionCount: 2 });
assert.equal(overridden.targetWords, 7);
assert.equal(overridden.suggestionCount, 2);
assert.equal(overridden.maxOutputTokens, DEFAULTS.maxOutputTokens);

// undefined 值不得覆盖默认（schemastery volatile 未设置时就是 undefined）
assert.equal(resolveConfig({ targetWords: undefined }).targetWords, DEFAULTS.targetWords);

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

console.log("check ok: resolveConfig + pickSourceMessages");
