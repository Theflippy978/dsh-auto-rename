import assert from "node:assert/strict";
import fs from "node:fs";

const s = fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const zhBlock = s.slice(s.indexOf("var ZH = {"), s.indexOf("var EN = {"));
const enBlock = s.slice(s.indexOf("var EN = {"), s.indexOf("var t = function"));
const keys = (block) => new Set([...block.matchAll(/"([a-zA-Z.]+)":/g)].map((m) => m[1]));
const zh = keys(zhBlock);
const en = keys(enBlock);

// `t("key")` 的调用点。前一个字符必须是"非标识符"——否则 `settings.t("x")`
// 这种写法会被 `\bt` 从中间的 `.t` 处切开，把键名截断成半截。
const used = new Set([...s.matchAll(/(?<![\w.$])t\("([a-zA-Z.]+)"\)/g)].map((m) => m[1]));
// fieldProps(field, labelKey) consumes labelKey and labelKey + "Hint"
for (const m of s.matchAll(/fieldProps\("\w+", "([\w.]+)"\)/g)) {
  used.add(m[1]);
  used.add(m[1] + "Hint");
}

console.log("used keys:", used.size);
const missingZh = [...used].filter((k) => !zh.has(k));
const missingEn = [...used].filter((k) => !en.has(k));
const unused = [...zh].filter((k) => !used.has(k));

// 缺键不会报错，只会让界面显示原始键名（t() 的兜底），所以必须在这里拦住。
assert.deepEqual(missingZh, [], "keys used but missing from the Chinese dictionary");
assert.deepEqual(missingEn, [], "keys used but missing from the English dictionary");
assert.equal(zh.size, en.size, "zh/en dictionaries must have the same key count");
for (const key of zh) assert.ok(en.has(key), `key "${key}" is missing from the English dictionary`);

// 未使用的键只警告：删字典项没有运行时症状，但堆着会掩盖真正的漏键。
if (unused.length > 0) console.log("note: defined but unused: " + unused.join(", "));
console.log("locale audit ok: " + used.size + " keys used, zh/en in step");
