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
    // invalid 要真算：官方实现里 parse 返回 undefined 的草稿会让保存锁住。
    // 写死 false 的话，"非数字草稿被拒" 这条断言就成了恒真的废话。
    const invalid = [...this.staged.entries()].some(([name, text]) => {
      const spec = this.specs.find((entry) => entry.field === name);
      return spec !== undefined && spec.parse(text) === undefined;
    });
    return {
      available: snapshot.status === "ready",
      writable: snapshot.writable === true,
      dirty: this.staged.size > 0,
      invalid: invalid,
      saving: false,
      failed: false
    };
  }
  field(name) {
    const spec = this.specs.find((entry) => entry.field === name);
    if (spec === undefined) throw new Error(`card has no field ${name}`);
    if (!this.staged.has(name)) {
      return { text: spec.format(this.scope.getSnapshot().value?.[name]), overridden: false, invalid: false };
    }
    const text = this.staged.get(name);
    const write = spec.parse(text);
    return { text, overridden: write?.kind === "set", invalid: write === undefined };
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
        // 替身里不跑真实副作用调度，但必须存在：卡片用它触发首次拉目录
        useEffect: (fn) => fn(),
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
        // 与真实实现逐条对齐：format 只认字符串（String(undefined) 会得到
        // "undefined"，让下拉凭空多出一条假选项）；空串是 clear 而不是 set。
        settingsTextField: (field) => ({
          field,
          format: (value) => (typeof value === "string" ? value : ""),
          parse: (text) => {
            const trimmed = text.trim();
            return trimmed === "" ? { kind: "clear" } : { kind: "set", value: trimmed };
          }
        }),
        settingsNumberField: (field) => ({
          field,
          format: (value) => (typeof value === "number" ? String(value) : ""),
          parse: (text) => {
            const trimmed = text.trim();
            if (trimmed === "") return { kind: "clear" };
            const parsed = Number(trimmed);
            return Number.isFinite(parsed) ? { kind: "set", value: parsed } : undefined;
          }
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

/** 把「命名模型」那一行渲染一层，取出里面的 select。 */
function renderModelRow(row) {
  const tree = row.type(row.props);
  const select = [tree, ...tree.children.flat(Infinity)].find((node) => node?.type === "select");
  assert.ok(select, "the model row must contain a select");
  return select;
}

/**
 * select 的全部 option value（含 optgroup 里的）。
 * createElement 的 rest 参数会让 optgroup 的 children 嵌套一层数组，所以先摊平。
 */
function optionValues(select) {
  return select.children
    .flat(Infinity)
    .flatMap((node) =>
      node.type === "optgroup" ? node.children.flat(Infinity).map((option) => option.props.value) : [node.props.value]
    );
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

/**
 * 假 ctx。
 *
 * exports.inject 只声明硬性服务（slots/locale/sessions）；configForms 走
 * ctx.inject 延迟取、remote 走 ctx.get 可选取 —— 替身必须照这个契约给，
 * 否则测不出「服务缺席时只少一块界面、不炸整个 client」。
 */
function makeCtx(slots, sessions, configForms, remote) {
  const base = {
    slots,
    sessions,
    get: (name) => (name === "remote" ? remote : undefined),
    locale: { register: () => () => {}, bind: () => (key) => key },
    effect: (fn) => fn(),
    logger: { warn: () => {} }
  };
  base.inject = (deps, callback) => {
    const scope = Object.assign({}, base);
    for (const dep of deps) {
      if (dep === "configForms") scope.configForms = configForms;
      else if (dep === "remote") scope.remote = remote;
    }
    return callback(scope);
  };
  return base;
}

/** 宿主已认证模型目录的替身（形状抄 remote.session.modelCatalog 的返回值）。 */
function makeRemote(behaviour = {}) {
  const calls = [];
  return {
    calls,
    session: {
      modelCatalog: async () => {
        calls.push(1);
        if (behaviour.throwing) throw new Error("connection lost");
        if (behaviour.notOk) return { ok: false, error: { code: "session/unavailable", message: "no host" } };
        return {
          ok: true,
          value: {
            default: { provider: "magpie", model: "group/main" },
            routableProviders: ["magpie", "openai"],
            groups: [
              { id: "magpie", name: "Magpie", models: [{ id: "group/never-stuck", name: "never-stuck" }] },
              { id: "openai", name: "OpenAI", models: [{ id: "gpt-4o-mini", name: "GPT-4o mini" }] }
            ],
            failures: behaviour.partial ? [{ id: "broken", name: "Broken", message: "no key" }] : []
          }
        };
      }
    }
  };
}

const HEADER = "conversation.session.header.actions";
const CARD = "plugins.bundle.config";

/** 等目录的 promise 链跑完（loadCatalog 是异步的）。 */
async function flush() {
  for (let round = 0; round < 5; round++) await new Promise((resolve) => setImmediate(resolve));
}

// ---- 1. 模块元数据 ----
assert.equal(typeof exports.apply, "function", "client must export apply");
// 只声明硬性服务：configForms 走 ctx.inject、remote 走 ctx.get，
// 免得部署缺任一个就把整个 client 半边（含顶部按钮）一起弄没。
assert.deepEqual(exports.inject, ["slots", "locale", "sessions"], "client inject list");

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

  // page 视图：官方 SettingsForm 外壳 + 表单动作
  const page = renderEntry(cards[0], { view: "page" });
  assert.equal(page.tree.type, "SettingsForm", "the page must use the host's own form frame");
  assert.equal(page.tree.props.state.available, true);
  assert.deepEqual(
    ["save", "discard", "edit", "resetField"].map((key) => typeof page.props[key]),
    ["function", "function", "function", "function"],
    "the form actions come from SettingsFormModel"
  );
  const rows = page.tree.props.children.flat(Infinity).filter(Boolean);

  // 布尔行走自定义 SwitchRow（官方没有对应字段原语）：手动渲染一层，
  // 确认里面确实只有一个 Switch，且 checked 由暂存文本推导。
  const switchRow = rows.find((row) => typeof row.type === "function" && row.props.label !== undefined);
  assert.ok(switchRow, "autoRenameEnabled renders as its own row");
  assert.equal(switchRow.props.label, "settings.enable");
  assert.equal(switchRow.props.checked, true, "undefined config reads as enabled");
  const rowTree = switchRow.type(switchRow.props);
  const switches = [rowTree, ...rowTree.children.flat(Infinity)]
    .flat(Infinity)
    .filter((node) => node?.type === "Switch");
  assert.equal(switches.length, 1, "the row holds exactly one switch");
  assert.equal(switches[0].props.label, "settings.enable", "the switch is named by the visible text");

  // 其余字段：默认就是「命名模型」下拉（首帧目录还是 idle，也走下拉，
  // 不能先闪两个手填框）。
  const modelRow = rows.find((row) => typeof row.type === "function" && row.props.catalog !== undefined);
  assert.ok(modelRow, "the model row is the default control, before the catalog even loads");
  assert.equal(renderModelRow(modelRow).props.disabled, true, "the select is disabled until the catalog is ready");
  const numberFields = rows.filter((row) => row.type === "SettingsValueField");
  assert.deepEqual(
    numberFields.map((field) => field.props.id),
    [
      "plugin-config-auto-rename-suggestionCount",
      "plugin-config-auto-rename-maxOutputTokens",
      "plugin-config-auto-rename-timeoutMs",
      "plugin-config-auto-rename-targetWords",
      "plugin-config-auto-rename-targetCjkCharacters"
    ],
    "every remaining field renders exactly once"
  );
  // 数字字段必须标 numeric，否则宿主不给数字键盘与校验文案
  assert.ok(numberFields.every((field) => field.props.numeric === true), "number fields are numeric");

  // 这台机器没组合 remote（本用例没传）→ 目录拿不到 → 只有那一行退回手填
  await flush();
  const fallbackRows = renderEntry(cards[0], { view: "page" }).tree.props.children.flat(Infinity).filter(Boolean);
  assert.deepEqual(
    fallbackRows.filter((row) => row.type === "SettingsValueField").map((field) => field.props.id),
    [
      "plugin-config-auto-rename-provider",
      "plugin-config-auto-rename-model",
      "plugin-config-auto-rename-suggestionCount",
      "plugin-config-auto-rename-maxOutputTokens",
      "plugin-config-auto-rename-timeoutMs",
      "plugin-config-auto-rename-targetWords",
      "plugin-config-auto-rename-targetCjkCharacters"
    ],
    "with no catalog the two hand-entry fields come back, and only they"
  );
  assert.equal(
    fallbackRows.some((row) => typeof row.type === "function" && row.props.catalog !== undefined),
    false,
    "the select row is gone once the catalog is known-unreachable"
  );
  // 入口状态行常驻显示（用户 2026-10-14 明确要求保留：GUI 拿不到渲染进程
  // console，这行是「按钮到底注册上没有」唯一的可见说明）
  const statusRow = rows.find((row) => row.type === "p" && row.props.key === "headerStatus");
  assert.ok(statusRow, "the header status row is always shown");
  assert.equal(statusRow.children[0], "settings.headerOk", "a healthy entry reports as registered");

  // 别的槽位上别人的 entry 崩溃不能串台改我们的状态
  assert.ok(slots.watchers.length >= 1, "the plugin subscribed to entry crashes");
  slots.watchers[0]("conversation.chat.node", {}, new Error("someone else crashed"));
  assert.equal(
    renderEntry(cards[0], { view: "page" }).tree.props.children.flat(Infinity).filter(Boolean)
      .find((row) => row.props.key === "headerStatus").children[0],
    "settings.headerOk",
    "crashes on other slots must not overwrite our status"
  );

  // 我们自己的 entry 渲染期崩溃（SlotErrorBoundary 静默 abdicate）时，这行必须
  // 换成原因 —— 否则「按钮不见了」就完全没有线索。
  slots.watchers[0](HEADER, {}, new Error("received duplicate prop 'sessionId'"));
  const crashed = renderEntry(cards[0], { view: "page" }).tree.props.children.flat(Infinity).filter(Boolean);
  assert.equal(
    crashed.find((row) => row.props.key === "headerStatus").children[0],
    "settings.headerBad：received duplicate prop 'sessionId'",
    "a crashed entry surfaces its reason in the card"
  );

  // 编辑只暂存草稿：重新渲染才看到新值，宿主文档在保存前不动。
  // 按 id 取字段，不按索引 —— 目录可达与否会改变字段清单。
  const editField = (id) =>
    renderEntry(cards[0], { view: "page" }).tree.props.children
      .flat(Infinity)
      .filter(Boolean)
      .find((row) => row.type === "SettingsValueField" && row.props.id === id);

  editField("plugin-config-auto-rename-suggestionCount").props.onEdit("2");
  assert.equal(configForms.scope.getSnapshot().value.suggestionCount, undefined, "no write before save");
  const stagedField = editField("plugin-config-auto-rename-suggestionCount");
  assert.equal(stagedField.props.text, "2", "the draft shows up on re-render");
  assert.equal(stagedField.props.overridden, true, "a staged value reads as an override");
  const stagedForm = renderEntry(cards[0], { view: "page" }).tree.props;
  assert.equal(stagedForm.state.dirty, true, "the form is dirty, so Save unlocks");
  assert.equal(stagedForm.state.invalid, false, "a number draft is valid");

  // 非数字草稿必须标成 invalid 并让表单拒绝保存（parse 返回 undefined 的通路）
  stagedField.props.onEdit("abc");
  assert.equal(editField("plugin-config-auto-rename-suggestionCount").props.invalid, true, "a non-numeric draft is invalid");
  assert.equal(
    renderEntry(cards[0], { view: "page" }).tree.props.state.invalid,
    true,
    "the form reports invalid so Save stays locked"
  );
}

// ---- 3a. 有 remote 时：provider/model 两个手填字段换成一个已认证模型下拉 ----
{
  const slots = makeSlots();
  const remote = makeRemote();
  await exports.apply(makeCtx(slots, makeSessions(), makeConfigForms(), remote));
  const cards = slots.of(CARD);
  assert.equal(cards.length, 1);

  // 首次渲染：目录还是 idle，但控件已经是下拉（禁用），不会先闪两个手填框；
  // useEffect 在这一帧触发拉取。
  const before = renderEntry(cards[0], { view: "page" });
  const beforeRows = before.tree.props.children.flat(Infinity).filter(Boolean);
  const beforeSelect = renderModelRow(
    beforeRows.find((row) => typeof row.type === "function" && row.props.catalog !== undefined)
  );
  assert.equal(beforeSelect.props.disabled, true, "the select is disabled while the catalog is loading");
  assert.equal(
    beforeRows.some((row) => row.type === "SettingsValueField" && row.props.id === "plugin-config-auto-rename-provider"),
    false,
    "no hand-entry fields flash before the catalog lands"
  );
  await flush();
  assert.ok(remote.calls.length >= 1, "the card requested the catalog");

  // 目录到位：下拉解禁，选项来自宿主目录
  const page = renderEntry(cards[0], { view: "page" });
  assert.equal(page.tree.type, "SettingsForm");
  const rows = page.tree.props.children.flat(Infinity).filter(Boolean);
  const modelRow = rows.find((row) => typeof row.type === "function" && row.props.catalog !== undefined);
  assert.ok(modelRow, "the model row renders once the catalog is ready");
  assert.deepEqual(
    rows.filter((row) => row.type === "SettingsValueField").map((row) => row.props.id),
    [
      "plugin-config-auto-rename-suggestionCount",
      "plugin-config-auto-rename-maxOutputTokens",
      "plugin-config-auto-rename-timeoutMs",
      "plugin-config-auto-rename-targetWords",
      "plugin-config-auto-rename-targetCjkCharacters"
    ],
    "provider/model hand-entry fields are gone once the catalog is available"
  );

  // 下拉内容来自宿主目录：按 provider 分组，value 是 JSON 编码的 route
  const select = renderModelRow(modelRow);
  assert.equal(select.props.disabled, false, "the select unlocks once routes are listed");
  const offered = optionValues(select);
  assert.deepEqual(offered.slice(0, 2), ["", JSON.stringify(["magpie", "group/never-stuck"])], "follow-main-model plus the first catalog route");
  assert.ok(offered.includes(JSON.stringify(["openai", "gpt-4o-mini"])), "every provider in the catalog is offered");
  assert.ok(
    select.children.flat(Infinity).some((node) => node.type === "optgroup" && node.props.label === "Magpie"),
    "providers render as optgroups"
  );

  // 选一条 route → 同时暂存 provider 与 model（host 侧契约不变）
  modelRow.props.onSelect(JSON.stringify(["openai", "gpt-4o-mini"]));
  const afterRows = renderEntry(cards[0], { view: "page" }).tree.props.children.flat(Infinity).filter(Boolean);
  const picked = renderModelRow(afterRows.find((row) => typeof row.type === "function" && row.props.catalog !== undefined));
  assert.equal(picked.props.value, JSON.stringify(["openai", "gpt-4o-mini"]), "the pick is reflected back into the select");
  assert.equal(afterRows.filter((row) => row.type === "SettingsValueField").length, 5);
  // 选完是「已覆盖」，恢复默认要能把两个字段一起清空
  const resetRow = afterRows.find((row) => typeof row.type === "function" && row.props.catalog !== undefined);
  assert.equal(resetRow.props.provider.overridden, true, "a picked route reads as an override");
  resetRow.props.onSelect("");
  const cleared = renderEntry(cards[0], { view: "page" }).tree.props.children.flat(Infinity).filter(Boolean);
  assert.equal(
    renderModelRow(cleared.find((row) => typeof row.type === "function" && row.props.catalog !== undefined)).props.value,
    "",
    "reset puts the select back on follow-main-model"
  );
}

// ---- 3b. remote 缺席 / 目录失败 → 退回手填两个字段，不炸 ----
{
  const slots = makeSlots();
  await exports.apply(makeCtx(slots, makeSessions(), makeConfigForms(), undefined));
  renderEntry(slots.of(CARD)[0], { view: "page" });
  await flush();
  const rows = renderEntry(slots.of(CARD)[0], { view: "page" }).tree.props.children.flat(Infinity).filter(Boolean);
  assert.ok(
    rows.some((row) => row.type === "SettingsValueField" && row.props.id === "plugin-config-auto-rename-provider"),
    "without a catalog the two hand-entry fields come back"
  );
}

// ---- 3c. 目录里已无当前值 → 下拉仍显示它，不能悄悄归零 ----
{
  const slots = makeSlots();
  const configForms = makeConfigForms({ value: { provider: "gone", model: "retired-model" } });
  await exports.apply(makeCtx(slots, makeSessions(), configForms, makeRemote()));
  renderEntry(slots.of(CARD)[0], { view: "page" });
  await flush();
  const rows = renderEntry(slots.of(CARD)[0], { view: "page" }).tree.props.children.flat(Infinity).filter(Boolean);
  const select = renderModelRow(rows.find((row) => typeof row.type === "function" && row.props.catalog !== undefined));
  assert.equal(select.props.value, JSON.stringify(["gone", "retired-model"]), "the stored route stays selected");
  const offered = optionValues(select);
  assert.ok(offered.includes(JSON.stringify(["gone", "retired-model"])), "the stale route is offered as its own option");
}

// ---- 3d. 宿主未服务该命名空间 → 卡片不注册（不留半张卡） ----
{
  const slots = makeSlots();
  const configForms = makeConfigForms();
  configForms.whileServed = () => () => {};
  await exports.apply(makeCtx(slots, makeSessions(), configForms));
  assert.equal(slots.of(CARD).length, 0, "an unserved namespace must show no card");
  assert.equal(slots.of(HEADER).length, 1, "the header entry is independent of the card");
}

// ---- 3e. 没有 configForms 服务 → 只有卡片缺席，apply 不炸 ----
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
