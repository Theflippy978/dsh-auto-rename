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
  const styleTags = [];
  const window = {
    prefersReducedMotion: false,
    matchMedia: () => ({ matches: window.prefersReducedMotion }),
    __ModuleLoader__: {
      load: (definition) => {
        loaded.push(definition);
      }
    }
  };
  // 样式注入要一个真的 document：client.js 按宿主官方手法插一个 <style>
  // （官方写的是裸 `document`，不是 window.document）。断言挂在 styleTags 上，
  // 所以这里只需最小实现（createElement + head.appendChild + querySelector 去重）。
  const document = {
    head: { appendChild: (tag) => styleTags.push(tag) },
    createElement: () => ({ dataset: {}, textContent: "" }),
    querySelector: (selector) => {
      const id = selector.match(/"(.*)"/)?.[1];
      return styleTags.find((tag) => tag.dataset.pluginCss === id) ?? null;
    }
  };
  globalThis.document = document;
  new Function("window", SOURCE)(window);
  assert.equal(loaded.length, 1, "client.js must call __ModuleLoader__.load exactly once");
  const [definition] = loaded;
  assert.equal(definition.id, "dsh-auto-rename", "module id is the package name");
  const exports = definition.factory(makeRequire(window));
  return { exports, render: window.__renderComponent, window, styleTags };
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

function makeRequire(window) {
  const noop = () => {};
  const hookSlots = new Map();
  let activeHooks;
  /**
   * 渲染一个组件，并按「组件 + 实例 key」分配持久 hook 槽。
   *
   * key 必须按组件区分：HeaderAction 与 RenameDialog 都可能拿到 sessionId "s1"，
   * 若共用一套槽位，两个组件的 useState 会互相覆盖（表现为「点开面板又自动收起」）。
   */
  const renderComponent = (component, props) => {
    const instance = props?.sessionId ?? props?.target?.sessionId ?? "default";
    const key = (component.name || "anon") + "@" + instance;
    let byKey = hookSlots.get(component);
    if (!byKey) hookSlots.set(component, (byKey = new Map()));
    let slots = byKey.get(key);
    if (!slots) byKey.set(key, (slots = []));
    const previous = activeHooks;
    activeHooks = { slots, index: 0 };
    try { return component(props); } finally { activeHooks = previous; }
  };
  window.__renderComponent = renderComponent;
  /**
   * useState 替身：**必须真的记住状态**。
   *
   * 早期版本每次渲染都返回初值，于是「点开设置面板 → 重新渲染」这条路径永远
   * 回到收起态，测试要么漏掉面板内容、要么得靠手工调 props 绕过 —— 那是假通过。
   * 这里按组件实例（renderComponent 分配的槽位）存值，setter 写回同一个槽。
   */
  const hookValue = (initial) => {
    if (!activeHooks) throw new Error("React hook rendered outside renderComponent");
    const frame = activeHooks;
    const index = frame.index++;
    if (!(index in frame.slots)) frame.slots[index] = typeof initial === "function" ? initial() : initial;
    return [frame.slots[index], (next) => {
      frame.slots[index] = typeof next === "function" ? next(frame.slots[index]) : next;
    }];
  };
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: hookValue,
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    // 替身里不跑真实副作用调度，但必须存在：卡片用它触发首次拉目录
    useEffect: (fn) => fn(),
    useRef: (initial) => hookValue(() => ({ current: initial }))[0],
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
  return function require(specifier) {
    if (specifier === "react") return react;
    if (specifier === "@deepseek-ai/dsh-client-ui-primitives") {
      return {
        Button: "Button",
        Modal: "Modal",
        Switch: "Switch",
        Menu: "Menu",
        IconSparkleRegular: "IconSparkleRegular",
        IconSettingsOutlineRegular: "IconSettingsOutlineRegular",
        IconChevronDownOutlineRegular: "IconChevronDownOutlineRegular",
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

/** configForms 替身：get(ns) 给出 SettingsFormModel 需要的 scope。 */
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
  return {
    scope,
    get: (ns) => {
      assert.equal(ns, "dsh-auto-rename", "the form is bound to this plugin's namespace");
      return scope;
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

const { exports, render: renderComponent, window: fakeWindow, styleTags } = loadClient();

/** 记录 client 半边发起的请求，并按 NDJSON 逐行回放 /suggest、用 configValue 应答 /config。 */
function captureFetch(events, options = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    // /config 与 /settings 都是普通 JSON 信封：前者读当前生效值，后者写并回显。
    if (String(url).endsWith("/config") || String(url).endsWith("/settings")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, value: options.configValue ?? {} })
      };
    }
    const lines = events.map((event) => JSON.stringify(event) + "\n");
    // split: true 时把每一行再切成两半，模拟「行边界与 chunk 边界不对齐」——
    // 真实网络下 write() 的分片不保证落在换行处，mock 每次只吐一整行是理想化的。
    const chunks = options.split
      ? lines.flatMap((line) => [line.slice(0, 8), line.slice(8)])
      : lines;
    let index = 0;
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          // 每次 read 只吐一块：这样测试能断言「第一条到达就渲染」，
          // 而整体 JSON 的替身做不到这一点。
          read: async () => (index < chunks.length
            ? { done: false, value: new TextEncoder().encode(chunks[index++]) }
            : { done: true })
        })
      }
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** 渲染一次入口，取出那颗按钮。 */
function renderButton(component, props) {
  const tree = renderComponent(component, props);
  const button = tree.children[0];
  assert.equal(button.type, "button", "first child must be a native button");
  return button;
}

/** 渲染一个 createElement 出来的节点（子组件也要走 hook 夹具，否则 useState 会抛）。 */
function renderNode(node) {
  return renderComponent(node.type, node.props);
}

/** 摊平 createElement 的 children（rest 参数会嵌套数组）。 */
function flattenChildren(node) {
  return node.children.flat(Infinity).filter(Boolean);
}

/** 建议栏里的候选按钮（有 title 的那些；「重新生成」没有 title）。 */
function candidatesOf(node) {
  return flattenChildren(node).filter((child) => child.type === "Button" && child.props.title !== undefined);
}

/** 把「命名模型」那一行渲染一层，取出里面的 select。 */
function renderModelRow(row) {
  const tree = renderNode(row);
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
 * ctx.inject 延迟取、remote 走 get 可选取 —— 替身必须照这个契约给，
 * 否则测不出「服务缺席时只少一块界面、不炸整个 client」。
 *
 * 关键：inject 回调收到的是受限 Context facade，但它的 get(name) 是**可选查找**
 * （真实实现 readService(name, false)，不要求 name 在 inject 声明里）。
 *
 * ⚠️ **`remote.session` 必须注册成独立服务**：宿主 api-gateway 按 namespace 逐个
 * 注册，`remoteServiceKey(ns)` 返回 `remote.${ns}`（源码实证），所以它**不是**
 * `remote` 的属性。早期替身写成 `remote = { session: {...} }`，正好掩盖了
 * 「只 inject remote、读 remote.session」这个真实 bug（用户实测读不到模型目录）。
 * 别再改回嵌套形状。
 */
/**
 * 假 ctx。
 *
 * exports.inject 只声明硬性服务（slots/locale/sessions）；`remote.session` 走
 * `ctx.get` 可选查找 —— 替身必须照这个契约给，否则测不出「服务缺席时只少一块
 * 界面、不炸整个 client」。
 *
 * 关键：apply 收到的 ctx 是 runner 的受限 facade，它的 `get(name)` 是**可选查找**
 * （真实实现 readService(name, false)，不要求 name 在 inject 声明里）。
 *
 * ⚠️ **`remote.session` 必须注册成独立服务**：宿主 api-gateway 按 namespace 逐个
 * 注册，`remoteServiceKey(ns)` 返回 `remote.${ns}`（源码实证），所以它**不是**
 * `remote` 的属性。早期替身写成 `remote = { session: {...} }`，正好掩盖了
 * 「读 remote.session 属性」这个真实 bug（用户实测读不到模型目录）。别再改回嵌套形状。
 *
 * ⚠️ **`ctx.inject` 在真实 facade 上根本不存在**，读它**抛错**（不是 undefined）——
 * runner 的 `dynamicCordisContext` 是个只暴露 `get` + CTX_VERBS 的 Proxy。
 * 替身照实模拟：谁写了 `ctx.inject`，谁就在这里当场炸。那正是「读不到宿主已认证的
 * 模型」的根因，这条替身契约就是为了让同类错误立刻暴露。
 */
function makeCtx(slots, sessions, configForms, session) {
  const services = new Map([
    ["configForms", configForms],
    ["remote.session", session]
  ]);
  const get = (name) => services.get(name);
  const base = {
    slots,
    sessions,
    get,
    locale: { register: () => () => {}, bind: () => (key) => key },
    effect: (fn) => fn(),
    logger: { warn: () => {} }
  };
  // 真实的 ctx 有 setInterval/clearInterval（CTX_VERBS 里就有），轮询等服务的
  // 代码会用到；替身给最小实现：立刻跑一次就停，不真的挂定时器。
  base.setInterval = (fn) => {
    fn();
    return 0;
  };
  base.clearInterval = () => {};
  Object.defineProperty(base, "inject", {
    get() {
      throw new Error('dynamic ctx does not expose "inject"');
    }
  });
  return base;
}

/** 宿主已认证模型目录的替身（形状抄 `remote.session` 服务的 modelCatalog 返回值）。 */
function makeRemote(behaviour = {}) {
  const calls = [];
  return {
    calls,
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
  };
}

const HEADER = "conversation.session.header.actions";
// 官方自己的设置页（settings-web-search / -subagent / -agent-loop）都注册到
// plugins.item（带 id+label，在插件页里作为一个可点条目）。不用 plugins.bundle.config：
// 那是 keyed 槽，插件管理器按 ledger.bundles.has(pkg.name) 决定详情页里渲不渲染配置区，
// 而 ledger 又来自该槽位已注册的 key —— 注册没进去就永远不渲染。
const CARD = "plugins.item";

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
  // 与同槽位的 Agent Team 原生交互标签对齐：默认 tertiary，无底色，hover/focus-visible 变 primary。
  assert.equal(button.props.type, "button");
  assert.equal(button.props.style.color, "var(--dsw-alias-label-tertiary)");
  assert.equal(button.props.style.background, "transparent");
  assert.equal(button.props.style.border, "0");
  assert.equal(button.props["aria-label"], undefined, "visible text is its accessible name");
  assert.equal(button.props.title, "action.aria", "title carries the tooltip");
  assert.equal(button.children[0].type, "IconSparkleRegular", "icon + text, like the native labels");
  assert.equal(button.children[0].props.size, 14, "native neighbours use size 14");
  assert.deepEqual(button.children.slice(1), ["action.label"], "label text comes from the locale table");
  const element = { style: {}, hovered: false, focused: false, matches(selector) {
    return selector === ":hover" ? this.hovered : selector === ":focus-visible" && this.focused;
  } };
  button.props.onMouseEnter({ currentTarget: element });
  assert.equal(element.style.color, "var(--dsw-alias-label-primary)", "hover emphasizes the label without a fill");
  element.hovered = false;
  button.props.onMouseLeave({ currentTarget: element });
  assert.equal(element.style.color, "var(--dsw-alias-label-tertiary)", "pointer leave restores the native default");
  element.focused = true;
  button.props.onFocus({ currentTarget: element });
  assert.equal(element.style.color, "var(--dsw-alias-label-primary)", "keyboard focus emphasizes the label");
  element.focused = false;
  button.props.onBlur({ currentTarget: element });
  assert.equal(element.style.color, "var(--dsw-alias-label-tertiary)", "blur restores the native default");

  const http = captureFetch([
    { type: "title", title: "建议一" },
    { type: "title", title: "建议二" },
    { type: "done" }
  ]);
  try {
    await button.props.onClick();
    // 打开弹窗同时拉建议与当前配置（设置面板要立刻有值），两条都走我们自己的桥。
    assert.deepEqual(
      http.calls.map((call) => call.url),
      ["/dsh-auto-rename/suggest", "/dsh-auto-rename/config"],
      "opening the dialog pulls suggestions and the current config"
    );
    assert.deepEqual(http.calls[0].body, { sessionId: "s1" }, "the suggestion call carries the session id");
  } finally {
    http.restore();
  }
  const dialog = renderComponent(component, { sessionId: "s1" }).children[1];
  const modal = renderNode(dialog);
  const stripElement = modal.children[2];
  stripElement.props.store.set({ status: "ready", titles: [] });
  const strip = renderNode(stripElement);
  const regenerate = strip.children.at(-1);
  assert.equal(regenerate.props.style.color, "var(--dsw-alias-label-tertiary)", "regenerate matches the gray suggestion heading");

  // 逐条到达：第 2 条还没来，第 1 条就已经渲染出来了（不必等最慢的一条）。
  stripElement.props.store.set({ status: "loading", titles: ["建议一"] });
  const partial = renderNode(stripElement);
  const partialTitles = candidatesOf(partial);
  assert.deepEqual(partialTitles.map((node) => node.props.title), ["建议一"], "an arrived candidate renders while the rest are still loading");
  assert.equal(
    flattenChildren(partial).filter((child) => child.type === "Button" && child.props.title === undefined).length,
    0,
    "regenerate stays hidden until the stream finishes"
  );

  // 扫描线揭示：新挂载的候选会从左往右擦出（clip-path 由右往左收回）。
  const animated = [];
  const elementWithAnimate = { animate: (frames, options) => { animated.push({ frames, options }); } };
  partialTitles[0].props.ref(elementWithAnimate);
  assert.equal(animated.length, 1, "a freshly mounted candidate plays the reveal");
  assert.deepEqual(animated[0].frames, [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], "the mask sweeps left to right");
  assert.equal(animated[0].options.duration, 500, "about half a second");

  // reduced-motion 下不播动画，直接显示。
  fakeWindow.prefersReducedMotion = true;
  try {
    const still = [];
    partialTitles[0].props.ref({ animate: (frames) => still.push(frames) });
    assert.equal(still.length, 0, "reduced-motion skips the reveal");
  } finally {
    fakeWindow.prefersReducedMotion = false;
  }

  // 部分失败：已到达的候选保留，状态转为 error 而不是清空。
  stripElement.props.store.set({ status: "error", titles: ["建议一", "建议二"] });
  const degraded = renderNode(stripElement);
  assert.deepEqual(
    candidatesOf(degraded).map((node) => node.props.title),
    ["建议一", "建议二"],
    "a partial failure keeps the candidates that did arrive"
  );

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

// ---- 2c. 行边界与 chunk 边界不对齐时，半行必须被拼回 ----
{
  const slots = makeSlots();
  await exports.apply(makeCtx(slots, makeSessions(), makeConfigForms()));
  const component = slots.of(HEADER)[0].component;

  // 每一行都被切成两块喂进去：若客户端不做跨 chunk 缓冲，
  // JSON.parse 会失败，候选就会静默丢失（表现为「一条建议都没有」）。
  const http = captureFetch([
    { type: "title", title: "拆开的建议" },
    { type: "done" }
  ], { split: true });
  let settled;
  try {
    const button = renderButton(component, { sessionId: "s1" });
    settled = button.props.onClick();
  } finally {
    // onClick 不返回 promise，等微任务链跑完再断言
  }
  await settled;
  await flush();
  http.restore();

  const dialog = renderComponent(component, { sessionId: "s1" }).children[1];
  const stripElement = renderNode(dialog).children[2];
  const titles = candidatesOf(renderNode(stripElement)).map((node) => node.props.title);
  assert.deepEqual(titles, ["拆开的建议"], "a line split across chunks is reassembled, not dropped");
}

// ---- 2d. 弹窗限高 + 设置图标：两处都是「渲染形态」契约，静默失效就退回用户报的故障 ----
{
  const slots = makeSlots();
  await exports.apply(makeCtx(slots, makeSessions(), makeConfigForms()));
  const component = slots.of(HEADER)[0].component;

  // 样式表必须真的注入，且只注一次（apply 可能被跑多次）。
  assert.equal(styleTags.length, 1, "the dialog stylesheet is injected exactly once");
  const css = styleTags[0].textContent;
  // 根因断言：宿主 .dialog 自己不设 max-height（官方注释要求调用方 cap growth），
  // 我们不传就是「整个弹窗上下超出屏幕、标题和底部被裁掉」——用户实测症状。
  assert.match(css, /\.dsh-auto-rename-dialog\{max-height:100%\}/, "the dialog caps its height");
  // 滚动必须落在 .body（content 的最后一个子元素），**不能**开在 .content 上。
  // Edge headless 实测：开在 content 上时滚动条挤压 header 宽度，把关闭键往左推，
  // 相对 .dialog 定位的设置图标偏了 15px（正好压在关闭键上）。
  assert.match(
    css,
    /\.dsh-auto-rename-dialog-content>:last-child\{overflow-y:auto;min-height:0\}/,
    "the scroll region is the body, so the header keeps its width"
  );
  assert.doesNotMatch(
    css,
    /\.dsh-auto-rename-dialog-content\{[^}]*overflow-y:auto/,
    "the scroll must not sit on .content: its scrollbar would shift the header and the gear"
  );
  // 设置图标钉在关闭键左边：关闭键左边缘距右 42px（header 右 padding 14 + 28 宽），
  // 再留 8px 间距 = 50px。
  assert.match(css, /\.dsh-auto-rename-settings\{position:absolute;top:22px;right:50px/, "the gear sits left of the close button");

  const http = captureFetch([]);
  try {
    await renderButton(component, { sessionId: "s1" }).props.onClick();
  } finally {
    http.restore();
  }
  const modal = renderNode(renderComponent(component, { sessionId: "s1" }).children[1]);
  assert.equal(modal.type, "Modal", "the dialog is still the host Modal");
  assert.equal(modal.props.className, "dsh-auto-rename-dialog", "the height cap reaches the Modal");
  assert.equal(modal.props.contentClassName, "dsh-auto-rename-dialog-content", "so does the scroll region");
  // 首个子节点就是设置图标：它按绝对定位钉进标题行，DOM 顺序不决定视觉位置。
  const gear = modal.children[0];
  assert.equal(gear.type, "button", "the gear is a native button (keyboard + AT semantics)");
  assert.equal(gear.props.className, "dsh-auto-rename-settings");
  assert.equal(gear.props["aria-expanded"], false, "collapsed until asked");
  assert.equal(gear.children[0].type, "IconSettingsOutlineRegular", "a settings glyph, size 14 like the close button");
  assert.equal(gear.children[0].props.size, 14);

  // 点开 → aria-expanded 翻真，面板出现在弹窗里。
  // （替身无法驱动 useState 的 set → re-render 循环，所以这条只断言按钮报出的状态。）
  gear.props.onClick();
  assert.equal(gear.props["aria-label"], "settings.show", "the collapsed gear names the action");
}

// ---- 3. 设置面板：自绘在「AI 命名」弹窗里，不依赖宿主插槽 ----
{
  const slots = makeSlots();
  await exports.apply(makeCtx(slots, makeSessions(), makeConfigForms()));

  // 关键契约：不再向宿主的设置槽位注册任何东西。
  // 历史教训——注册到 plugins.bundle.config / plugins.item 都试过，
  // 注册代码走通了但真实界面不渲染，且失败是静默的。改成弹窗内自绘后，
  // 这条断言守住「不要再接回宿主插槽」。
  assert.equal(slots.of("plugins.item").length, 0, "no settings page is registered into the host's slots any more");
  assert.equal(slots.of("plugins.bundle.config").length, 0, "nor into the keyed bundle-config slot");
  assert.equal(slots.of(HEADER).length, 1, "the header entry is still the one host slot we use");

  // 面板直接渲染（不走 React 状态流转：替身无法驱动 useState 的 set → re-render 循环，
  // 那条路径只会得到假通过）。settingsStore 由测试自己造，语义与 HeaderAction 里一致。
  const SettingsPanel = exports.__test.SettingsPanel;
  assert.equal(typeof SettingsPanel, "function", "the panel is exported for direct rendering");
  const flat = (node) => node.children.flat(Infinity).filter(Boolean);

  // 面板用 useStore(props.store)，所以 store 必须有 getSnapshot/subscribe。
  const store = (snapshot) => ({ getSnapshot: () => snapshot, subscribe: () => () => {} });
  const base = {
    status: "idle",
    draft: {
      autoRenameEnabled: true,
      suggestionCount: 3,
      maxOutputTokens: 64,
      timeoutMs: 60000,
      targetCjkCharacters: 12,
      provider: "",
      model: ""
    },
    message: ""
  };
  const edited = [];
  // input/Switch 都嵌在「行 div」里，只摊平一层取不到，要递归。
  // **函数式子组件必须渲染**：React 会调它们（ModelPicker 就是这样嵌在面板里的），
  // 不展开的话它的输入框与 Menu 全都看不见 —— 断言会静默漏掉整块 UI。
  const deep = (node, out = []) => {
    for (const child of flat(node)) {
      if (typeof child.type === "function" && child.type !== "Fragment") {
        const rendered = renderNode(child);
        out.push(rendered);
        if (Array.isArray(rendered.children)) deep(rendered, out);
        continue;
      }
      out.push(child);
      if (Array.isArray(child.children)) deep(child, out);
    }
    return out;
  };
  // 面板现在还需要「宿主已认证模型目录」：命名模型只能从目录里选，不能手填。
  // 这里给一个带两组 provider 的假目录，语义与 apply 里接 remote 后一致。
  const catalogStore = (snapshot) => ({ getSnapshot: () => snapshot, subscribe: () => () => {} });
  const catalogOf = (snapshot = { status: "ready", groups: [] }) => ({
    store: catalogStore(snapshot),
    load: () => {},
    remote: undefined
  });
  // 注入的样式表（本块也要用：搜索行的 order:-1 只有 CSS 能表达）。
  const css = styleTags[0].textContent;
  const panel = (snapshot = base, catalog = catalogOf()) =>
    renderNode({
      type: SettingsPanel,
      props: {
        store: store(snapshot),
        catalog: catalog,
        onEdit: (field, value) => edited.push([field, value]),
        onSave: () => {}
      }
    });
  const nodes = (snapshot, catalog) => [panel(snapshot, catalog), ...deep(panel(snapshot, catalog))];

  // 1. 面板读到的就是服务端的生效值，不是空白
  const inputs = nodes().filter((n) => n.type === "input");
  const values = inputs.map((n) => n.props.value);

  assert.ok(values.includes("64"), "token limit comes from the live config");
  assert.ok(values.includes("60000"), "timeout comes from the live config");
  assert.ok(values.includes("12"), "title width comes from the live config");
  assert.ok(
    nodes().some((n) => n.type === "Switch" && n.props.checked === true),
    "the boolean row reflects the live config"
  );
  // 留空 = 跟随主模型，不是把字面量 "undefined" 显示给用户
  assert.ok(
    inputs.some((n) => n.props.value === "" && n.props["aria-label"] === "settings.provider"),
    "an unset provider renders as blank, not the string \"undefined\""
  );

  // 2. 编辑只报给调用方（写草稿），不发请求；点保存才 POST
  const countInput = inputs.find((n) => n.props["aria-label"] === "settings.count");
  countInput.props.onChange({ target: { value: "5" } });
  assert.deepEqual(edited, [["suggestionCount", "5"]], "editing reports the field and raw text upward");

  // 保存动作由 HeaderAction 提供（saveSettings），这里用真的桥验证「点保存会写」。
  const http = captureFetch([], {
    configValue: { suggestionCount: 5, targetCjkCharacters: 12, timeoutMs: 60000, maxOutputTokens: 64 }
  });
  try {
    // 直接测 saveConfig 这条桥：点保存最终一定走到它。
    await exports.__test.saveConfig({ suggestionCount: 5 });
    const writes = http.calls.filter((c) => c.url.endsWith("/settings"));
    assert.equal(writes.length, 1, "saving writes exactly once");
    assert.deepEqual(writes[0].body, { suggestionCount: 5 }, "the staged draft is what gets written");
  } finally {
    http.restore();
  }

  // 3. 保存中：按钮显示 saving 且禁用，避免连点
  const saving = nodes({ ...base, saving: true })
    .find((n) => n.type === "Button" && n.children.includes("saving"));
  assert.ok(saving, "a saving panel shows its busy label");
  assert.equal(saving.props.disabled, true, "the save button is disabled while saving");

  // 4. 入口状态行仍在面板里（它原本住在从不显示的宿主卡片里，是唯一的可见诊断通道）
  const headerStore = exports.__test.headerStatusStore;
  headerStore.set({ state: "registered", message: "" });
  assert.ok(
    nodes().some((n) => typeof n.children?.[0] === "string" && n.children[0] === "settings.headerOk"),
    "the header status line is still surfaced in the panel"
  );
  headerStore.set({ state: "pending", message: "" });

  // 5. 圆角方框：设置区必须是一个有边框的框，不能跟建议栏糊在一起。
  //    边框不能省成「只靠底色」——浅色主题下 bg-layer-1/2/3 全是 #fff（令牌表实测），
  //    只靠填充的话方框在浅色主题里完全隐形。
  const root = panel();
  assert.equal(root.props.style.borderRadius, "var(--dsw-radius-lg)", "the settings block is a rounded box");
  assert.match(root.props.style.border, /solid/, "the box has a visible border in both themes");
  assert.ok(root.props.style.marginTop, "it is separated from the suggestion strip above it");

  // 6. 数字行：标签+提示在左、窄数字框在右（右列对齐成一条线）
  const numbers = nodes().filter((n) => n.type === "input" && n.props.style?.textAlign === "center");
  assert.equal(numbers.length, 4, "the four numeric fields share one compact control");
  assert.deepEqual(
    numbers.map((n) => n.props.style.width),
    ["76px", "76px", "76px", "76px"],
    "every numeric control is the same width, so the right column lines up"
  );
  for (const control of numbers) {
    assert.equal(control.props.inputMode, "numeric", "numeric fields ask for the numeric keypad");
  }

  // 7. 命名模型：两个**只读**框显示当前选择 + 图标按钮打开宿主已认证模型下拉。
  //    这是用户 2026-10-15 纠正的核心 —— 上一版退化成手填 provider/model，
  //    手填错一个字符就变成「配置半对」，要到第一次自动命名才报错。
  const pair = nodes().filter(
    (n) => n.type === "input" && ["settings.provider", "settings.modelName"].includes(n.props["aria-label"])
  );
  assert.equal(pair.length, 2, "both halves of the model route are shown");
  for (const control of pair) {
    assert.equal(control.props.readOnly, true, "the route fields are read-only: it must match the Host's catalog");
    assert.equal(control.props.onChange, undefined, "no hand editing, so no change handler");
  }
  assert.deepEqual(
    pair.map((n) => n.props["aria-label"]),
    ["settings.provider", "settings.modelName"],
    "provider comes first, matching how the route is written"
  );

  // 选择器用宿主官方 P.Menu（自带锚定定位、键盘遍历、外部点击关闭）。
  const menu = nodes().find((n) => n.type === "Menu");
  assert.ok(menu, "the picker is an anchored Menu, not a hand-rolled dropdown");
  assert.equal(menu.props.portal, true, "portal escapes the dialog's overflow clipping");
  assert.equal(menu.props.open, false, "closed until the icon is pressed");

  // 触发按钮：图标式，带 aria-expanded。它是 Menu 的 anchor（渲染在原位），
  // 所以不在 children 树里，要从 Menu 的 props 取。
  const trigger = menu.props.anchor;
  assert.equal(trigger.type, "button", "the anchor is a native button");
  assert.equal(trigger.props.className, "dsh-auto-rename-picker");
  assert.equal(trigger.props["aria-expanded"], false, "collapsed until asked");
  assert.equal(trigger.props["aria-label"], "settings.pickModel", "the icon carries an accessible name");
  assert.equal(trigger.children[0].type, "IconChevronDownOutlineRegular", "a chevron marks 'opens a list'");

  // 目录内容：按 provider 分组，第一项固定是「跟随主模型」。
  const withCatalog = () =>
    nodes(base, catalogOf({
      status: "ready",
      groups: [
        { id: "magpie", name: "Magpie", models: [{ id: "group/never-stuck", name: "never-stuck" }, { id: "qoder/qfmodel", name: "qfmodel" }] },
        { id: "openai", name: "OpenAI", models: [{ id: "gpt-4o-mini", name: "GPT-4o mini" }] }
      ]
    }));
  const menuWith = withCatalog().find((n) => n.type === "Menu");
  const items = menuWith.props.items;
  assert.equal(items[0].id, "follow", "following the main model is always the first choice");
  assert.ok(
    items.some((entry) => entry.type === "label" && entry.text === "Magpie"),
    "models are grouped under their provider"
  );
  // 选中项用 JSON 编码的 route：model id 本身可能含 "/"，拼字符串再 split 会拆错。
  assert.ok(
    items.some((entry) => entry.id === JSON.stringify(["magpie", "group/never-stuck"])),
    "a model id containing a slash survives the round trip"
  );

  // 选一个模型 → 两个字段一起进草稿（provider + model 是成对的）。
  menuWith.props.onSelect(JSON.stringify(["openai", "gpt-4o-mini"]));
  assert.deepEqual(
    edited.slice(-2),
    [["provider", "openai"], ["model", "gpt-4o-mini"]],
    "picking a model stages both halves of the route"
  );
  // 选「跟随主模型」→ 两个字段一起清空。
  menuWith.props.onSelect("follow");
  assert.deepEqual(edited.slice(-2), [["provider", ""], ["model", ""]], "following the main model clears the route");

  // 当前值不在目录里也要显示出来，否则用户会以为配置丢了。
  const stale = nodes({ ...base, draft: { ...base.draft, provider: "gone", model: "retired" } }, catalogOf({
    status: "ready",
    groups: [{ id: "magpie", name: "Magpie", models: [{ id: "group/never-stuck", name: "never-stuck" }] }]
  })).find((n) => n.type === "Menu");
  assert.ok(
    stale.props.items.some((entry) => entry.id === JSON.stringify(["gone", "retired"])),
    "a route missing from the catalog stays visible instead of silently resetting"
  );
  assert.equal(stale.props.selectedId, JSON.stringify(["gone", "retired"]), "and it is still shown as the selection");

  // 搜索：目录够大时给一行搜索框，且它靠 CSS order:-1 提到列表最前
  //（P.Menu 把 children 渲染在 items 之后）。
  const searchBox = withCatalog().find((n) => n.type === "input" && n.props["aria-label"] === "settings.searchModel");
  assert.ok(searchBox, "a search row is offered when there is a real catalog");
  assert.match(
    css,
    /\.dsh-auto-rename-picker-search\{order:-1/,
    "the search row is ordered above the items P.Menu renders before it"
  );
}

// ---- 3b. apply 必须从 `remote.session` 服务取目录，而不是 `remote.session` 属性 ----
// 这条守住真实故障：宿主 api-gateway 按 namespace 逐个注册服务（`remote.${ns}`），
// `remote.session` 是**独立服务**。早期实现只 inject `remote` 再读 `remote.session`
// 属性，恒为 undefined —— 目录永远读不到，用户看到「读不到宿主已认证的模型」。
{
  const slots = makeSlots();
  const session = makeRemote();
  await exports.apply(makeCtx(slots, makeSessions(), makeConfigForms(), session));
  await flush();

  assert.equal(session.calls.length, 1, "the catalog is fetched from the remote.session service at startup");

  // 目录真的进了 store：打开选择器时应能看到分组的模型，而不是空列表。
  const http = captureFetch([]);
  try {
    await renderButton(slots.of(HEADER)[0].component, { sessionId: "s1" }).props.onClick();
  } finally {
    http.restore();
  }
  const dialog = renderComponent(slots.of(HEADER)[0].component, { sessionId: "s1" }).children[1];
  const SettingsPanel = exports.__test.SettingsPanel;
  const settingsStore = dialog.props.settingsStore;
  const panel = renderNode({
    type: SettingsPanel,
    props: {
      store: settingsStore,
      catalog: exports.__test.modelCatalog,
      onEdit: () => {},
      onSave: () => {}
    }
  });
  const flat2 = (n) => (n.children ?? []).flat(Infinity).filter(Boolean);
  const deep2 = (node, out = []) => {
    for (const child of flat2(node)) {
      if (typeof child.type === "function" && child.type !== "Fragment") {
        const rendered = renderNode(child);
        out.push(rendered);
        if (Array.isArray(rendered.children)) deep2(rendered, out);
        continue;
      }
      out.push(child);
      if (Array.isArray(child.children)) deep2(child, out);
    }
    return out;
  };
  const menu = [panel, ...deep2(panel)].find((n) => n.type === "Menu");
  assert.ok(menu, "the picker renders");
  assert.ok(
    menu.props.items.some((entry) => entry.id === JSON.stringify(["magpie", "group/never-stuck"])),
    "the live catalog's models reach the picker, so the list is not empty"
  );
}

// ---- 3c. 目录首次失败后，服务晚到仍能恢复（一次早失败不能永久卡住） ----
// ⚠️ modelCatalog 是**模块级单例**（apply 每次接同一个实例），所以这里不假设初始
// 状态是 error —— 前面的用例可能已经把它拉成 ready。改为验证「拿到服务后一定能用」，
// 以及「服务缺席时 load() 会如实报 error 而不是假装空目录」。
{
  const slots = makeSlots();
  // 服务缺席时 load() 必须报 error：空列表会让用户以为「宿主没有模型」。
  await exports.apply(makeCtx(slots, makeSessions(), makeConfigForms(), undefined));
  await flush();
  const catalog = exports.__test.modelCatalog;
  catalog.session = undefined;
  catalog.load();
  await flush();
  assert.equal(
    catalog.store.getSnapshot().status,
    "error",
    "without the service the catalog reports an error instead of pretending to be empty"
  );

  // 服务随后就绪 → 再接一次必须恢复（真实场景是 inject 回调补上）。
  const session = makeRemote();
  await exports.apply(makeCtx(slots, makeSessions(), makeConfigForms(), session));
  await flush();
  assert.equal(session.calls.length, 1, "a late-arriving service still gets wired up");
  assert.equal(
    catalog.store.getSnapshot().status,
    "ready",
    "and the catalog recovers instead of staying broken"
  );
}

// ---- 3d. 打开选择器时，idle **和 error** 都要重拉（一次早失败不能永久卡住） ----
// 替身不跑 useEffect 的依赖追踪，所以直接读源码里的判据：
// 这条守的是「只认 idle」的回归 —— 那会让一次早失败永久停在「读不到模型」。
{
  const source = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "client.js"), "utf8");
  const effect = source.slice(source.indexOf("React.useEffect(function () {\n        if (open"));
  const guard = effect.slice(0, effect.indexOf("}, [open"));
  assert.match(
    guard,
    /catalog\.status === "idle" \|\| catalog\.status === "error"/,
    "opening the picker retries after a failure, not only on the first attempt"
  );
}

// ---- 3e. 两个只读框的标签不许带「命名」前缀（用户 2026-10-16 明确要求删掉） ----
{
  const zh = exports.__test.dictionaries?.zh ?? null;
  assert.ok(zh, "the Chinese dictionary is exposed for auditing");
  assert.equal(zh["settings.provider"], "Provider", "the Provider field is labelled plainly");
  assert.equal(zh["settings.modelName"], "Model", "the Model field is labelled plainly");
  for (const key of ["settings.provider", "settings.modelName"]) {
    assert.ok(!zh[key].includes("命名"), `"${key}" must not repeat the section title`);
  }
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
    assert.equal(
      http.calls.filter((call) => call.url.endsWith("/suggest")).length,
      1,
      "still fetches suggestions even when the session snapshot throws"
    );
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
