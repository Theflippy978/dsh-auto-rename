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
/**
 * SettingsFormModel 的严格替身。
 *
 * 目的不是复刻行为，而是**守住契约**：官方实现要求 scope 提供
 * getSnapshot()/subscribe()/mutate(ops, revision)，且快照带
 * status/value/base/revision/writable。上一版卡片喂的是 settingsScope.bind 的
 * 产物（只有 set/unset，没有 mutate），所以表单根本没法工作 —— 这里缺一个
 * 方法就当场抛，防止再退回那条死路。
 */
class FakeSettingsFormModel {
  specs;
  staged = new Map();
  listeners = new Set();
  constructor(scope, specs) {
    for (const method of ["getSnapshot", "subscribe", "mutate"]) {
      if (typeof scope?.[method] !== "function") {
        throw new TypeError(`SettingsFormModel needs scope.${method}() — got ${scope?.[method]}`);
      }
    }
    const snapshot = scope.getSnapshot();
    for (const field of ["status", "value", "revision", "writable"]) {
      if (!(field in snapshot)) throw new TypeError(`scope snapshot must carry "${field}"`);
    }
    this.scope = scope;
    this.specs = specs;
    this.unsubscribe = scope.subscribe(() => this.publish());
  }
  bind(project) {
    const store = { value: project(), listeners: new Set() };
    store.getSnapshot = () => store.value;
    store.subscribe = (listener) => {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    };
    store.set = (next) => {
      store.value = next;
      for (const listener of store.listeners) listener();
    };
    this.listeners.add(() => store.set(project()));
    return store;
  }
  publish() {
    for (const listener of this.listeners) listener();
  }
  shell() {
    const snapshot = this.scope.getSnapshot();
    return {
      available: snapshot.status === "ready",
      writable: snapshot.writable === true,
      dirty: this.staged.size > 0,
      invalid: false,
      saving: false,
      failed: false
    };
  }
  field(name) {
    const spec = this.specs.find((entry) => entry.field === name);
    if (spec === undefined) throw new Error(`card has no field ${name}`);
    if (this.staged.has(name)) return { text: this.staged.get(name), overridden: true, invalid: false };
    return { text: spec.format(this.scope.getSnapshot().value?.[name]), overridden: false, invalid: false };
  }
  actions() {
    return {
      edit: (field, text) => {
        this.staged.set(field, text);
        this.publish();
      },
      resetField: (field) => {
        this.staged.delete(field);
        this.publish();
      },
      save: () => {
        this.saved = (this.saved ?? 0) + 1;
      },
      discard: () => {
        this.staged.clear();
        this.publish();
      }
    };
  }
  dispose() {
    this.unsubscribe();
  }
}

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
      return {
        Button: "Button",
        Modal: "Modal",
        Switch: "Switch",
        IconSparkleRegular: "IconSparkleRegular",
        SettingsForm: "SettingsForm",
        SettingsValueField: "SettingsValueField",
        settingsTextField: (field) => ({ field, format: String, parse: (text) => ({ kind: "set", value: text }) }),
        settingsNumberField: (field) => ({
          field,
          format: (value) => (typeof value === "number" ? String(value) : ""),
          parse: (text) => (Number.isFinite(Number(text)) ? { kind: "set", value: Number(text) } : undefined)
        }),
        // 替身：真实实现的契约是 constructor(scope, specs) + bind/shell/field/
        // actions/dispose，scope 需要 getSnapshot/subscribe/mutate。这里只按
        // 同一形状搭一个最小版本，够验证卡片的注册与渲染。
        SettingsFormModel: FakeSettingsFormModel
      };
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
    /** 某个槽位上的注册项。 */
    of(name) {
      return registered.filter((entry) => entry.options.name === name);
    },
    inject(key, callback) {
      assert.equal(typeof callback, "function", "slots.inject needs a callback");
      return callback();
    },
    register(options, component) {
      if (behaviour.throwOnRegister) throw new Error("slot not declared");
      registered.push({ options, component });
      return () => {
        const index = registered.findIndex((entry) => entry.options === options);
        if (index >= 0) registered.splice(index, 1);
      };
    },
    onEntryError(fn) {
      watchers.push(fn);
      return () => watchers.pop();
    }
  };
}

/**
 * configForms 替身：get(ns) 给出 SettingsFormModel 需要的 scope，
 * whileServed 立即放行（模拟宿主确实服务这个命名空间）。
 */
function makeConfigForms(behaviour = {}) {
  const listeners = new Set();
  const scope = {
    getSnapshot: () => ({
      status: behaviour.status ?? "ready",
      value: behaviour.value ?? {},
      base: {},
      revision: 1,
      writable: behaviour.writable ?? true
    }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    mutate: async () => true
  };
  let served = false;
  return {
    scope,
    get: (ns) => {
      assert.equal(ns, "dsh-auto-rename", "the form is bound to this plugin's namespace");
      return scope;
    },
    whileServed: (namespaces, register) => {
      served = true;
      const dispose = register(new Set(namespaces));
      return () => {
        served = false;
        dispose?.();
      };
    },
    get wasServed() {
      return served;
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

/**
 * 把注册项渲染一次：模拟渲染器做的两件事 —— 调 inject 拿 face，
 * 再把 face.hooks 里的 store 绑成 use<Name> 选择器 hook。
 */
function renderEntry(entry, extraProps = {}) {
  const face = entry.options.inject ? entry.options.inject() : {};
  const props = { t: (key) => key, ...extraProps };
  for (const [name, store] of Object.entries(face.hooks ?? {})) {
    const hookName = "use" + name[0].toUpperCase() + name.slice(1);
    props[hookName] = (selector) => selector(store.getSnapshot());
  }
  const { hooks, ...actions } = face;
  Object.assign(props, actions);
  return { props, tree: entry.component(props) };
}

function makeCtx(slots, sessions, configForms) {
  return {
    slots,
    sessions,
    configForms,
    locale: { register: () => () => {}, bind: () => (key) => key },
    effect: (fn) => fn(),
    logger: { warn: () => {} }
  };
}

const HEADER = "conversation.session.header.actions";
const CARD = "plugins.bundle.config";

// ---- 1. 模块元数据 ----
assert.equal(typeof exports.apply, "function", "client must export apply");
assert.deepEqual(exports.inject, ["slots", "locale", "sessions", "configForms"], "client inject list");

// ---- 2. 顶部入口：注册形状 + 真的渲染一次（uSES 参数写反会在这一刻抛） ----
{
  const slots = makeSlots();
  const ctx = makeCtx(slots, makeSessions({ byId: { s1: { displayTitle: "已有标题" } } }), makeConfigForms());
  await exports.apply(ctx);

  const header = slots.of(HEADER);
  assert.equal(header.length, 1, "exactly one header entry registered");
  const { options, component } = header[0];
  assert.equal(options.id, "dsh-auto-rename", "fresh id, never reuse a shipped cell");
  assert.equal(options.order, 20);
  assert.equal(options.locale, "dsh-auto-rename");
  assert.equal(options.inject, undefined, "no inject: standard props are enough, less that can throw");
  assert.equal(typeof component, "function");

  const button = renderButton(component, { sessionId: "s1" });
  assert.equal(button.props.disabled, false, "with a session the entry is enabled");
  // 原生形态：无边框 ghost + 图标 14 + 可见文字命名（不写 aria-label）
  assert.equal(button.props.variant, "ghost", "must match the native borderless entry");
  assert.equal(button.props["aria-label"], undefined, "visible text is its accessible name");
  assert.equal(button.props.title, "action.aria", "title carries the tooltip");
  assert.equal(button.props.icon.type, "IconSparkleRegular", "icon + text, like the native labels");
  assert.equal(button.props.icon.props.size, 14, "native neighbours use size 14");
  assert.deepEqual(button.children, ["action.label"], "label text comes from the locale table");

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

// ---- 3. 设置卡片：注册进 plugins.bundle.config，key 是包名 ----
{
  const slots = makeSlots();
  const configForms = makeConfigForms({ value: { targetCjkCharacters: 12 } });
  await exports.apply(makeCtx(slots, makeSessions(), configForms));

  const cards = slots.of(CARD);
  assert.equal(cards.length, 1, "exactly one settings card registered");
  assert.equal(cards[0].options.key, "dsh-auto-rename", "the page addresses the card by package name");
  assert.equal(cards[0].options.locale, "dsh-auto-rename");
  assert.ok(configForms.wasServed, "the card is gated on the Host serving our namespace");

  // summary 视图：宿主只要一行说明
  const summary = renderEntry(cards[0], { view: "summary" });
  assert.equal(summary.tree, "description", "summary renders the one-liner");

  // page 视图：官方 SettingsForm + 每个字段一个 SettingsValueField
  const page = renderEntry(cards[0], { view: "page" });
  assert.equal(page.tree.type, "SettingsForm", "the page must use the host's own form frame");
  assert.equal(page.tree.props.state.available, true);
  assert.deepEqual(
    ["save", "discard", "edit", "resetField"].map((key) => typeof page.props[key]),
    ["function", "function", "function", "function"],
    "the form actions come from SettingsFormModel"
  );
  const rows = page.tree.props.children.flat(Infinity).filter(Boolean);
  const fields = rows.filter((row) => row.type === "SettingsValueField");
  assert.deepEqual(
    fields.map((field) => field.props.id),
    [
      "plugin-config-auto-rename-provider",
      "plugin-config-auto-rename-model",
      "plugin-config-auto-rename-suggestionCount",
      "plugin-config-auto-rename-maxOutputTokens",
      "plugin-config-auto-rename-timeoutMs",
      "plugin-config-auto-rename-targetWords",
      "plugin-config-auto-rename-targetCjkCharacters"
    ],
    "every editable field renders exactly once"
  );
  // 布尔行走自定义 SwitchRow（官方没有对应字段原语）：手动渲染一层，
  // 确认里面确实只有一个 Switch，且 checked 由暂存文本推导。
  const switchRow = rows.find((row) => typeof row.type === "function");
  assert.ok(switchRow, "autoRenameEnabled renders as its own row");
  assert.equal(switchRow.props.label, "settings.enable");
  assert.equal(switchRow.props.checked, true, "undefined config reads as enabled");
  const rowTree = switchRow.type(switchRow.props);
  const switches = [rowTree, ...rowTree.children.flat(Infinity)]
    .flat(Infinity)
    .filter((node) => node?.type === "Switch");
  assert.equal(switches.length, 1, "the row holds exactly one switch");
  assert.equal(switches[0].props.label, "settings.enable", "the switch is named by the visible text");
  // 数字字段必须标 numeric，否则宿主不给数字键盘与校验文案
  assert.deepEqual(
    fields.filter((field) => field.props.numeric === true).map((field) => field.props.id),
    fields.slice(2).map((field) => field.props.id),
    "text fields stay non-numeric, number fields are numeric"
  );
  // 平时不留调试文字
  assert.equal(
    rows.some((row) => row.type === "p" && row.props?.role === "alert"),
    false,
    "no debug row while the header entry is healthy"
  );

  // 编辑只暂存草稿：重新渲染才看到新值，宿主文档在保存前不动
  fields[0].props.onEdit("magpie");
  assert.equal(configForms.scope.getSnapshot().value.provider, undefined, "no write before save");
  const staged = renderEntry(cards[0], { view: "page" });
  const stagedFields = staged.tree.props.children.flat(Infinity).filter((node) => node?.type === "SettingsValueField");
  assert.equal(stagedFields[0].props.text, "magpie", "the draft shows up on re-render");
  assert.equal(stagedFields[0].props.overridden, true, "a staged value reads as an override");
  assert.equal(staged.tree.props.state.dirty, true, "the form is dirty, so Save unlocks");
}

// ---- 3b. 宿主未服务该命名空间 → 卡片不注册（不留半张卡） ----
{
  const slots = makeSlots();
  const configForms = makeConfigForms();
  configForms.whileServed = () => () => {};
  await exports.apply(makeCtx(slots, makeSessions(), configForms));
  assert.equal(slots.of(CARD).length, 0, "an unserved namespace must show no card");
  assert.equal(slots.of(HEADER).length, 1, "the header entry is independent of the card");
}

// ---- 3c. 没有 configForms 服务 → 只有卡片缺席，apply 不炸 ----
{
  const slots = makeSlots();
  await exports.apply(makeCtx(slots, makeSessions(), undefined));
  assert.equal(slots.of(CARD).length, 0);
  assert.equal(slots.of(HEADER).length, 1);
}

// ---- 4. 会话不在列表里 → 标题降级为空，入口照常渲染 ----
{
  const slots = makeSlots();
  await exports.apply(makeCtx(slots, makeSessions({ byId: {} }), makeConfigForms()));
  const http = captureFetch([]);
  try {
    renderButton(slots.of(HEADER)[0].component, { sessionId: "unknown" }).props.onClick();
  } finally {
    http.restore();
  }
}

// ---- 5. getSnapshot 抛错 → 点击不许抛穿（抛了等于弹窗打不开） ----
{
  const slots = makeSlots();
  await exports.apply(makeCtx(slots, makeSessions({ snapshotThrows: true }), makeConfigForms()));
  const http = captureFetch([]);
  try {
    await renderButton(slots.of(HEADER)[0].component, { sessionId: "s1" }).props.onClick();
    assert.equal(http.calls.length, 1, "still fetches suggestions");
  } finally {
    http.restore();
  }
}

// ---- 6. sessions 服务整个缺失 → 入口仍然渲染，点击不抛 ----
{
  const slots = makeSlots();
  await exports.apply(makeCtx(slots, undefined, makeConfigForms()));
  renderButton(slots.of(HEADER)[0].component, { sessionId: "s1" });
}

// ---- 7. 注册抛错（槽位未声明）→ apply 不炸 ----
{
  const slots = makeSlots({ throwOnRegister: true });
  await exports.apply(makeCtx(slots, makeSessions(), makeConfigForms()));
  assert.equal(slots.registered.length, 0, "nothing registered");
}

// ---- 8. 没有 slots 服务时 apply 也必须活着 ----
{
  await exports.apply({
    sessions: makeSessions(),
    configForms: makeConfigForms(),
    locale: { register: () => () => {}, bind: () => (key) => key },
    effect: (fn) => fn()
  });
}

console.log("client smoke ok: header entry, official settings card, inject never throws, failures degrade");
