/**
 * dsh-auto-rename —— Client 半边。
 *
 * 三块 UI：
 *  1. 对话页顶部 `创造模式` 右侧的「AI 命名」按钮（conversation.session.header.actions）。
 *  2. 自绘的重命名 Modal：形态对齐 host 原生重命名窗口（同款 Modal、同款
 *     title / input / IME 守卫 / Enter 确认 / 取消与重命名 footer），
 *     输入框下方一条 Codex 式小字建议栏：3 个可点击 chip + 重新生成。
 *  3. 设置卡片（plugins.bundle.config，按包名 keyed）：命名模型、条数、
 *     token 上限等，用宿主官方 SettingsForm。
 *
 * 提交重命名走官方通道：sessions.using(id, {source:"workspaceOperation"},
 * ref => ref.binding.session.rename(title))，与侧栏双击标题改名同一条路。
 */

window.__ModuleLoader__.load({
  id: "dsh-auto-rename",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var P = require("@deepseek-ai/dsh-client-ui-primitives");
    var e = React.createElement;
    var useS = React.useSyncExternalStore;

    var NS = "dsh-auto-rename";
    var SLOT_HEADER_ACTIONS = "conversation.session.header.actions";

    /**
     * 弹窗自绘部分的类名与样式表。
     *
     * 插件包没有自己的 CSS module，而这里有两件事内联 style 做不到：hover 态，
     * 以及把「设置」图标钉到标题行的关闭键左边。注入手法照抄宿主官方
     * （dsh-client-ui-layout 就是这样注入 AppFrame.module.css 的）：一个带
     * data-plugin-css 标记的 <style>，同一 id 只插一次。
     */
    var DIALOG_CLASS = "dsh-auto-rename-dialog";
    var DIALOG_CONTENT_CLASS = "dsh-auto-rename-dialog-content";
    var SETTINGS_BUTTON_CLASS = "dsh-auto-rename-settings";
    var PICKER_TRIGGER_CLASS = "dsh-auto-rename-picker";
    var PICKER_SEARCH_CLASS = "dsh-auto-rename-picker-search";
    var STYLE_ID = NS + "/dialog.css";
    var DIALOG_CSS =
      // 限高：宿主 P.Modal 的 .dialog 没有 max-height，内容一高就整块撑破视口、
      // 标题和底部一起被裁掉（用户实测症状）。官方注释原话：卡片要对 padding box
      // 限高，用 max-height:100%，不要自己算视口。
      "." + DIALOG_CLASS + "{max-height:100%}" +
      // 滚动区必须落在 .body（content 的最后一个子元素），**不能**开在 .content 上。
      // content 里还装着 header；在 content 上开滚动条会挤压 header 宽度，把关闭键
      // 往左推，而设置图标是相对 .dialog 定位的 —— 实测偏 15px（滚动条宽度），
      // 图标直接压到关闭键上。开在 body 上，标题行就与滚动条无关。
      // min-height:0 是 flex 子项能收缩到内容高度以下的前提。
      "." + DIALOG_CONTENT_CLASS + "{display:flex;flex-direction:column;min-height:0}" +
      "." + DIALOG_CONTENT_CLASS + ">:last-child{overflow-y:auto;min-height:0}" +
      "." + DIALOG_CLASS + ">:not(." + DIALOG_CONTENT_CLASS + "){flex:none}" +
      // 设置图标：形态对齐同一行的关闭键（28×28、圆角、无底色、hover 出底色）。
      // 位置是相对 .dialog 的绝对定位 —— 标题行由宿主在 Modal 内部渲染，插件塞不
      // 进去，只能把按钮渲染在 body 里再钉回去。坐标来自 Modal.module.css 的
      // .header padding(22px 14px 12px 24px) 与 .close 的 28px 宽：关闭键左边缘距
      // 右边 42px，再留 8px 间距（官方 header 的 gap 就是 8px）。副作用正好是想要
      // 的：包含块是 .dialog，滚动 .content 时图标不跟着滚。
      "." + SETTINGS_BUTTON_CLASS + "{position:absolute;top:22px;right:50px;z-index:1;" +
      "display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;" +
      "padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;" +
      "color:var(--dsw-alias-label-secondary);cursor:pointer}" +
      "." + SETTINGS_BUTTON_CLASS + ":hover,." + SETTINGS_BUTTON_CLASS + '[aria-expanded="true"]' +
      "{background:var(--dsw-alias-interactive-bg-hover)}" +
      "." + SETTINGS_BUTTON_CLASS + ":focus-visible{outline:var(--dsw-focus-ring-width) solid " +
      "var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}" +
      // 模型选择器：只读框 + 图标按钮一行。
      "." + PICKER_TRIGGER_CLASS + "{flex:none;display:inline-flex;align-items:center;justify-content:center;" +
      "width:30px;height:30px;padding:0;border:0.5px solid var(--dsw-alias-border-l4);" +
      "border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);" +
      "color:var(--dsw-alias-label-secondary);cursor:pointer}" +
      "." + PICKER_TRIGGER_CLASS + ":hover{background:var(--dsw-alias-interactive-bg-hover);" +
      "color:var(--dsw-alias-label-primary)}" +
      "." + PICKER_TRIGGER_CLASS + ":focus-visible{outline:var(--dsw-focus-ring-width) solid " +
      "var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}" +
      "." + PICKER_TRIGGER_CLASS + " svg{transition:transform .12s}" +
      "." + PICKER_TRIGGER_CLASS + '[aria-expanded="true"] svg{transform:rotate(180deg)}' +
      // 搜索行：P.Menu 把 children 渲染在 items **之后**，所以用 order:-1 提到最前；
      // 再 sticky 钉住，列表长了搜索框不会被滚走（.viewport 是 flex 列，order 生效）。
      // 背景取菜单同一套材质令牌，否则滚动的行会从搜索框底下透出来。
      "." + PICKER_SEARCH_CLASS + "{order:-1;position:sticky;top:0;z-index:1;flex:none;" +
      "margin:2px 0 3px;background:var(--dsw-menu-surface-fill);" +
      "backdrop-filter:var(--dsw-menu-backdrop-filter)}" +
      "." + PICKER_SEARCH_CLASS + " input{box-sizing:border-box;width:100%;height:28px;padding:0 8px;" +
      "border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);" +
      "background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);" +
      "font:inherit;font-size:12px;line-height:1.5}" +
      "." + PICKER_SEARCH_CLASS + " input:focus-visible{outline:none;" +
      "border-color:var(--dsw-alias-state-business-primary)}";

    /** 注入样式表；同一 id 只插一次，宿主没给 document 时静默跳过（测试替身）。 */
    function installDialogStyles() {
      if (typeof document === "undefined") return;
      if (document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]") !== null) return;
      var tag = document.createElement("style");
      tag.dataset.plugin = NS;
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = DIALOG_CSS;
      document.head.appendChild(tag);
    }

    function errorMessage(error) {
      return error instanceof Error ? error.message : String(error);
    }

    var ZH = {
      "action.label": "AI 命名",
      "action.aria": "打开 AI 命名建议",
      "modal.title": "重命名会话",
      "modal.rename": "重命名",
      "modal.cancel": "取消",
      "modal.close": "关闭",
      "modal.field": "会话名称",
      "modal.suggest": "AI 建议",
      "modal.regenerate": "重新生成",
      "modal.loading": "思考中…",
      "modal.error": "建议获取失败",
      "description": "随对话自动刷新标题，并在重命名窗口中提供 AI 建议。",
      "settings.title": "自动重命名",
      "settings.show": "设置",
      "settings.hide": "收起设置",
      "settings.saved": "已保存",
      "settings.enable": "随对话自动刷新标题",
      "settings.enableHint": "开启后，每条新消息都会触发一次重新命名，标题仍然准确时保持不变；关闭后仅在首条消息时命名一次。手动重命名会停止自动更新。",
      "settings.model": "命名模型",
      "settings.modelHint": "仅列出宿主已认证且当前可用的模型；选择「跟随主模型」时不额外调用命名模型。",
      "settings.pickModel": "选择命名模型",
      "settings.searchModel": "搜索模型",
      "settings.noMatch": "没有匹配的模型。",
      "settings.notListed": "不在当前目录中",
      "settings.catalogUnavailable": "无法读取宿主已认证的模型；命名将跟随当前对话的主模型。",
      "settings.catalogLoading": "正在读取宿主已认证的模型…",
      "settings.provider": "Provider",
      "settings.providerHint": "与 Model 成对填写；两者都留空表示跟随当前对话的主模型。",
      "settings.modelName": "Model",
      "settings.modelNameHint": "建议指定一个低成本的模型，留空表示跟随主模型。",
      "settings.count": "建议条数",
      "settings.countHint": "重命名窗口一次返回的候选数量，取值范围 1–5。",
      "settings.tokens": "输出上限（token）",
      "settings.tokensHint": "单次生成的输出上限，取值范围 8–4096。推理模型的思考与答案共享该上限，因此推理模型固定按 4096 发送：更低的值会被思考耗尽，标题返回为空。可关闭推理的模型与非推理模型按填写值生效。",
      "settings.reasoning": "推理档位",
      "settings.reasoningAuto": "自动（可关闭时关闭，否则取最低档）",
      "settings.reasoningPick": "使用：",
      "settings.reasoningPicked": "已按所选档位发送：",
      "settings.reasoningFallback": "该模型没有这个档位，已回退：",
      "settings.reasoningOff": "该模型支持关闭推理，命名时已关闭。",
      "settings.reasoningLow": "该模型不支持关闭推理，已回退到其支持的最低档：",
      "settings.reasoningNone": "该模型不提供推理档位（非推理模型），命名时不发送推理参数。",
      "settings.reasoningUnknown": "无法读取该模型的推理能力；命名仍会执行，仅无法确认是否启用推理。",
      "settings.reasoningList": "可选档位：",
      "settings.reasoningDefault": "模型默认档位：",
      "settings.reasoningBudget": "本次实际输出上限：",
      "settings.timeout": "超时（毫秒）",
      "settings.timeoutHint": "单次生成标题的最长等待时间，取值范围 1000–600000，默认 60000。重试会重新获得完整预算，最坏总时长为该值的两倍。",
      "settings.cjk": "标题宽度（中文字数）",
      "settings.cjkHint": "标题长度的唯一设置项，中英文共用，取值范围 1–400。一个汉字计 2 个半角单位，因此 12 对应中文 12 字或英文 24 个字符（含空格），超出部分直接截断。",
      "settings.followHint": "跟随主模型",
      "settings.headerOk": "顶部「AI 命名」入口已注册。",
      "settings.headerIdle": "顶部入口尚未注册（当前界面没有对话页头部插槽）。",
      "settings.headerBad": "顶部「AI 命名」入口注册失败",
      "overridden": "已覆盖",
      "reset": "恢复默认",
      "invalidNumber": "请填数字；留空表示使用默认值。",
      "readOnly": "本部署的设置为只读。",
      "unavailable": "该插件当前未加载，暂时无法配置。",
      "save": "保存",
      "saving": "保存中…",
      "saveFailed": "本部署没有接受这些值，已保留供你修改。"
    };
    var EN = {
      "action.label": "AI Name",
      "action.aria": "Open AI naming suggestion",
      "modal.title": "Rename session",
      "modal.rename": "Rename",
      "modal.cancel": "Cancel",
      "modal.close": "Close",
      "modal.field": "Session name",
      "modal.suggest": "AI suggestion",
      "modal.regenerate": "Regenerate",
      "modal.loading": "Thinking…",
      "modal.error": "Failed to fetch suggestion",
      "description": "Refreshes the title as the conversation grows and offers AI suggestions in the rename dialog.",
      "settings.title": "Auto rename",
      "settings.show": "Settings",
      "settings.hide": "Hide settings",
      "settings.saved": "Saved",
      "settings.enable": "Refresh title as the conversation grows",
      "settings.enableHint": "When enabled, every new message triggers a rename, and an accurate title is kept unchanged. When disabled, the session is named once from its first message. A manual rename stops automatic updates.",
      "settings.model": "Naming model",
      "settings.modelHint": "Lists only models the Host has authenticated and can currently serve; choosing “Follow main model” skips the extra naming call.",
      "settings.pickModel": "Choose the naming model",
      "settings.searchModel": "Search models",
      "settings.noMatch": "No matching model.",
      "settings.notListed": "not in the current catalog",
      "settings.catalogUnavailable": "Unable to read the Host's authenticated models; naming will follow the conversation's main model.",
      "settings.catalogLoading": "Reading the Host's authenticated models…",
      "settings.provider": "Provider",
      "settings.providerHint": "Set together with Model; leave both empty to follow the conversation's main model.",
      "settings.modelName": "Model",
      "settings.modelNameHint": "A low-cost model is recommended; leave empty to follow the main model.",
      "settings.count": "Suggestion count",
      "settings.countHint": "Number of candidates the rename dialog returns at once, 1–5.",
      "settings.tokens": "Output limit (tokens)",
      "settings.tokensHint": "Output limit for a single generation, 8–4096. A reasoning model shares this limit between its thinking and its answer, so reasoning models always send 4096: lower values are consumed by thinking and the title comes back empty. Models that can disable reasoning, and non-reasoning models, use the entered value.",
      "settings.reasoning": "Reasoning effort",
      "settings.reasoningAuto": "Auto (off when supported, otherwise the lowest)",
      "settings.reasoningPick": "Use: ",
      "settings.reasoningPicked": "Sent the selected effort: ",
      "settings.reasoningFallback": "This model has no such effort; naming fell back to: ",
      "settings.reasoningOff": "This model can disable reasoning; naming turns it off.",
      "settings.reasoningLow": "This model cannot disable reasoning, so naming uses its lowest supported effort: ",
      "settings.reasoningNone": "This model offers no reasoning efforts (not a reasoning model); naming sends no effort at all.",
      "settings.reasoningUnknown": "Unable to read this model's reasoning capability; naming still runs, but whether it reasons cannot be confirmed.",
      "settings.reasoningList": "Available efforts: ",
      "settings.reasoningDefault": "Model default: ",
      "settings.reasoningBudget": "Effective output limit: ",
      "settings.timeout": "Timeout (ms)",
      "settings.timeoutHint": "Maximum wait for one title generation, 1000–600000, default 60000. A retry receives a full budget again, so the worst case is twice this value.",
      "settings.cjk": "Title width (CJK characters)",
      "settings.cjkHint": "The only length setting for titles, shared by both scripts, 1–400. One CJK character counts as 2 half-width units, so 12 means 12 Chinese characters or 24 Latin characters including spaces. Anything longer is truncated.",
      "settings.followHint": "Follow main model",
      "settings.headerOk": "The “AI Name” header entry is registered.",
      "settings.headerIdle": "The header entry is not registered yet (no conversation header slot on this screen).",
      "settings.headerBad": "The “AI Name” header entry failed to register",
      "overridden": "Overridden",
      "reset": "Reset to default",
      "invalidNumber": "Enter a number, or leave blank to use the default.",
      "readOnly": "This deployment stores settings read-only.",
      "unavailable": "This plugin is not loaded, so it cannot be configured right now.",
      "save": "Save",
      "saving": "Saving…",
      "saveFailed": "This deployment did not accept these values; they were left for you to correct."
    };

    /**
     * 文案取值。apply 时经 ctx.locale.bind(NS) 换成宿主语言版本；
     * 在那之前（组件定义阶段不会用到）回退到中文表。
     */
    var t = function (key) { return ZH[key] !== undefined ? ZH[key] : key; };

    /**
     * 订阅一个 store，subscribe 身份稳定（避免每次 render 重新订阅）。
     *
     * 参数顺序是 React 的签名：useSyncExternalStore(subscribe, getSnapshot)。
     * 写反时 getSnapshot 拿到的是 subscribe，每次 render 返回一个新的闭包函数
     * ——React 判定快照不稳定，entry 直接被 SlotErrorBoundary 吞掉，表现为
     * 「按钮没出现」且没有任何可见报错。
     */
    function useStore(store) {
      var subscribe = React.useMemo(function () {
        return function (listener) { return store.subscribe(listener); };
      }, [store]);
      var getSnapshot = React.useMemo(function () { return function () { return store.getSnapshot(); }; }, [store]);
      return useS(subscribe, getSnapshot);
    }

    /** 扫描线揭示时长（用户要求约 500ms）。 */
    var REVEAL_MS = 500;

    /** 「已保存」状态停留时长，之后自动回到 idle。 */
    var SAVED_HINT_MS = 2000;

    /** 系统要求减少动态效果时不要播放揭示动画。 */
    function prefersReducedMotion() {
      try {
        return typeof window.matchMedia === "function" &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
      } catch {
        return false;
      }
    }

    /**
     * 新到的候选从左往右擦出，像一条扫描线。
     *
     * 用 Web Animations 而不是 CSS 过渡：插件包没有自己的 CSS module，动效又必须在
     * 「元素刚挂载」这一刻触发，而内联 style 加过渡属性没有可靠的触发点。
     * clip-path 从「右侧整段裁掉」到「不裁」，视觉上就是从左到右扫过一遍。
     * 系统开了减少动态效果、或环境没有 animate 时直接显示，不留半截动画。
     */
    function revealSuggestion(element) {
      if (element === null || element === undefined) return;
      if (prefersReducedMotion()) return;
      if (typeof element.animate !== "function") return;
      element.animate(
        [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }],
        { duration: REVEAL_MS, easing: "linear" }
      );
    }

    /**
     * 建议桥：POST 到 host 半边，按行读 NDJSON。
     *
     * 每收到一条 {type:"title"} 就立刻交给 onTitle —— 三条候选是并行生成的，
     * 这样首条不必等最慢的一条。{type:"error"} 单独记下来，不丢弃已经拿到的候选。
     * 返回 {titles, failures}。
     */
    function fetchSuggestions(sessionId, onTitle) {
      return fetch("/" + NS + "/suggest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sessionId })
      }).then(function (res) {
        if (!res.ok) {
          return res.json().then(
            function (body) { throw new Error(body && body.error ? body.error : "http " + res.status); },
            function () { throw new Error("http " + res.status); }
          );
        }
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buffer = "";
        var titles = [];
        var failures = [];

        var handle = function (line) {
          var event;
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          if (event.type === "title" && typeof event.title === "string") {
            titles.push(event.title);
            onTitle(event.title);
          } else if (event.type === "error") {
            failures.push(typeof event.message === "string" ? event.message : "suggestion failed");
          }
        };

        // 一行一个 JSON 事件；跨 chunk 的半行留在 buffer 里等下一块。
        var pump = function () {
          return reader.read().then(function (chunk) {
            if (chunk.done === true) {
              buffer += decoder.decode();
              if (buffer.trim() !== "") handle(buffer.trim());
              return { titles: titles, failures: failures };
            }
            buffer += decoder.decode(chunk.value, { stream: true });
            var index;
            while ((index = buffer.indexOf("\n")) >= 0) {
              var line = buffer.slice(0, index).trim();
              buffer = buffer.slice(index + 1);
              if (line !== "") handle(line);
            }
            return pump();
          });
        };
        return pump();
      });
    }

    /**
     * 读当前生效配置（含服务端解析出的默认值）。
     *
     * 可选 route 参数：探测**草稿里那个**模型的推理能力，用于「换模型后立刻
     * 更新推理说明」。绝不能为了这个先写 /settings —— 那会在用户点保存之前
     * 就改动生效配置，自动命名可能正好在这个窗口里用上新模型。
     */
    function fetchConfig(route) {
      return fetch("/" + NS + "/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(route === undefined ? {} : route)
      }).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok || !body || body.ok !== true) {
            throw new Error(body && body.error ? body.error : "http " + res.status);
          }
          return body.value;
        });
      });
    }

    /** 写配置。host 用 settings.update(NS, patch) 落盘，字段全 volatile 即改即生效。 */
    function saveConfig(patch) {
      return fetch("/" + NS + "/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch)
      }).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok || !body || body.ok !== true) {
            throw new Error(body && body.error ? body.error : "http " + res.status);
          }
          return body.value;
        });
      });
    }

    /** 最小快照 store：一个值 + 一组监听者。 */
    function createStore(initial) {
      var listeners = new Set();
      var current = initial;
      return {
        getSnapshot: function () { return current; },
        subscribe: function (listener) {
          listeners.add(listener);
          return function () { listeners.delete(listener); };
        },
        set: function (next) {
          if (next === current) return;
          current = next;
          listeners.forEach(function (listener) { listener(); });
        }
      };
    }

    /** 哪个会话正打开着重命名 Modal。 */
    var renameTargetStore = createStore(null);

    /**
     * 宿主已认证模型的目录（弹窗里的选择器读它）。
     *
     * ⚠️ 数据源是**独立服务 `remote.session`**（不是 `remote` 的属性），见
     * `createModelCatalog` 的注释。apply 里用 `ctx.inject(["remote.session"], …)`
     * 等它就绪；缺席时选择器只降级成「读不到目录」，其余功能照常。
     */
    var modelCatalog = createModelCatalog(undefined);

    /** 走官方通道改名：与侧栏双击标题改名同一条路。 */
    var sessionsRef = null;
    function renameSession(id, title) {
      return sessionsRef
        .using(id, { source: "workspaceOperation" }, function (ref) {
          return ref.binding.session.rename(title);
        })
        .then(function (result) {
          if (!result.ok) throw new Error(result.error ? result.error.message : "rename failed");
        });
    }

    /** 打开弹窗时现读当前标题；读不到就留空，不该影响按钮本身。 */
    function liveTitle(id) {
      try {
        var summary = sessionsRef?.list?.getSnapshot?.().byId?.[id];
        return summary ? summary.displayTitle || "" : "";
      } catch {
        return "";
      }
    }

    //#region 建议栏（Codex 式：小字 + chip + 重新生成，无分隔线）
    /**
     * 建议栏：一行小标题 + 一条建议一行 + 末尾「重新生成」。
     *
     * 原先把 Pill 排在一条 flex 行里，长标题会把行挤得参差（Pill 固定 24px 高、
     * 不省略），改成每条占满一行：宿主 ghost 按钮负责 hover/圆角，自己只管
     * 左对齐与省略号。
     */
    function SuggestionStrip(props) {
      var state = useStore(props.store);
      var status = state.status;
      var titles = state.titles ?? [];
      var labelStyle = {
        fontSize: "11px",
        lineHeight: "18px",
        color: "var(--dsw-alias-label-tertiary)"
      };
      return e(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "2px", marginTop: "8px", minWidth: 0 } },
        e(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "6px" } },
          e("span", { style: labelStyle }, t("modal.suggest")),
          // 已经有候选就先给用户点，别让「思考中」压着结果。
          status === "loading" && titles.length === 0 ? e("span", { style: labelStyle }, t("modal.loading")) : null,
          status === "error"
            ? e("span", { style: Object.assign({}, labelStyle, { color: "var(--dsw-alias-state-error-primary)" }) }, t("modal.error"))
            : null
        ),
        // 不再等 status 变成 ready：每到达一条就渲染一条（先到先显示）。
        titles.map(function (title, index) {
          return e(
            P.Button,
            {
              key: index,
              variant: "ghost",
              size: "sm",
              onClick: function () { props.onPick(title); },
              title: title,
              // 新挂载的那条从左往右擦出；已在列表里的元素不会重放（ref 只在挂载时调用一次）。
              ref: revealSuggestion,
              style: {
                justifyContent: "flex-start",
                width: "100%",
                minWidth: 0,
                padding: "0 6px"
              }
            },
            // Button 是 inline-flex，省略号要落在自己的块级子元素上才生效
            e("span", {
              style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
            }, title)
          );
        }),
        status === "ready" || status === "error"
          ? e(
              P.Button,
              {
                variant: "ghost",
                size: "sm",
                onClick: props.onRegenerate,
                style: { alignSelf: "flex-start", fontSize: "11px", height: "22px", padding: "0 6px", color: labelStyle.color }
              },
              t("modal.regenerate")
            )
          : null
      );
    }
    //#endregion

    //#region 设置面板（自绘，放在「AI 命名」弹窗里）
    /**
     * 设置区的样式。整体是**一个圆角方框**，与上方的建议栏拉开层次。
     *
     * 方框手法抄宿主官方 `dsh-client-ui-plugin-manager` 的 guide 卡片
     * （`.fO69Vq_guide`）：`border: .5px solid border-l4` + `radius-lg` + `bg-layer-1`。
     * 为什么必须带边框而不是只靠底色：**浅色主题下 bg-layer-1/2/3 全是 #fff**
     * （令牌表实测，见 dsh-client-ui-theme），填充与弹窗同色 —— 只靠底色的话
     * 方框在浅色主题里完全隐形，用户会以为「没生效」。边框在两个主题下都在。
     *
     * 字段行是「标签+提示在左、控件在右」的横排：数字框只有 76px，省下的
     * 纵向空间让 7 个字段不必翻很久；模型那两个字段例外（见 settingsRowBlock），
     * 并排放两个输入框比堆成两行矮一半。
     */
    var settingsBox = {
      marginTop: "18px",
      padding: "0 14px 14px",
      border: "0.5px solid var(--dsw-alias-border-l3)",
      borderRadius: "var(--dsw-radius-lg)",
      background: "var(--dsw-alias-bg-layer-1)",
      minWidth: 0
    };
    var settingsBoxHead = {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "12px 0 10px",
      minWidth: 0
    };
    var settingsBoxTitle = {
      flex: "1",
      minWidth: 0,
      fontSize: "13px",
      fontWeight: 500,
      lineHeight: 1.5,
      color: "var(--dsw-alias-label-primary)"
    };
    var settingsStatus = {
      flex: "none",
      fontSize: "12px",
      lineHeight: 1.5,
      color: "var(--dsw-alias-label-tertiary)"
    };
    /**
     * 一行字段。分隔线画成**上**边线而不是下边线：标题行不用再单独画一条，
     * 也不会与首行叠成双线（内联 style 拿不到官方那种 `.field + .field` 相邻选择器）。
     */
    var settingsRow = {
      display: "flex",
      alignItems: "center",
      gap: "12px",
      padding: "10px 0",
      borderTop: "0.5px solid var(--dsw-alias-border-l2)",
      minWidth: 0
    };
    /** 需要整行宽的字段（并排两个输入框）：标签与提示各占一行。 */
    var settingsRowBlock = Object.assign({}, settingsRow, { display: "block" });
    var settingsLabel = {
      fontSize: "13px",
      fontWeight: 400,
      lineHeight: 1.5,
      color: "var(--dsw-alias-label-primary)"
    };
    var settingsHint = {
      margin: 0,
      fontSize: "12px",
      lineHeight: 1.5,
      color: "var(--dsw-alias-label-tertiary)"
    };
    /** 紧凑数字框：宽度只够放 5 位数，居中 + 等宽数字，右列对齐成一条线。 */
    var settingsNumber = {
      boxSizing: "border-box",
      flex: "none",
      width: "76px",
      height: "30px",
      padding: "0 8px",
      border: "0.5px solid var(--dsw-alias-border-l4)",
      borderRadius: "var(--dsw-radius-md)",
      background: "var(--dsw-alias-bg-layer-3)",
      font: "inherit",
      fontSize: "13px",
      lineHeight: 1.5,
      color: "var(--dsw-alias-label-primary)",
      textAlign: "center",
      fontVariantNumeric: "tabular-nums"
    };
    /** 并排的文本输入框（Provider / Model），各占一半。 */
    var settingsTextInput = {
      boxSizing: "border-box",
      flex: "1",
      minWidth: 0,
      height: "30px",
      padding: "0 10px",
      border: "0.5px solid var(--dsw-alias-border-l4)",
      borderRadius: "var(--dsw-radius-md)",
      background: "var(--dsw-alias-bg-layer-3)",
      font: "inherit",
      fontSize: "12px",
      lineHeight: 1.5,
      color: "var(--dsw-alias-label-primary)"
    };
    /** 诊断行：贴在方框底部，用一条线跟配置项分开。 */
    var settingsDiag = {
      margin: "10px 0 0",
      paddingTop: "10px",
      borderTop: "0.5px solid var(--dsw-alias-border-l2)",
      fontSize: "12px",
      lineHeight: 1.5,
      color: "var(--dsw-alias-label-tertiary)"
    };

    /**
     * 设置面板：直接在弹窗里改配置，**不依赖任何宿主插槽**。
     *
     * 为什么自绘而不是注册到插件页：宿主设置页那套（plugins.item / plugins.bundle.config
     * + configForms）依赖一条我们无法验证的激活链，实测注册代码走通了但界面始终不渲染
     * （详见交接文档）。而「AI 命名」按钮所在槽位是**已验证可用**的，把设置挂在这里
     * 就不再赌宿主内部行为。读写走自己的 HTTP 桥（/config 读、/settings 写）。
     */
    function SettingsPanel(props) {
      var state = useStore(props.store);
      var reasoning = useStore(props.reasoningStore);
      // 入口挂载状态：原本住在那张从未显示的设置卡里（用户 2026-10-14 要求保留）。
      // GUI 拿不到渲染进程 console，槽位 entry 崩掉又是静默消失，所以这行必须留着。
      var header = useStore(headerStatusStore);
      // store 快照里只有 status（idle/loading/saving/saved/error），从来没有 saving 字段 ——
      // 早先读 state.saving 恒为 undefined，按钮永不禁用、永不显示「保存中…」，连点会发出多次写。
      var disabled = state.status === "saving";
      var fieldText = function (field) {
        var value = state.draft[field];
        return value === undefined || value === null ? "" : String(value);
      };
      /** 左「标签+提示」/ 右「数字框」的一行 —— 右列对齐成一条线。
       *
       * hint 里带范围：越界值发给 host 会被 schemastery 拒绝，用户看到的
       * 是「保存失败」而不是「这个字段超范围」（数字本就无 min/max/step 可摆）。 */
      var num = function (field, label, hint) {
        return e(
          "div",
          { key: field, style: settingsRow },
          e(
            "div",
            { style: { flex: "1", minWidth: 0 } },
            e("div", { style: settingsLabel }, label),
            e("p", { style: settingsHint }, hint)
          ),
          e("input", {
            type: "text",
            inputMode: "numeric",
            "aria-label": label,
            disabled: disabled,
            value: fieldText(field),
            style: settingsNumber,
            onChange: function (event) { props.onEdit(field, event.target.value); }
          })
        );
      };

      /**
       * 推理档位说明行。数据来自 /config 的 `reasoning`（宿主 resolveModelInfo
       * 的探测结果），面板打开时就有了，不需要额外请求。
       *
       * 四种状态必须分开说：能真关 / 关不掉只能退最低档 / 非推理模型 / 读不到。
       * 混成一句「已关闭推理」就是撒谎 —— 后两种情况下模型其实照旧思考。
       */
      var reasoningText = function (info) {
        if (info === null || info === undefined) return null;
        if (info.known !== true) return t("settings.reasoningUnknown");
        var efforts = Array.isArray(info.efforts) ? info.efforts : [];
        if (efforts.length === 0) return t("settings.reasoningNone");
        // 用户显式指定过档位，说的就不是「我们替你选了哪个」而是「按你说的来」。
        var requested = typeof info.requested === "string" ? info.requested : "auto";
        if (requested !== "auto") {
          return requested === info.effort
            ? t("settings.reasoningPicked") + requested
            : t("settings.reasoningFallback") + requested + " → " + String(info.effort);
        }
        if (info.off === true) return t("settings.reasoningOff");
        if (typeof info.effort === "string") return t("settings.reasoningLow") + info.effort;
        return null;
      };
      var reasoningHint = function (info) {
        if (info === null || info === undefined || info.known !== true) return null;
        var parts = [];
        var efforts = Array.isArray(info.efforts) ? info.efforts : [];
        if (efforts.length > 0) parts.push(t("settings.reasoningList") + efforts.join(" / "));
        if (typeof info.defaultEffort === "string") parts.push(t("settings.reasoningDefault") + info.defaultEffort);
        if (typeof info.maxOutputTokens === "number") parts.push(t("settings.reasoningBudget") + info.maxOutputTokens);
        return parts.length > 0 ? parts.join("；") : null;
      };
      /**
       * 档位下拉。选项只能是「自动 + 这个模型自己声明的档位」—— 有的网关对未知
       * 档位不报错、直接忽略（实测收到没声明的档位也照样思考），所以不能让用户
       * 自由输入一个看起来生效其实被丢掉的字符串。
       *
       * 换模型后草稿里可能留着上一个模型的档位：它不在新模型的 options 里，
       * 浏览器会显示空白而草稿仍是旧值。这里显示层回退成 auto —— host 侧
       * pickReasoningEffort 本来就会回退，界面不该比它更撒谎。
       */
      var effortSelect = function (info) {
        if (info === null || info === undefined || info.known !== true) return null;
        var efforts = Array.isArray(info.efforts) ? info.efforts : [];
        if (efforts.length === 0) return null;
        var wanted = typeof state.draft.reasoningEffort === "string" ? state.draft.reasoningEffort : "auto";
        var current = wanted === "auto" || efforts.indexOf(wanted) >= 0 ? wanted : "auto";
        var options = [{ id: "auto", label: t("settings.reasoningAuto") }];
        for (var i = 0; i < efforts.length; i++) options.push({ id: efforts[i], label: efforts[i] });
        return e(
          "select",
          {
            "aria-label": t("settings.reasoning"),
            disabled: disabled,
            value: current,
            style: Object.assign({}, settingsTextInput, { width: "auto", minWidth: "96px", cursor: "pointer" }),
            onChange: function (event) { props.onEdit("reasoningEffort", event.target.value); }
          },
          options.map(function (option) {
            return e("option", { key: option.id, value: option.id }, option.label);
          })
        );
      };

      return e(
        "div",
        { style: settingsBox },
        e(
          "div",
          { style: settingsBoxHead },
          e("span", { style: settingsBoxTitle }, t("settings.title")),
          // 状态就地显示在标题行：省一行高度，也离「保存」按钮最近。
          state.status === "loading" ? e("span", { style: settingsStatus }, t("modal.loading")) : null,
          state.status === "saved" ? e("span", { style: settingsStatus }, t("settings.saved")) : null,
          state.status === "error"
            ? e("span", { style: Object.assign({}, settingsStatus, { color: "var(--dsw-alias-state-error-primary)" }) }, state.message || t("modal.error"))
            : null,
          e(
            P.Button,
            { variant: "primary", size: "sm", disabled: disabled, onClick: props.onSave },
            state.status === "saving" ? t("saving") : t("save")
          )
        ),

        // 布尔项：文字在左、开关在右，与下面几行的右列对齐。
        e(
          "div",
          { style: settingsRow },
          e(
            "div",
            { style: { flex: "1", minWidth: 0 } },
            e("div", { style: settingsLabel }, t("settings.enable")),
            e("p", { style: settingsHint }, t("settings.enableHint"))
          ),
          e(P.Switch, {
            checked: state.draft.autoRenameEnabled !== false,
            label: t("settings.enable"),
            disabled: disabled,
            onChange: function (next) { props.onEdit("autoRenameEnabled", next); }
          })
        ),

        // 命名模型：两个只读框 + 图标按钮打开宿主已认证模型下拉。
        e(ModelPicker, {
          key: "model",
          catalog: props.catalog,
          provider: state.draft.provider ?? "",
          model: state.draft.model ?? "",
          disabled: disabled,
          onSelect: function (nextProvider, nextModel) {
            // 两个字段一起写：SettingsFormModel 之外这里直接进草稿，
            // 点「保存」时才落盘（与其它字段一致）。
            props.onEdit("provider", nextProvider);
            props.onEdit("model", nextModel);
          }
        }),

        // 推理档位：跟在模型选择后面，因为它描述的就是「上面这个模型」。
        reasoningText(reasoning) === null
          ? null
          : e(
              "div",
              { style: settingsRowBlock },
              e("div", { style: settingsLabel }, t("settings.reasoning")),
              e("p", { style: settingsHint }, reasoningText(reasoning)),
              reasoningHint(reasoning) === null
                ? null
                : e("p", { style: settingsHint }, reasoningHint(reasoning)),
              // 下拉只在这个模型真声明了档位时出现；非推理模型/探测失败时
              // 上面那两句已经把原因说清楚了，再放个空下拉只会让人以为坏了。
              effortSelect(reasoning) === null
                ? null
                : e(
                    "div",
                    { style: { display: "flex", gap: "8px", alignItems: "center", marginTop: "6px" } },
                    e("span", { style: settingsHint }, t("settings.reasoningPick")),
                    effortSelect(reasoning)
                  )
            ),

        num("suggestionCount", t("settings.count"), t("settings.countHint")),
        num("maxOutputTokens", t("settings.tokens"), t("settings.tokensHint")),
        num("timeoutMs", t("settings.timeout"), t("settings.timeoutHint")),
        num("targetCjkCharacters", t("settings.cjk"), t("settings.cjkHint")),

        e("p", { style: settingsDiag }, headerStatusText(t, header))
      );
    }
    //#endregion

    //#region 重命名 Modal（形态对齐 host 原生重命名窗口）
    function RenameDialog(props) {
      var target = props.target;
      var store = props.store;
      var composing = React.useRef(false);
      var draft = React.useState(target.currentTitle || "");
      var draftValue = draft[0];
      var writeDraft = draft[1];
      var renamingState = React.useState(false);
      var renaming = renamingState[0];
      var writeRenaming = renamingState[1];
      var failureState = React.useState(null);
      var failure = failureState[0];
      var writeFailure = failureState[1];
      // 设置面板：默认收起，点「设置」才展开，避免每次改名都被一堆配置项挤满。
      var settingsOpenState = React.useState(false);
      var settingsOpen = settingsOpenState[0];
      var writeSettingsOpen = settingsOpenState[1];

      var trimmed = draftValue.trim();
      var blocked = renaming || trimmed === "";

      var close = function () {
        if (renaming) return;
        props.onClose();
      };

      var confirm = function () {
        if (blocked) return;
        writeRenaming(true);
        writeFailure(null);
        props.onRename(target.sessionId, trimmed).then(
          function () { writeRenaming(false); props.onClose(); },
          function (reason) {
            writeRenaming(false);
            writeFailure(reason instanceof Error ? reason.message : String(reason));
          }
        );
      };

      return e(
        P.Modal,
        {
          open: true,
          onClose: close,
          closeLabel: t("modal.close"),
          title: t("modal.title"),
          // 这两个类名都来自我们注入的样式表：dialog 限高、content 成为滚动区。
          // 不传的话内容一高就整块溢出视口（宿主 .dialog 自己不设 max-height）。
          className: DIALOG_CLASS,
          contentClassName: DIALOG_CONTENT_CLASS,
          footer: e(
            React.Fragment,
            null,
            e(P.Button, { variant: "outline", disabled: renaming, onClick: close }, t("modal.cancel")),
            e(P.Button, { variant: "primary", disabled: blocked, onClick: confirm }, t("modal.rename"))
          )
        },
        // 设置入口：钉在标题行关闭键左边（见 SETTINGS_BUTTON_CLASS 的定位说明）。
        // 不依赖宿主插槽，配置面板就在这个弹窗里。
        e(
          "button",
          {
            type: "button",
            className: SETTINGS_BUTTON_CLASS,
            "aria-label": settingsOpen ? t("settings.hide") : t("settings.show"),
            "aria-expanded": settingsOpen,
            title: settingsOpen ? t("settings.hide") : t("settings.show"),
            onClick: function () { writeSettingsOpen(!settingsOpen); }
          },
          e(P.IconSettingsOutlineRegular, { size: 14 })
        ),
        e("input", {
          // 与 host 原生重命名窗口同款输入框样式（源自 WorkspaceBrowser.module.css
          // 的 renameInput 规则，逐条内联，因为插件的 client bundle 拿不到那份 CSS module）
          style: {
            boxSizing: "border-box",
            border: ".5px solid var(--dsw-alias-border-l4)",
            borderRadius: "var(--dsw-radius-lg)",
            width: "100%",
            height: "44px",
            color: "var(--dsw-alias-label-primary)",
            background: "0 0",
            outline: "none",
            padding: "7px 14px",
            fontSize: "14px",
            fontWeight: 400,
            lineHeight: "22px"
          },
          value: draftValue,
          "aria-label": t("modal.field"),
          "data-modal-autofocus": true,
          disabled: renaming,
          onFocus: function (event) { event.target.select(); },
          onChange: function (event) { writeDraft(event.target.value); writeFailure(null); },
          onCompositionStart: function () { composing.current = true; },
          onCompositionEnd: function () { composing.current = false; },
          onKeyDown: function (event) {
            if (event.key === "Enter" && !composing.current) {
              event.preventDefault();
              confirm();
            }
          }
        }),
        e(SuggestionStrip, {
          store: store,
          onPick: function (title) { writeDraft(title); writeFailure(null); },
          onRegenerate: function () { props.onRegenerate(target.sessionId); }
        }),
        settingsOpen
          ? e(SettingsPanel, {
              store: props.settingsStore,
              reasoningStore: props.reasoningStore,
              catalog: props.catalog,
              onEdit: props.onSettingsEdit,
              onSave: props.onSettingsSave
            })
          : null,
        failure !== null
          ? e("div", {
              role: "alert",
              style: { color: "var(--dsw-alias-state-error-primary)", marginTop: "8px", fontSize: "12px", lineHeight: "18px" }
            }, failure)
          : null
      );
    }
    //#endregion

    /**
     * 顶部按钮 + Modal 的组合体：一个 effect 生命周期，一个 store。
     *
     * 只接渲染器给的 standard props（`sessionId`），不写 inject —— 官方文档对
     * 这个槽位的最小写法就是不带 inject，可抛错的东西越少越好。当前标题在点击
     * 时现读（inject 的结果按 entry×binding 缓存，自动命名后会停在旧值）。
     */
    function HeaderAction(props) {
      var sessionId = props.sessionId;
      var target = useStore(renameTargetStore);
      var [suggestionStore] = React.useState(function () { return createStore({ status: "idle", titles: [] }); });
      var [settingsStore] = React.useState(function () {
        return createStore({ status: "idle", draft: {}, message: "" });
      });
      // 推理能力报告只读，跟草稿分开存：草稿的每次 set 都要手动带上它，
      // 混在一起迟早丢字段。
      var [reasoningStore] = React.useState(function () { return createStore(null); });

      var load = React.useCallback(function (id) {
        suggestionStore.set({ status: "loading", titles: [] });
        // 不传条数：由 host 按当前配置决定（设置里改了条数要立刻生效）
        // 每条候选到达就 push 进 store —— 先到先显示，不必等最慢的一条。
        fetchSuggestions(id, function (title) {
          var current = suggestionStore.getSnapshot();
          suggestionStore.set({ status: "loading", titles: current.titles.concat([title]) });
        }).then(
          function (result) {
            // 部分失败也保留已到达的候选：用户至少能用先拿到的那些。
            suggestionStore.set({ status: result.failures.length > 0 ? "error" : "ready", titles: result.titles });
          },
          function () { suggestionStore.set({ status: "error", titles: [] }); }
        );
      }, [suggestionStore]);

      /** 打开设置面板时拉一次当前生效配置（服务端已解析默认值，直接填草稿）。 */
      var loadSettings = React.useCallback(function () {
        settingsStore.set({ status: "loading", draft: settingsStore.getSnapshot().draft, message: "" });
        fetchConfig().then(
          function (value) {
            reasoningStore.set(value.reasoning ?? null);
            settingsStore.set({
              status: "idle",
              draft: {
                autoRenameEnabled: value.autoRenameEnabled !== false,
                suggestionCount: value.suggestionCount,
                maxOutputTokens: value.maxOutputTokens,
                timeoutMs: value.timeoutMs,
                targetCjkCharacters: value.targetCjkCharacters,
                provider: value.route ? value.route.provider : "",
                model: value.route ? value.route.model : "",
                reasoningEffort: typeof value.reasoningEffort === "string" ? value.reasoningEffort : "auto"
              },
              message: ""
            });
          },
          function (reason) {
            settingsStore.set({ status: "error", draft: {}, message: errorMessage(reason) });
          }
        );
      }, [settingsStore, reasoningStore]);

      /**
       * 编辑只改草稿，点保存才落盘。
       *
       * 换模型必须立刻重新探测：reasoning 报告（档位、生效档位、输出上限）来自
       * /config 的 modelInfo，不重拉的话整行都停留在上一个模型的值 —— 用户看到
       * 的是「换个模型，推理说明没变」，而它早就不适用了。
       */
      var editSetting = function (field, value) {
        var current = settingsStore.getSnapshot();
        var draft = Object.assign({}, current.draft);
        draft[field] = value;
        // 档位跟着模型走：新模型可能没有这一档，草稿留着它只会让界面显示一个
        // 不属于这个模型的选项。复位成 auto（有 off 就关、否则最低档）是新模型上
        // 的安全默认，保存时也不会把旧档位发出去。
        if (field === "provider" || field === "model") {
          draft.reasoningEffort = "auto";
          // 用草稿里的 route 单独探测一次：不能先写 /settings 再读 /config ——
          // 那会在用户点保存之前就改动生效配置，自动命名可能正好在这个窗口里
          // 用上新模型。所以让 /config 接受一个可选的 route 参数（见 host 侧）。
          fetchConfig({ provider: draft.provider ?? "", model: draft.model ?? "" }).then(
            function (value) { reasoningStore.set(value.reasoning ?? null); },
            function () { /* 探测失败保持原报告：known:false 会说「读不到」 */ }
          );
        }
        settingsStore.set({ status: current.status === "error" ? "idle" : current.status, draft: draft, message: "" });
      };

      var saveSettings = function () {
        var draft = settingsStore.getSnapshot().draft;
        var patch = {};
        if (typeof draft.autoRenameEnabled === "boolean") patch.autoRenameEnabled = draft.autoRenameEnabled;
        // 数字字段：只把能解析成有限数的送出去，非法草稿留在界面上让用户改。
        for (const field of ["suggestionCount", "maxOutputTokens", "timeoutMs", "targetCjkCharacters"]) {
          const parsed = Number(draft[field]);
          if (draft[field] !== "" && draft[field] !== undefined && Number.isFinite(parsed)) patch[field] = parsed;
        }
        for (const field of ["provider", "model"]) {
          if (typeof draft[field] === "string") patch[field] = draft[field].trim();
        }
        if (typeof draft.reasoningEffort === "string" && draft.reasoningEffort !== "") {
          patch.reasoningEffort = draft.reasoningEffort;
        }
        settingsStore.set({ status: "saving", draft: draft, message: "" });
        saveConfig(patch).then(
          function (value) {
            settingsStore.set({ status: "saved", draft: settingsStore.getSnapshot().draft, message: "" });
            // 「已保存」不能常驻：面板会一直开着，一行永久的状态文字既过时又占地方。
            // 一次性 timer，并且 set 前确认快照还是 saved —— 用户在这两秒内又改了
            // 东西就不能把别人的状态盖掉。
            setTimeout(function () {
              var snapshot = settingsStore.getSnapshot();
              if (snapshot.status === "saved") settingsStore.set({ status: "idle", draft: snapshot.draft, message: "" });
            }, SAVED_HINT_MS);
            // 条数改了之后，下一次拉取才生效；这里顺手把当前弹窗的建议刷新一遍。
            if (sessionId !== undefined) load(sessionId);
          },
          function (reason) {
            settingsStore.set({ status: "error", draft: draft, message: errorMessage(reason) });
          }
        );
      };

      var open = function () {
        if (sessionId === undefined) return;
        renameTargetStore.set({ sessionId: sessionId, currentTitle: liveTitle(sessionId) });
        load(sessionId);
        // 顺带把设置草稿拉好，展开面板时立刻有值，不用等。
        loadSettings();
      };

      var regenerate = function (id) { load(id); };

      // 仅供测试：本面板的三个动作都是 HeaderAction 里的闭包，模块作用域拿不到。
      // 渲染一次入口后挂到组件上，测试才能驱动「换模型」这条路径 —— 替身跑不了
      // useState 的 set → re-render 循环，但能直接调函数再观测请求体。
      HeaderAction.__testEditSetting = editSetting;
      HeaderAction.__testSaveSettings = saveSettings;
      HeaderAction.__testLoadSettings = loadSettings;

      return e(
        React.Fragment,
        null,
        e(
          "button",
          {
            type: "button",
            // 对齐同槽位 Agent Team 原生触发器：无底色、默认 tertiary，hover/focus-visible
            // 只把文字提到 primary。用原生 button 保留键盘与辅助技术语义。
            style: {
              minHeight: "28px",
              color: "var(--dsw-alias-label-tertiary)",
              cursor: sessionId === undefined ? "default" : "pointer",
              background: "transparent",
              border: "0",
              borderRadius: "6px",
              alignItems: "center",
              gap: "5px",
              padding: "3px 7px",
              fontSize: "12px",
              display: "inline-flex"
            },
            onMouseEnter: function (event) {
              if (sessionId !== undefined) event.currentTarget.style.color = "var(--dsw-alias-label-primary)";
            },
            onMouseLeave: function (event) {
              var button = event.currentTarget;
              button.style.color = button.matches(":focus-visible")
                ? "var(--dsw-alias-label-primary)"
                : "var(--dsw-alias-label-tertiary)";
            },
            onFocus: function (event) {
              if (event.currentTarget.matches(":focus-visible")) event.currentTarget.style.color = "var(--dsw-alias-label-primary)";
            },
            onBlur: function (event) {
              event.currentTarget.style.color = event.currentTarget.matches(":hover")
                ? "var(--dsw-alias-label-primary)"
                : "var(--dsw-alias-label-tertiary)";
            },
            onClick: open,
            title: t("action.aria"),
            disabled: sessionId === undefined
          },
          e(P.IconSparkleRegular, { size: 14 }),
          t("action.label")
        ),
        target !== null && target.sessionId === sessionId
          ? e(RenameDialog, {
              target: target,
              store: suggestionStore,
              settingsStore: settingsStore,
              reasoningStore: reasoningStore,
              catalog: modelCatalog,
              onSettingsEdit: editSetting,
              onSettingsSave: saveSettings,
              onClose: function () { renameTargetStore.set(null); suggestionStore.set({ status: "idle", titles: [] }); },
              onRename: renameSession,
              onRegenerate: regenerate
            })
          : null
      );
    }

    //#region 设置页
    /**
     * 走宿主官方设置表单：SettingsForm + SettingsValueField + SettingsFormModel。
     *
     * 槽位是 `plugins.bundle.config` —— **keyed 槽，key 取 bundle 包名**，渲染在
     * 该 bundle 自己的详情页里。这是第三方插件的标准做法：
     *   - `@wenaixi/dsh-ponytail`：`key: "@wenaixi/dsh-ponytail"`
     *   - 官方 `dsh-experimental-client-ui-cot-translation` / `-voice-input` 同款
     * 插件管理器从 `ledger.bundles`（= 本槽所有 key 的集合）里比对 `pkg.name`，
     * 命中才在详情页渲染配置区。
     *
     * 不要改成 `plugins.item`：那是插件页顶部「内置插件配置」区的列表条目，
     * 官方自己那四个 settings-* 页用它是为了挤在同一块「内置」区里；第三方插件
     * 走那里会混进官方区，用户实测反馈「不规范」。
     */
    var SLOT_BUNDLE_CONFIG = "plugins.bundle.config";

    /**
     * 宿主已认证模型的目录。
     *
     * 数据源是 ctx.remote.session.modelCatalog()：它按 llm.listProviders() 逐个
     * listModels，列不出来的 provider 进 failures 而不是 groups —— 所以 groups
     * 里就是「当前真能用的模型」，用户不必再手填 provider/model。
     *
     * remote 用 ctx.get 取（可选），不写进 exports.inject：写进去就成了硬依赖，
     * 部署没组合 remote 时整个 client 半边都不会激活，连顶部按钮一起丢。
     * 取不到只是退回手填两个字段。
     *
     * route 的 key 必须 JSON 编码：model id 本身可能含 "/"（如
     * nested/main），用 "/" 拼接再 split 会拆错。官方 model-selection
     * 用的是同一写法。
     */
    function routeKey(provider, model) {
      return JSON.stringify([provider, model]);
    }

    /**
     * 「跟随主模型」在选择器里的 id。用不可能与 routeKey 撞车的字符串：
     * routeKey 的产物一定是 `["provider","model"]` 形态，不含 `:` 前缀。
     */
    var FOLLOW_ID = "follow";

    /** 目录里是否确实有这条 route。 */
    function catalogHasRoute(groups, provider, model) {
      return groups.some(function (group) {
        return group.id === provider && (group.models ?? []).some(function (entry) { return entry.id === model; });
      });
    }

    /**
     * 建一个目录 store + 加载器。
     *
     * ⚠️ **`session` 是一个独立服务 `remote.session`，不是 `remote` 的属性**。
     * 宿主的 api-gateway 按 namespace 逐个注册：`remoteServiceKey(ns)` 返回
     * `` `remote.${ns}` ``（源码实证），所以每个 namespace 都是自己的可注入服务。
     * 官方所有读 modelCatalog 的插件（settings-models / settings-subagent /
     * ui-chat / ui-plan …）inject 列表里都同时写着 `"remote"` 与 `"remote.session"`。
     *
     * 早期版本只 inject `"remote"` 再读 `remote.session`，结果恒为 undefined、
     * 目录永远读不到（用户实测「读不到宿主已认证的模型」）。**别再改回去**。
     *
     * 同理 `load()` 现读 `catalog.session` 而不闭包捕获：服务可能晚于模块初始化就绪。
     */
    function createModelCatalog(session) {
      var store = createStore({ status: "idle", groups: [] });
      var loading = false;
      var catalog = {
        store: store,
        load: load,
        session: session
      };
      function load() {
        var current = catalog.session;
        if (typeof current?.modelCatalog !== "function") {
          store.set({ status: "error", groups: [] });
          return;
        }
        if (loading) return;
        loading = true;
        var snapshot = store.getSnapshot();
        store.set({ status: "loading", groups: snapshot.groups });
        Promise.resolve(current.modelCatalog()).then(
          function (response) {
            loading = false;
            if (response === null || typeof response !== "object" || response.ok !== true) {
              store.set({ status: "error", groups: [] });
              return;
            }
            store.set({ status: "ready", groups: Array.isArray(response.value.groups) ? response.value.groups : [] });
          },
          function () {
            loading = false;
            store.set({ status: "error", groups: [] });
          }
        );
      }
      return catalog;
    }

    /**
     * 命名模型选择器：两个**只读**框显示当前选择 + 一个图标按钮打开下拉。
     *
     * 为什么只读：这两个值必须与宿主已认证目录里的真实 route 一致，手填错一个字符
     * 就变成「配置半对」，要到第一次自动命名才报错。用户 2026-10-15 拍板
     * 「保留，但改成只读（显示当前选择），只能通过图标选」。
     *
     * 下拉用宿主官方 `P.Menu`：它自带锚定定位（portal 模式逃逸弹窗的 overflow 裁剪）、
     * 方向键遍历、Escape/外部点击关闭、选中项打勾。官方 model-selection 用的是它的
     * 底层 `MenuSurface` 加自绘定位，我们这里直接用 Menu —— 少写一整套定位代码。
     *
     * ⚠️ `P.Menu` 的 `children` 渲染在 `items` **之后**，所以搜索行靠 CSS `order:-1`
     * 提到最前（`.viewport` 是 flex 列，order 生效）。见 PICKER_SEARCH_CLASS。
     */
    function ModelPicker(props) {
      var catalog = useStore(props.catalog.store);
      var openState = React.useState(false);
      var open = openState[0];
      var writeOpen = openState[1];
      var queryState = React.useState("");
      var query = queryState[0];
      var writeQuery = queryState[1];
      var provider = props.provider ?? "";
      var model = props.model ?? "";
      var selected = provider === "" || model === "" ? "" : routeKey(provider, model);
      var groups = catalog.groups ?? [];

      // 选中项不在目录里（provider 换了、模型下架了）也要能显示出来，
      // 否则用户会以为配置丢了。补一条「不在当前目录」。
      var listed = catalogHasRoute(groups, provider, model);
      var stale = selected !== "" && !listed;

      // 打开时拉一次目录。`idle`（还没拉过）与 `error`（上次失败，可能是服务当时
      // 还没就绪）都重试 —— 只在 idle 时拉的话，一次早失败就永久卡在「读不到」。
      React.useEffect(function () {
        if (open && (catalog.status === "idle" || catalog.status === "error")) props.catalog.load();
      }, [open, catalog.status]);

      var lowered = query.trim().toLowerCase();
      var items = [];
      // 第一项永远是「跟随主模型」：对应两个字段都清空。
      items.push({ id: FOLLOW_ID, label: t("settings.followHint") });
      if (stale) {
        items.push({ id: routeKey(provider, model), label: provider + " / " + model + " · " + t("settings.notListed") });
      }
      var matched = 0;
      for (var index = 0; index < groups.length; index++) {
        var group = groups[index];
        var models = (group.models ?? []).filter(function (entry) {
          if (lowered === "") return true;
          // 匹配模型名与 id：目录里 name 常是简写，id 才是真 route。
          return String(entry.name ?? "").toLowerCase().includes(lowered) ||
            String(entry.id ?? "").toLowerCase().includes(lowered);
        });
        if (models.length === 0) continue;
        // provider 也命中关键词时整组都留下，方便按 provider 名搜。
        items.push({ id: "group:" + group.id, type: "label", text: group.name || group.id });
        for (var m = 0; m < models.length; m++) {
          matched++;
          items.push({ id: routeKey(group.id, models[m].id), label: models[m].name || models[m].id });
        }
      }

      var onSelect = function (id) {
        writeOpen(false);
        writeQuery("");
        if (id === FOLLOW_ID) {
          props.onSelect("", "");
          return;
        }
        if (id.indexOf("group:") === 0) return;
        var route = JSON.parse(id);
        props.onSelect(route[0], route[1]);
      };

      var trigger = e(
        "button",
        {
          type: "button",
          className: PICKER_TRIGGER_CLASS,
          "aria-label": t("settings.pickModel"),
          "aria-expanded": open,
          title: t("settings.pickModel"),
          disabled: props.disabled,
          onClick: function () { writeOpen(!open); }
        },
        e(P.IconChevronDownOutlineRegular, { size: 14 })
      );

      // 搜索行：只有目录真有大把模型时才值得占一行。
      var search = lowered === "" && groups.length < 2
        ? null
        : e(
            "div",
            { className: PICKER_SEARCH_CLASS },
            e("input", {
              type: "text",
              "aria-label": t("settings.searchModel"),
              placeholder: t("settings.searchModel"),
              value: query,
              onChange: function (event) { writeQuery(event.target.value); }
            })
          );

      return e(
        "div",
        { style: settingsRowBlock },
        e("div", { style: settingsLabel }, t("settings.model")),
        e(
          "div",
          { style: { display: "flex", gap: "8px", marginTop: "6px", minWidth: 0, alignItems: "center" } },
          e("input", {
            type: "text",
            readOnly: true,
            tabIndex: -1,
            "aria-label": t("settings.provider"),
            value: provider,
            placeholder: t("settings.provider"),
            style: Object.assign({}, settingsTextInput, { background: "transparent", cursor: "default" })
          }),
          e("input", {
            type: "text",
            readOnly: true,
            tabIndex: -1,
            "aria-label": t("settings.modelName"),
            value: model,
            placeholder: t("settings.modelName"),
            style: Object.assign({}, settingsTextInput, { background: "transparent", cursor: "default" })
          }),
          e(
            P.Menu,
            {
              open: open,
              anchor: trigger,
              items: items,
              selectedId: selected === "" ? FOLLOW_ID : selected,
              onSelect: onSelect,
              onClose: function () { writeOpen(false); writeQuery(""); },
              align: "end",
              portal: true
            },
            search,
            matched === 0 && lowered !== ""
              ? e("div", { style: Object.assign({}, settingsHint, { padding: "6px 8px" }) }, t("settings.noMatch"))
              : null
          )
        ),
        e("p", { style: Object.assign({}, settingsHint, { marginTop: "6px" }) },
          catalog.status === "error"
            ? t("settings.catalogUnavailable")
            : catalog.status === "ready"
              ? t("settings.modelHint")
              : t("settings.catalogLoading"))
      );
    }

    /**
     * 布尔字段规格：官方只给了 text/number 两种，模型本身只要求 spec 有
     * format(value)->text 与 parse(text)->{kind,value}，所以照 settingsNumberField
     * 的形状补一个，脏值比较 / 覆盖标记 / 恢复默认全部白拿。
     */
    function booleanField(field) {
      return {
        field: field,
        format: function (value) { return value === false ? "false" : "true"; },
        parse: function (text) { return { kind: "set", value: text !== "false" }; }
      };
    }

    /** 卡片编辑的字段（顺序即表单里的呈现顺序）。 */
    var FORM_SPECS = [
      booleanField("autoRenameEnabled"),
      P.settingsTextField("provider"),
      P.settingsTextField("model"),
      P.settingsNumberField("suggestionCount"),
      P.settingsNumberField("maxOutputTokens"),
      P.settingsNumberField("timeoutMs"),
      P.settingsNumberField("targetCjkCharacters")
    ];

    function formProjection(form) {
      var state = form.shell();
      for (var index = 0; index < FORM_SPECS.length; index++) {
        var field = FORM_SPECS[index].field;
        state[field] = form.field(field);
      }
      return state;
    }

    /** 官方 .field / .input 的内联等价（插件包没有 CSS module，逐条抄 fields.module.css）。 */
    var fieldRow = {
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      padding: "12px 0"
    };
    var fieldHead = { display: "flex", alignItems: "center", gap: "8px" };
    var fieldLabel = { flex: "1", minWidth: "0", fontSize: "13px", fontWeight: 500, lineHeight: 1.5, color: "var(--dsw-alias-label-primary)" };
    var fieldHint = { margin: "0", fontSize: "12px", lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary)" };
    var controlInput = {
      height: "34px",
      padding: "0 12px",
      border: "0.5px solid var(--dsw-alias-border-l4)",
      borderRadius: "var(--dsw-radius-md)",
      background: "var(--dsw-alias-bg-layer-3)",
      font: "inherit",
      fontSize: "13px",
      lineHeight: 1.5,
      color: "var(--dsw-alias-label-primary)",
      minWidth: 0
    };
    var resetButton = {
      border: "none",
      background: "none",
      padding: "0",
      font: "inherit",
      fontSize: "12px",
      lineHeight: 1.5,
      color: "var(--dsw-alias-label-secondary)",
      cursor: "pointer"
    };

    /**
     * 一行「命名模型」下拉：从宿主已认证的模型里选，替代手填 provider + model。
     *
     * 选中后同时暂存两个字段（SettingsFormModel 逐字段暂存，plan() 按插入顺序
     * 生成两条 op，所以仍是一次「保存」写两个值）。host 侧的 provider/model
     * 契约完全不变，这里只是换了录入方式。
     *
     * 分隔线：官方靠 `.field + .field` 给相邻字段画上边线，而自绘行没有那个
     * 类名，所以自己画下边线；官方字段紧跟其后时不会再叠一条。
     */
    function ModelSelectRow(props) {
      var t = props.t;
      var catalog = props.catalog;
      var provider = props.provider.text;
      var model = props.model.text;
      var selected = provider === "" || model === "" ? "" : routeKey(provider, model);
      var listed = catalogHasRoute(catalog.groups, provider, model);

      var options = [e("option", { key: "", value: "" }, t("settings.followHint"))];
      // 当前值不在目录里（provider 换了、模型下架了）也要显示出来，
      // 否则下拉会把它悄悄归零成「跟随主模型」。
      if (selected !== "" && !listed) {
        options.push(e("option", { key: "current", value: selected }, provider + " / " + model + " · " + t("settings.notListed")));
      }
      for (var groupIndex = 0; groupIndex < catalog.groups.length; groupIndex++) {
        var group = catalog.groups[groupIndex];
        options.push(
          e(
            "optgroup",
            { key: group.id, label: group.name || group.id },
            (group.models ?? []).map(function (entry) {
              var key = routeKey(group.id, entry.id);
              return e("option", { key: key, value: key, title: entry.description ?? "" }, entry.name || entry.id);
            })
          )
        );
      }

      var overridden = props.provider.overridden || props.model.overridden;
      return e(
        "div",
        { style: Object.assign({}, fieldRow, { borderBottom: "0.5px solid var(--dsw-alias-border-l2)" }) },
        e(
          "div",
          { style: fieldHead },
          e("span", { style: fieldLabel }, t("settings.model")),
          overridden
            ? e(
                "span",
                { style: { display: "inline-flex", alignItems: "center", gap: "8px" } },
                e("span", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)" } }, t("overridden")),
                e("button", {
                  type: "button",
                  style: resetButton,
                  disabled: props.disabled,
                  onClick: function () { props.onSelect(""); }
                }, t("reset"))
              )
            : null
        ),
        e("select", {
          "aria-label": t("settings.model"),
          // 按「有没有可选项」判定，比按 status 稳：idle 与 loading 都还没东西可选，
          // 而重新拉取失败但仍有旧 groups 时不该把已经能用的下拉禁掉。
          disabled: props.disabled || catalog.groups.length === 0,
          style: controlInput,
          value: selected,
          onChange: function (event) { props.onSelect(event.target.value); }
        }, options),
        e("p", { style: fieldHint }, catalog.groups.length === 0 ? t("settings.catalogLoading") : t("settings.modelHint"))
      );
    }

    /**
     * 一行「标题 + 说明 + 右侧开关」：官方没有 SettingsSwitchField，自己拼最小的一行。
     *
     * 分隔线要自己画：官方靠 `.field + .field` 给相邻字段画线，而自绘行没有
     * 那个类名，紧跟其后的官方字段也匹配不上（相邻兄弟选择器），所以不补就会
     * 少一条线、行距节奏断在这里。
     */
    function SwitchRow(props) {
      return e(
        "div",
        {
          style: Object.assign({}, fieldRow, {
            flexDirection: "row",
            alignItems: "center",
            gap: "12px",
            borderBottom: "0.5px solid var(--dsw-alias-border-l2)"
          })
        },
        e(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0, flex: "1" } },
          e("span", { style: fieldLabel }, props.label),
          e("p", { style: fieldHint }, props.hint)
        ),
        // Switch 只认 checked/onChange/label/disabled/title/className，没有 id，
        // 所以可见文字用 span、可及名称交给它的 label（写 htmlFor 会指向不存在的 id）。
        e(P.Switch, {
          checked: props.checked,
          disabled: props.disabled,
          label: props.label,
          onChange: props.onChange
        })
      );
    }

    function SettingsCard(props) {
      var t = props.t;
      var state = props.useAutoRenameCard(function (snapshot) { return snapshot; });
      // 列表里只占一行：宿主把 summary 当纯文本/行内节点渲染。
      if (props.view === "summary") return t("description");
      // 不可用/只读交给 SettingsForm 自己说（它会渲染 labels.unavailable），
      // 不要在这里 return null —— 那会让卡片变成一片空白。
      var disabled = !state.writable || state.saving;
      var catalog = props.useAutoRenameCatalog(function (snapshot) { return snapshot; });
      var header = props.useAutoRenameHeader(function (snapshot) { return snapshot; });
      React.useEffect(function () {
        if (catalog.status === "idle" || catalog.status === "error") props.reloadCatalog();
      }, [catalog.status]);
      var fieldProps = function (field, labelKey) {
        return {
          id: "plugin-config-auto-rename-" + field,
          label: t(labelKey),
          hint: t(labelKey + "Hint"),
          overriddenLabel: t("overridden"),
          resetLabel: t("reset"),
          invalidLabel: t("invalidNumber"),
          disabled: disabled,
          text: state[field].text,
          overridden: state[field].overridden,
          invalid: state[field].invalid,
          onEdit: function (text) { props.edit(field, text); },
          onReset: function () { props.resetField(field); }
        };
      };

      // 默认走下拉；只有「确实拿不到目录」才退回手填两个字段。
      // 判据不能写成 groups.length > 0：首次渲染时目录还是 idle（useEffect 还没
      // 跑），那样会先闪一下两个手填框再变成下拉 —— 正是要避免的排版抖动。
      // 拿不到目录时只换这一行的控件，其余字段不受影响。
      var catalogUnreachable = catalog.status === "error" && catalog.groups.length === 0;
      var modelRow = catalogUnreachable
        ? [
            e(P.SettingsValueField, { key: "provider", ...fieldProps("provider", "settings.provider"), placeholder: t("settings.followHint") }),
            e(P.SettingsValueField, { key: "model", ...fieldProps("model", "settings.modelName"), placeholder: t("settings.followHint") })
          ]
        : e(ModelSelectRow, {
            key: "modelSelect",
            t: t,
            catalog: catalog,
            disabled: disabled,
            provider: state.provider,
            model: state.model,
            onSelect: function (value) {
              // 空值 = 跟随主模型：两个字段一起清，host 侧契约不变
              if (value === "") {
                props.edit("provider", "");
                props.edit("model", "");
                return;
              }
              var route = JSON.parse(value);
              props.edit("provider", route[0]);
              props.edit("model", route[1]);
            }
          });

      return e(
        P.SettingsForm,
        {
          labels: {
            unavailable: t("unavailable"),
            readOnly: t("readOnly"),
            saveFailed: t("saveFailed"),
            save: t("save"),
            saving: t("saving")
          },
          state: state,
          onSave: props.save,
          onDiscard: props.discard,
          children: [
            e(SwitchRow, {
              key: "autoRenameEnabled",
              label: t("settings.enable"),
              hint: t("settings.enableHint"),
              checked: state.autoRenameEnabled.text !== "false",
              disabled: disabled,
              onChange: function (next) { props.edit("autoRenameEnabled", next ? "true" : "false"); }
            }),
            modelRow,
            e(P.SettingsValueField, { key: "suggestionCount", ...fieldProps("suggestionCount", "settings.count"), numeric: true }),
            e(P.SettingsValueField, { key: "maxOutputTokens", ...fieldProps("maxOutputTokens", "settings.tokens"), numeric: true }),
            e(P.SettingsValueField, { key: "timeoutMs", ...fieldProps("timeoutMs", "settings.timeout"), numeric: true }),
            e(P.SettingsValueField, { key: "targetCjkCharacters", ...fieldProps("targetCjkCharacters", "settings.cjk"), numeric: true }),
            e("p", { key: "headerStatus", style: fieldHint }, headerStatusText(t, header))
          ]
        }
      );
    }

    /**
     * 顶部入口的挂载状态，常驻显示在设置卡片底部（用户 2026-10-14 明确要求保留）。
     *
     * GUI 拿不到渲染进程 console，而槽位 entry 崩掉是静默消失
     * （SlotErrorBoundary → abdicate），所以「按钮到底注册上没有」必须有一条
     * 看得见的说明。
     */
    var headerStatusStore = createStore({ state: "pending", message: "" });

    function headerStatusText(t, status) {
      if (status.state === "registered") return t("settings.headerOk");
      if (status.state === "pending") return t("settings.headerIdle");
      return t("settings.headerBad") + "：" + status.message;
    }

    /**
     * 设置页（宿主插槽版）—— 注册到插件页的「内置插件配置」区。
     *
     * 之前这里一直是「注册代码走通、真实界面不渲染」，根因**不在宿主**：
     * 本函数第一行曾经是 `if (typeof ctx.inject !== "function") return;`，而 apply
     * 收到的 ctx 是 runner 的受限 facade（`dynamicCordisContext`），它的 CTX_VERBS
     * 只有 effect / on / once / provide + 6 个定时器 verb —— **根本没有 inject**，
     * 读它直接抛错。于是整段在真实环境里第一行就退出了，一个 entry 都没注册过。
     * 测试替身里 `inject` 是显式抛错的 getter，所以替身能测出这一点（见 client-smoke）。
     *
     * 取服务只能用 `ctx.get`（可选查找，不要求写进 exports.inject）；
     * slots 是硬声明的服务，直读 `ctx.slots` 可用。
     *
     * ⚠️ 不要用 `ctx.logger`：它既不在 CTX_VERBS 也不在 inject 声明里，读它同样抛错。
     * 这里失败一律静默降级 —— 卡片缺席不影响顶部入口，而顶部入口才是主入口。
     */
    function installSettingsCard(ctx) {
      ctx.effect(function () {
        // 整段兜住：卡片缺席只是少一块界面，绝不能让异常冒到 apply ——
        // 那会把整个 client 半边（含顶部主入口）一起带走。
        try {
          var configForms = typeof ctx.get === "function" ? ctx.get("configForms") : undefined;
          // 部署没组合 configForms 时只是卡片缺席，不抛错。
          if (typeof configForms?.get !== "function") return;
          if (typeof ctx.slots?.inject !== "function") return;

          // 宿主没为本插件注册 Config schema 时 get() 给空，new SettingsFormModel
          // 会抛 —— 由下面那个 catch 兜住，卡片缺席即可，不必单独判空。
          var form = new P.SettingsFormModel(configForms.get(NS), FORM_SPECS);
          var store = form.bind(function () { return formProjection(form); });
          var catalog = createModelCatalog(ctx.get("remote.session"));
          // inject 面必须是稳定对象：渲染器按 face 身份缓存，每次新建会让子组件重订阅。
          var face = {
            hooks: {
              autoRenameCard: store,
              autoRenameCatalog: catalog.store,
              autoRenameHeader: headerStatusStore
            },
            reloadCatalog: catalog.load,
            ...form.actions()
          };

          // keyed 槽：key 是 bundle 包名，插件管理器拿它去 `ledger.bundles` 里
          // 比对 pkg.name，命中才在 bundle 详情页渲染这块配置区。
          var register = function () {
            return ctx.slots.inject(SLOT_BUNDLE_CONFIG, function () {
              try {
                return ctx.slots.register(
                  { name: SLOT_BUNDLE_CONFIG, key: NS, locale: NS, inject: function () { return face; } },
                  SettingsCard
                );
              } catch (error) {
                // 槽位没被声明时只让卡片缺席，不让异常从 apply 抛出并杀掉顶部入口。
                return function () {};
              }
            });
          };

          // 生命周期协议与官方 dsh-client-ui-settings-shell / @wenaixi/dsh-ponytail
          // 一致：宿主没服务这个命名空间时整块不出现，部署里不留本插件的痕迹。
          var disposeSlot =
            typeof configForms.whileServed === "function"
              ? configForms.whileServed([NS], register)
              : register();

          return function () {
            form.dispose();
            if (typeof disposeSlot === "function") disposeSlot();
          };
        } catch (error) {
          return function () {};
        }
      }, "dsh-auto-rename: settings page");
    }
    //#endregion

    async function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: ZH, en: EN });
      }, "dsh-auto-rename: dictionaries");
      t = ctx.locale.bind(NS);

      // 弹窗自绘部分要的两条 CSS（限高 + 设置图标定位）。放在这里而不是组件里：
      // 只该插一次，且组件可能被渲染很多遍。
      installDialogStyles();

      // 宿主已认证模型目录：`remote.session` 是**独立服务**（api-gateway 按 namespace
      // 注册，见 createModelCatalog 注释），所以取的是它，不是 `remote`。
      //
      // 两步：先直接 `get` 一次（api-remotes 挂得早，通常已经就绪）；拿不到才
      // `ctx.inject` 等它。**不写进 exports.inject** —— 硬声明会让缺该 namespace 的
      // 部署 park 整个 client 半边，连顶部按钮一起丢（官方那些插件是纯设置页，
      // 丢了不显眼；我们的顶部按钮是主入口，不能赌）。
      attachModelCatalog(ctx);

      // 设置的两条入口，读同一份配置（都走插件自己的 HTTP 桥）：
      //   1. 插件页「内置插件配置」区的正式卡片（宿主槽位，主入口）
      //   2. 「AI 命名」弹窗里的齿轮（自绘，任何时候都可用，不依赖宿主槽位）
      installSettingsCard(ctx);
      installHeaderAction(ctx);
    }

    /**
     * 把 `remote.session` 接到目录上。
     *
     * ⚠️ **不能用 `ctx.inject`**：apply 收到的 ctx 是 runner 的受限 facade
     * （`dynamicCordisContext`），它是个只暴露 `get` + CTX_VERBS 的 Proxy
     * （`effect/on/once/provide/timeout/…`），**读 `ctx.inject` 会直接抛
     * `dynamic ctx does not expose "inject"`**（不是返回 undefined）。
     * 早先写成「先 get，拿不到就 ctx.inject 等它」——服务稍晚就绪时那句
     * `typeof ctx.inject` 当场抛错，目录永远接不上，用户看到「读不到宿主已认证
     * 的模型」。**别再写 ctx.inject**。
     *
     * 正确做法：`ctx.get` 是**可选查找**（facade 里唯一可用的取服务方式），
     * 服务还没挂就返回 undefined —— 所以拿不到时轮询等它，并加次数上限。
     * 到顶还没等到就放弃（选择器自己会在打开时再试一次，见 ModelPicker）。
     */
    function attachModelCatalog(ctx) {
      var attach = function () {
        var session = typeof ctx.get === "function" ? ctx.get("remote.session") : undefined;
        if (typeof session?.modelCatalog !== "function") return false;
        modelCatalog.session = session;
        modelCatalog.load();
        return true;
      };
      if (attach()) return;

      // 服务晚于本插件就绪：短轮询等它。上限约 15s（60 × 250ms），
      // 到顶就停 —— 不无限占着定时器。
      // setInterval 来自 facade 的 CTX_VERBS（真实环境一定有）；缺席时只是不轮询，
      // 不影响 apply 其余部分（选择器打开时还会再试一次）。
      if (typeof ctx.setInterval !== "function") return;
      var attempts = 0;
      var timer = ctx.setInterval(function () {
        if (attach() || ++attempts >= 60) ctx.clearInterval(timer);
      }, 250);
    }

    /**
     * 顶部入口：注册在 `创造模式` 右侧的 list 槽。
     *
     * 槽位 entry 渲染期抛错会被 SlotErrorBoundary 吞掉并静默 abdicate，而 GUI
     * 拿不到渲染进程 console —— 所以注册结果与崩溃原因写进 headerStatusStore，
     * 由设置卡片常驻显示（用户 2026-10-14 明确要求保留这行）。
     */
    function installHeaderAction(ctx) {
      sessionsRef = ctx.sessions;
      ctx.effect(function () {
        if (typeof ctx.slots?.inject !== "function") {
          headerStatusStore.set({ state: "error", message: "slots 服务不可用" });
          return;
        }
        var watch =
          typeof ctx.slots.onEntryError === "function"
            ? ctx.slots.onEntryError(function (key, entry, error) {
                if (key !== SLOT_HEADER_ACTIONS) return;
                headerStatusStore.set({ state: "error", message: errorMessage(error) });
              })
            : undefined;
        return ctx.slots.inject(SLOT_HEADER_ACTIONS, function () {
          try {
            var dispose = ctx.slots.register(
              { name: SLOT_HEADER_ACTIONS, id: NS, order: 20, locale: NS },
              HeaderAction
            );
            headerStatusStore.set({ state: "registered", message: "" });
            return function () {
              dispose();
              if (typeof watch === "function") watch();
              headerStatusStore.set({ state: "pending", message: "" });
            };
          } catch (error) {
            headerStatusStore.set({ state: "error", message: errorMessage(error) });
            return function () {};
          }
        });
      }, "dsh-auto-rename: header action");
    }

    exports.apply = apply;
    // 只声明硬性需要的服务。`configForms` 与 `remote.session` 都走 `ctx.get` 可选查找，
    // 免得部署缺任一个就把整个 client 半边（含顶部按钮）一起弄没。
    // ⚠️ 永远不要写 `ctx.inject` —— 受限 facade 上没有它，读一下就是 TypeError。
    exports.inject = ["slots", "locale", "sessions"];
    // 仅供测试：弹窗内自绘的设置面板、入口状态 store，以及读写配置的两条桥。
    // 宿主契约只用 apply/inject 两个导出。
    exports.__test = {
      SettingsPanel: SettingsPanel,
      HeaderAction: HeaderAction,
      headerStatusStore: headerStatusStore,
      fetchConfig: fetchConfig,
      saveConfig: saveConfig,
      modelCatalog: modelCatalog,
      dictionaries: { zh: ZH, en: EN }
    };
    return module.exports;
  }
});
