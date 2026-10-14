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
        // useState 的初始值可以是工厂函数，React 会调用它一次
        useState: (initial) => [typeof initial === "function" ? initial() : initial, noop],
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

/** 记录 client 半边发起的 /suggest 请求。 */
function captureFetch(titles) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, value: { titles } }) };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** 渲染一次入口，取出那颗按钮。 */
function renderButton(component, props) {
  const tree = component(props);
  const button = tree.children[0];
  assert.equal(button.type, "Button", "first child must be the entry button");
  return button;
}

function makeCtx(slots, sessions) {
  return {
    slots,
    sessions,
    inject: () => {},
    locale: { register: () => () => {}, bind: () => (key) => key },
    effect: (fn) => fn(),
    logger: { warn: () => {} }
  };
}

// ---- 1. 模块元数据 ----
assert.equal(typeof exports.apply, "function", "client must export apply");
assert.deepEqual(exports.inject, ["slots", "locale", "sessions"], "client inject list");

// ---- 2. 注册形状 + 真的渲染一次（uSES 参数写反会在这一刻抛） ----
{
  const slots = makeSlots();
  const ctx = makeCtx(slots, makeSessions({ byId: { s1: { displayTitle: "已有标题" } } }));
  await exports.apply(ctx);

  assert.equal(slots.registered.length, 1, "exactly one header entry registered");
  const { options, component } = slots.registered[0];
  assert.equal(options.name, "conversation.session.header.actions");
  assert.equal(options.id, "dsh-auto-rename", "fresh id, never reuse a shipped cell");
  assert.equal(options.order, 20);
  assert.equal(options.locale, "dsh-auto-rename");
  assert.equal(options.inject, undefined, "no inject: standard props are enough, less that can throw");
  assert.equal(typeof component, "function");

  const button = renderButton(component, { sessionId: "s1" });
  assert.equal(button.props.disabled, false, "with a session the entry is enabled");
  assert.equal(button.props["aria-label"], "action.aria", "locale keys resolve through the bound t");

  const http = captureFetch(["建议一", "建议二"]);
  try {
    await button.props.onClick();
    assert.deepEqual(http.calls, [{ url: "/dsh-auto-rename/suggest", body: { sessionId: "s1" } }], "click pulls suggestions");
  } finally {
    http.restore();
  }

  // 没有会话时按钮存在但禁用，点击不发起请求
  const idle = renderButton(component, { sessionId: undefined });
  assert.equal(idle.props.disabled, true, "without a session the entry is disabled");
  const quiet = captureFetch([]);
  try {
    await idle.props.onClick();
    assert.equal(quiet.calls.length, 0, "a disabled entry must not call the bridge");
  } finally {
    quiet.restore();
  }

  // 改名通道：sessions.using 的 source 必须是 workspaceOperation
  const sessions = makeSessions({ byId: {} });
  await sessions.using("s9", { source: "workspaceOperation" }, (ref) => ref.binding.session.rename("t"));
  assert.deepEqual(sessions.renames, [{ id: "s9", source: "workspaceOperation", title: "t" }]);
}

// ---- 2b. 服务端拒绝改名 → 抛错，不能静默当成成功 ----
{
  const sessions = makeSessions({ renameFails: true });
  await assert.rejects(
    () =>
      sessions.using("s1", { source: "workspaceOperation" }, (ref) =>
        ref.binding.session.rename("x").then((result) => {
          if (!result.ok) throw new Error(result.error.message);
        })
      ),
    /session is archived/
  );
}

// ---- 3. 会话不在列表里 → 标题降级为空，入口照常渲染 ----
{
  const slots = makeSlots();
  await exports.apply(makeCtx(slots, makeSessions({ byId: {} })));
  const http = captureFetch([]);
  try {
    renderButton(slots.registered[0].component, { sessionId: "unknown" }).props.onClick();
  } finally {
    http.restore();
  }
}

// ---- 4. getSnapshot 抛错 → 点击不许抛穿（抛了等于弹窗打不开） ----
{
  const slots = makeSlots();
  await exports.apply(makeCtx(slots, makeSessions({ snapshotThrows: true })));
  const http = captureFetch([]);
  try {
    await renderButton(slots.registered[0].component, { sessionId: "s1" }).props.onClick();
    assert.equal(http.calls.length, 1, "still fetches suggestions");
  } finally {
    http.restore();
  }
}

// ---- 5. sessions 服务整个缺失 → 入口仍然渲染，点击不抛 ----
{
  const slots = makeSlots();
  await exports.apply(makeCtx(slots, undefined));
  renderButton(slots.registered[0].component, { sessionId: "s1" });
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
