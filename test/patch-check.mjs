/**
 * 离线验证 cordis.patch.yml 的组合结果。
 *
 * 直接复用官方 composeEntries 的语义（applyEntryPatches 是「THE patch semantics」，
 * dump-config 与真实 mount 共用它），但只把需要的那几行抽出来跑，避免拖起整个
 * dsh-app-boot（它依赖 commander / dsh-home-paths 等一大串）。
 *
 * 断言两件事：
 *  1. 内置的 session-title-llm 行确实被 disabled: true 关掉
 *  2. 本插件行被插入，且 inject 声明完整
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

// ---- 官方 applyEntryPatches 的等价实现（逐行对齐 dsh-app-boot 的 61-110 行）----
function applyEntryPatches(data, patches, warn = () => {}) {
  if (!patches?.length) return [...data];
  data = structuredClone(data);
  const entryMap = new Map();
  const buildMap = (entries) => {
    for (const entry of entries) {
      if (entry.id) entryMap.set(entry.id, entry);
      if (entry.group && Array.isArray(entry.config)) buildMap(entry.config);
    }
  };
  buildMap(data);
  for (const patch of patches) {
    const { id, insert, name, ...overrides } = patch;
    if (insert) {
      if (id) {
        const target = entryMap.get(id);
        if (!target) {
          warn("patch insert: entry not found", id);
          continue;
        }
        if (!target.group) {
          warn("patch insert: entry is not a group", id);
          continue;
        }
        if (!Array.isArray(target.config)) target.config = [];
        target.config.push(...insert);
      } else data.push(...insert);
      buildMap(insert);
      continue;
    }
    if (!id) continue;
    const target = entryMap.get(id);
    if (!target) {
      warn("patch: entry not found", id);
      continue;
    }
    if (name && name !== target.name) {
      warn("patch: name mismatch", id);
      continue;
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (key === "id") continue;
      target[key] = value;
    }
  }
  return data;
}

// ---- 读 patch 用官方同款 yaml 解析 ----
// 不自造解析器：手写版本漏判过一遍，而 DSH 本身就依赖 yaml，profile 里现成有。
// 本地开发时从 profile 链一份：见 README 的「开发」一节。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const YAML = require("yaml");

const patchText = readFileSync(join(repo, "cordis.patch.yml"), "utf8");
const patches = YAML.parse(patchText);

// 解析器自检：形状不对就立刻停，避免「解析出空数组所以测试通过」的假绿
assert.ok(Array.isArray(patches), "cordis.patch.yml must be a top-level array");
assert.ok(patches.length >= 2, `expected >= 2 patch entries, parsed ${patches.length}`);
assert.ok(Array.isArray(patches[0].insert), "first patch must be an insert");

// ---- dsh-base 的原始行（只保留本测试关心的两条，取自 asar 内 dsh-base/cordis.patch.yml）----
const baseRows = [
  { id: "session-title", name: "@deepseek-ai/dsh-session-title", config: { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 } },
  { id: "session-title-llm", name: "@deepseek-ai/dsh-session-title-first-prompt-llm", config: { targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 4096, maxOutputTokens: 64, timeoutMs: 60000 } },
  { id: "user-questions", name: "@deepseek-ai/dsh-user-questions" }
];

const warnings = [];
const composed = applyEntryPatches(baseRows, patches, (...args) => warnings.push(args.join(" ")));
assert.deepEqual(warnings, [], `patch must apply cleanly, got: ${warnings.join(" | ")}`);

const byId = new Map(composed.filter((row) => row.id).map((row) => [row.id, row]));

// 1. 内置 provider 被关掉（这是本插件能注册成功的前提）
const llmRow = byId.get("session-title-llm");
assert.ok(llmRow, "session-title-llm row must still exist");
assert.equal(llmRow.disabled, true, "session-title-llm must be disabled, else our register() throws");

// 2. 本插件行被插入
const own = byId.get("dsh-auto-rename");
assert.ok(own, "dsh-auto-rename row must be inserted");
assert.equal(own.name, "dsh-auto-rename");
assert.deepEqual(
  own.inject,
  ["sessionTitle", "llm", "sessions", "webServer"],
  "the row must declare the host services it injects"
);

// 3. 没有误伤其他行
assert.equal(byId.get("session-title").disabled, undefined, "session-title must stay enabled");
assert.equal(byId.get("user-questions").disabled, undefined, "unrelated rows must stay untouched");
assert.equal(composed.length, baseRows.length + 1, "exactly one row added");

// 4. 包内声明的 patch 路径与文件确实存在
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
assert.ok(pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-conversation"));

console.log("patch ok: session-title-llm disabled, dsh-auto-rename inserted, no collateral damage");
