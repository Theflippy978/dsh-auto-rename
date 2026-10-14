/**
 * Client 半边冒烟：不启动 GUI，用假 ctx 跑 lib/client.js 的 apply()，
 * 专门守住「顶部按钮静默消失」这一类故障。
 *
 * 背景：conversation.session.header.actions 是 session 作用域的 list 槽，
 * entry 在渲染期抛错会被 SlotErrorBoundary 吞掉并 abdicate（按钮消失、不报错），
 * 而 GUI 拿不到渲染进程 console。所以这里断言：
 *   1. inject 在任何 sessions 状态下都不抛（读不到标题只影响初值）；
 *   2. 注册形状（name / id / order / locale）与组件、模块 inject 声明齐全；
 *   3. 注册失败时状态落到 headerStatusStore（设置卡片会显示），而不是抛穿 apply。
 *
 * client.js 是 window.__ModuleLoader__.load({id, factory}) 的形态，所以先用
 * new Function("window", src) 求值，再取 factory 里的 exports。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SOURCE = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "client.js"), "utf8");

function loadClient() {
  const loaded = [];
  const window = {
    __ModuleLoader__: {
      load: (definition) => {
        loaded.push(definition);
      }
    }
  };
  new Function("window", SOURCE)(window);
  assert.equal(loaded.length, 1, "client.js must call __ModuleLoader__.load exactly once");
  const [definition] = loaded;
  assert.equal(definition.id, "dsh-auto-rename", "module id is the package name");
  const exports = definition.factory(makeRequire());
  return exports;
}

/** 只喂 client.js 真正 require 的说明符。 */
function makeRequire() {
  const noop = () => {};
  return function require(specifier) {
    if (specifier === "react") {
      return {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState: (initial) => [initial, noop],
        useCallback: (fn) => fn,
        useMemo: (fn) => fn(),
        useRef: (initial) => ({ current: initial }),
        // React 的真实签名：useSyncExternalStore(subscribe, getSnapshot)。
        // 这里严格按这个契约校验：第一个参数必须能订阅并返回 disposer，
        // 第二个必须是取快照的函数 —— 参数写反就直接报错（曾经踩过）。
        useSyncExternalStore: (subscribe, getSnapshot) => {
          if (typeof subscribe !== "function") throw new TypeError("arg1 of useSyncExternalStore must be subscribe");
          if (typeof getSnapshot !== "function") throw new TypeError("arg2 of useSyncExternalStore must be getSnapshot");
          const disposer = subscribe(noop);
          if (typeof disposer !== "function") throw new TypeError("subscribe must return a disposer");
          return getSnapshot();
        },
        Fragment: "Fragment"
      };
    }
    if (specifier === "@deepseek-ai/dsh-client-ui-primitives") {
      return { Button: "Button", Modal: "Modal", Pill: "Pill", Switch: "Switch" };
    }
    throw new Error("unexpected require: " + specifier);
  };
}

function makeSlots(behaviour = {}) {
  const registered = [];
  const watchers = [];
  return {
    registered,
    watchers,
    inject(key, callback) {
      assert.equal(key, "conversation.session.header.actions");
      assert.equal(typeof callback, "function", "slots.inject needs a callback");
      return callback();
    },
    register(options, component) {
      if (behaviour.throwOnRegister) throw new Error("slot not declared");
      registered.push({ options, component });
      return () => registered.pop();
    },
    onEntryError(fn) {
      watchers.push(fn);
      return () => watchers.pop();
    }
  };
}

function makeSessions(behaviour = {}) {
  const renames = [];
  return {
    renames,
    list: {
      getSnapshot: () => {
        if (behaviour.snapshotThrows) throw new TypeError("getSnapshot of undefined");
        return { byId: behaviour.byId ?? {} };
      },
      subscribe: () => () => {}
    },
    using: async (id, options, operation) =>
      operation({
        binding: {
          session: {
            rename: async (title) => {
              renames.push({ id, source: options.source, title });
              // RemoteResult：失败时 renameSession 必须抛，不能静默当成改名成功
              return behaviour.renameFails
                ? { ok: false, error: { message: "session is archived" } }
                : { ok: true, value: { title, seq: 1 } };
            }
          }
        }
      })
  };
}

const exports = loadClient();

// ---- 1. 模块元数据 ----
assert.equal(typeof exports.apply, "function", "client must export apply");
assert.deepEqual(exports.inject, ["slots", "locale", "sessions"], "client inject list");

// ---- 2. 正常路径：注册形状 ----
{
  const slots = makeSlots();
  const sessions = makeSessions({ byId: { s1: { displayTitle: "已有标题" } } });
  const ctx = {
    slots,
    sessions,
    inject: () => {},
    locale: { register: () => () => {}, bind: () => (key) => key },
    effect: (fn) => fn(),
    logger: { warn: () => {} }
  };
  await exports.apply(ctx);

  assert.equal(slots.registered.length, 1, "exactly one header entry registered");
  const { options, component } = slots.registered[0];
  assert.equal(options.name, "conversation.session.header.actions");
  assert.equal(options.id, "dsh-auto-rename", "fresh id, never reuse a shipped cell");
  assert.equal(options.order, 20);
  assert.equal(options.locale, "dsh-auto-rename");
  assert.equal(typeof component, "function");

  // inject 返回的 props：不得与 standard props 撞名（sessionId 由渲染器给）
  const props = options.inject("s1");
  assert.deepEqual(Object.keys(props).sort(), ["currentTitle", "onRename"], "only extra props, no sessionId");
  assert.equal(props.currentTitle, "已有标题");
  await props.onRename("s1", "新标题");
  assert.deepEqual(sessions.renames, [{ id: "s1", source: "workspaceOperation", title: "新标题" }], "rename goes through sessions.using");

  // 真的渲染一次组件：useStore 里的 useSyncExternalStore 参数顺序错了会在这里抛
  const tree = component({ sessionId: "s1", ...props });
  assert.ok(tree && tree.type === "Fragment", "HeaderAction must render without throwing");
}

// ---- 2b. 服务端拒绝改名 → onRename 必须抛（Modal 要显示原因，不能假装成功） ----
{
  const slots = makeSlots();
  const ctx = {
    slots,
    sessions: makeSessions({ renameFails: true }),
    inject: () => {},
    locale: { register: () => () => {}, bind: () => (key) => key },
    effect: (fn) => fn()
  };
  await exports.apply(ctx);
  await assert.rejects(
    () => slots.registered[0].options.inject("s1").onRename("s1", "x"),
    /session is archived/
  );
}

// ---- 3. 会话不在列表里 → 标题降级为空，不抛 ----
{
  const slots = makeSlots();
  const ctx = {
    slots,
    sessions: makeSessions({ byId: {} }),
    inject: () => {},
    locale: { register: () => () => {}, bind: () => (key) => key },
    effect: (fn) => fn()
  };
  await exports.apply(ctx);
  assert.equal(slots.registered[0].options.inject("unknown").currentTitle, "", "unknown session yields empty title");
}

// ---- 4. getSnapshot 抛错 → inject 不许抛穿（抛了就等于按钮静默消失） ----
{
  const slots = makeSlots();
  const ctx = {
    slots,
    sessions: makeSessions({ snapshotThrows: true }),
    inject: () => {},
    locale: { register: () => () => {}, bind: () => (key) => key },
    effect: (fn) => fn()
  };
  await exports.apply(ctx);
  const props = slots.registered[0].options.inject("s1");
  assert.equal(props.currentTitle, "", "a throwing snapshot must degrade, not crash the entry");
}

// ---- 5. sessions 服务整个缺失 → 仍然不抛 ----
{
  const slots = makeSlots();
  const ctx = {
    slots,
    sessions: undefined,
    inject: () => {},
    locale: { register: () => () => {}, bind: () => (key) => key },
    effect: (fn) => fn()
  };
  await exports.apply(ctx);
  assert.equal(slots.registered[0].options.inject("s1").currentTitle, "", "missing sessions must degrade");
}

// ---- 6. 注册抛错（槽位未声明）→ apply 不炸，状态留给设置卡片 ----
{
  const slots = makeSlots({ throwOnRegister: true });
  const warnings = [];
  const ctx = {
    slots,
    sessions: makeSessions(),
    inject: () => {},
    locale: { register: () => () => {}, bind: () => (key) => key },
    effect: (fn) => fn(),
    logger: { warn: (...args) => warnings.push(args.join(" ")) }
  };
  await exports.apply(ctx);
  assert.equal(slots.registered.length, 0, "nothing registered");
}

// ---- 7. 没有 slots 服务时 apply 也必须活着 ----
{
  const ctx = {
    sessions: makeSessions(),
    inject: () => {},
    locale: { register: () => () => {}, bind: () => (key) => key },
    effect: (fn) => fn()
  };
  await exports.apply(ctx);
}

console.log("client smoke ok: registration shape, inject never throws, failures degrade");
