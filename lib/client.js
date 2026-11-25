/**
 * Client 半边：对话页顶部的「AI 命名」按钮、自绘的重命名弹窗与设置面板。
 *
 * 三块 UI：顶部按钮（conversation.session.header.actions）、重命名弹窗
 * （含输入框、IME 守卫、建议栏与重新生成按钮）、设置面板。
 *
 * 改名通过 sessions.using 与 binding.session.rename 完成。
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
     * 通过注入带 data-plugin-css 标记的 <style> 实现内联样式做不到的事：
     * hover 态，以及把「设置」图标钉到标题行关闭键左边。同一 id 只插一次。
     */
    var DIALOG_CLASS = "dsh-auto-rename-dialog";
    var DIALOG_CONTENT_CLASS = "dsh-auto-rename-dialog-content";
    var SETTINGS_BUTTON_CLASS = "dsh-auto-rename-settings";
    var LOCK_ICON_CLASS = "dsh-auto-rename-lock";
    var LOCK_DISABLED_CLASS = "dsh-auto-rename-lock-disabled";
    var PICKER_TRIGGER_CLASS = "dsh-auto-rename-picker";
    var PICKER_SEARCH_CLASS = "dsh-auto-rename-picker-search";
    var STYLE_ID = NS + "/dialog.css";
    var DIALOG_CSS =
      // 限高：max-height:100% 相对 padding box 计算，避免内容撑破视口。
      "." + DIALOG_CLASS + "{max-height:100%}" +
      // 滚动区落在 .body（content 的最后一个子元素），不开在 .content 上：
      // content 里还有 header，在那里开滚动会挤压 header 宽度，使图标与关闭键重叠。
      // min-height:0 是 flex 子项能收缩到内容高度以下的前提。
      "." + DIALOG_CONTENT_CLASS + "{display:flex;flex-direction:column;min-height:0}" +
      "." + DIALOG_CONTENT_CLASS + ">:last-child{overflow-y:auto;min-height:0}" +
      "." + DIALOG_CLASS + ">:not(." + DIALOG_CONTENT_CLASS + "){flex:none}" +
      // 设置图标：形态对齐同一行的关闭键（28×28、圆角、无底色、hover 出底色）。
      // 标题行在 Modal 内部渲染，插件只能把按钮渲染在 body 里再钉回去。
      // 图标相对 .dialog 绝对定位，top:22px、right:50px，与关闭键同排；
      // 包含块是 .dialog，滚动 .content 时图标不跟着滚。
      "." + SETTINGS_BUTTON_CLASS + "{position:absolute;top:22px;right:50px;z-index:1;" +
      "display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;" +
      "padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;" +
      "color:var(--dsw-alias-label-secondary);cursor:pointer}" +
      "." + SETTINGS_BUTTON_CLASS + ":hover,." + SETTINGS_BUTTON_CLASS + '[aria-expanded="true"]' +
      "{background:var(--dsw-alias-interactive-bg-hover)}" +
      "." + SETTINGS_BUTTON_CLASS + ":focus-visible{outline:var(--dsw-focus-ring-width) solid " +
      "var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}" +
      // 锁图标：与设置齿轮同排、位于其左侧；未授权时变灰且不可点。
      "." + LOCK_ICON_CLASS + "{position:absolute;top:22px;right:84px;z-index:1;" +
      "display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;" +
      "padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;" +
      "color:var(--dsw-alias-label-tertiary);cursor:pointer}" +
      "." + LOCK_ICON_CLASS + ":hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);" +
      "color:var(--dsw-alias-label-primary)}" +
      "." + LOCK_ICON_CLASS + ":focus-visible{outline:var(--dsw-focus-ring-width) solid " +
      "var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px;" +
      "color:var(--dsw-alias-label-primary)}" +
      "." + LOCK_DISABLED_CLASS + "{color:var(--dsw-alias-label-tertiary);cursor:default;opacity:.5}" +
      // 顶部锁图标：与【AI 命名】按钮同色，hover/focus 时提亮。
      ".dsh-auto-rename-lock-header{color:var(--dsw-alias-label-tertiary)}" +
      ".dsh-auto-rename-lock-header:hover:not(:disabled)," +
      ".dsh-auto-rename-lock-header:focus-visible{color:var(--dsw-alias-label-primary)}" +
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
      // 搜索行：P.Menu 把 children 渲染在 items 之后，用 order:-1 提到最前；
      // 再 sticky 钉住，列表长了搜索框不会被滚走（.viewport 是 flex 列，order 生效）。
      // 背景用菜单的材质令牌，避免滚动的行从搜索框底下透出来。
      "." + PICKER_SEARCH_CLASS + "{order:-1;position:sticky;top:0;z-index:1;flex:none;" +
      "margin:2px 0 3px;background:var(--dsw-menu-surface-fill);" +
      "backdrop-filter:var(--dsw-menu-backdrop-filter)}" +
      "." + PICKER_SEARCH_CLASS + " input{box-sizing:border-box;width:100%;height:28px;padding:0 8px;" +
      "border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);" +
      "background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);" +
      "font:inherit;font-size:12px;line-height:1.5}" +
      "." + PICKER_SEARCH_CLASS + " input:focus-visible{outline:none;" +
      "border-color:var(--dsw-alias-state-business-primary)}";

    /** 注入样式表；同一 id 只插一次，没有 document 时跳过。 */
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

    /** 锁图标：内联 SVG，颜色随 currentColor，避免依赖外部图标导出。 */
    function lockGlyph() {
      return e(
        "svg",
        { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
        e("path", {
          d: "M4.5 7V5a3.5 3.5 0 0 1 7 0v2",
          stroke: "currentColor",
          "stroke-width": 1.4,
          "stroke-linecap": "round"
        }),
        e("rect", {
          x: 3,
          y: 7,
          width: 10,
          height: 7,
          rx: 1.5,
          fill: "currentColor"
        })
      );
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
      "modal.restoreFail": "恢复失败",
      "lock.title": "此会话被手动命名锁定，点此解除并恢复 AI 命名",
      "lock.disabled": "当前设置不允许解除锁定",
      "modal.loading": "思考中…",
      "modal.error": "建议获取失败",
      "description": "随对话自动刷新标题，并在重命名窗口中提供 AI 建议。",
      "settings.title": "自动重命名",
      "settings.show": "设置",
      "settings.hide": "收起设置",
      "settings.saved": "已保存",
      "settings.enable": "随对话自动刷新标题",
      "settings.enableHint": "开启后，每条新消息都会触发一次重新命名，标题仍然准确时保持不变；关闭后仅在首条消息时命名一次。手动重命名会停止自动更新。",
      "settings.allowUnlock": "允许手动解除锁定",
      "settings.allowUnlockHint": "关闭后，手动命名产生的锁图标变灰且不可点击；已锁定的会话保持锁定。",
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
      "modal.restoreFail": "Restore failed",
      "lock.title": "This session is pinned by a manual rename; unlock to restore AI naming",
      "lock.disabled": "Unlocking is disabled by the current settings",
      "modal.loading": "Thinking…",
      "modal.error": "Failed to fetch suggestion",
      "description": "Refreshes the title as the conversation grows and offers AI suggestions in the rename dialog.",
      "settings.title": "Auto rename",
      "settings.show": "Settings",
      "settings.hide": "Hide settings",
      "settings.saved": "Saved",
      "settings.enable": "Refresh title as the conversation grows",
      "settings.enableHint": "When enabled, every new message triggers a rename, and an accurate title is kept unchanged. When disabled, the session is named once from its first message. A manual rename stops automatic updates.",
      "settings.allowUnlock": "Allow manual unlock",
      "settings.allowUnlockHint": "When off, lock icons from manual renames are greyed out and cannot be clicked; already-locked sessions stay locked.",
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
     * 文案取值。apply 时用 ctx.locale.bind(NS) 切换到对应语言，
     * 在此之前回退到中文表。
     */
    var t = function (key) { return ZH[key] !== undefined ? ZH[key] : key; };

    /**
     * 订阅一个 store；subscribe 身份保持稳定，避免每次 render 重新订阅。
     *
     * useSyncExternalStore 的参数顺序是 (subscribe, getSnapshot)。
     * getSnapshot 必须返回稳定值，否则 React 判定快照不稳定，导致 entry 不渲染。
     */
    function useStore(store) {
      var subscribe = React.useMemo(function () {
        return function (listener) { return store.subscribe(listener); };
      }, [store]);
      var getSnapshot = React.useMemo(function () { return function () { return store.getSnapshot(); }; }, [store]);
      return useS(subscribe, getSnapshot);
    }

    /** 扫描线揭示时长：500ms。 */
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
     * 新到的候选从左往右擦出，形成扫描线效果。
     *
     * 用 Web Animations 在元素挂载时触发；clip-path 从右侧整段裁切到不裁切。
     * 系统要求减少动态效果、或环境不支持 animate 时直接显示。
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
     * 请求建议并按行读取 NDJSON。
     *
     * 每收到一条 {type:"title"} 立即交给 onTitle，使首条不必等最慢的一条。
     * {type:"error"} 单独记录，不丢弃已拿到的候选。返回 {titles, failures}。
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
     * 读取当前生效配置（含服务端解析出的默认值）。
     *
     * 可选 route 参数用于探测草稿中模型的推理能力。探测只读不写，
     * 不改动生效配置。
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

    /** 写配置：通过 settings.update(NS, patch) 落盘，字段为 volatile。 */
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

    /**
     * 解除当前会话标题的手动固定，回到自动命名体系。
     *
     * 成功后标题由宿主写入会话，返回新标题与来源供调用方刷新界面。
     */
    function requestTitleRestore(sessionId) {
      return fetch("/" + NS + "/refresh-title", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sessionId })
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

    // apply 收到的 ctx，供按需读取标题来源的模块级函数使用。
    var clientCtx = null;

    /**
     * 当前会话的锁定状态，顶部按钮和弹窗共用。
     *
     * locked 表示标题来源为手动改名；allowUnlock 是全局开关，
     * 关闭时锁图标变灰且不可点。读取失败一律按未锁定降级。
     */
    var lockStore = createStore({ sessionId: undefined, locked: false, allowUnlock: true });

    /** 局部更新锁状态：未给出的字段沿用当前快照。 */
    function setLock(patch) {
      lockStore.set(Object.assign({}, lockStore.getSnapshot(), patch));
    }

    /** 把配置里的解锁开关同步到锁图标。 */
    function syncUnlockConfig(config) {
      setLock({ allowUnlock: config?.allowUnlock !== false });
    }

    /**
     * 读会话最后一条标题事件的来源。
     *
     * events 是只读的冷路径，不激活会话。返回值包在 {ok, value} 信封里，
     * records 是带 event 字段的包装对象；按倒序找 session/title，
     * 其 data.source.kind 为 user 表示手动改名。
     * maxMessages 数的是消息条数而非事件数，取 50 并按需向前翻页。
     */
    function readSourceKind(ctx, sessionId) {
      var session = typeof ctx?.get === "function" ? ctx.get("remote.session") : undefined;
      if (typeof session?.events !== "function") return Promise.resolve(null);
      var pages = 3;
      var beforeSeq;
      var walk = function (index) {
        var request = { address: { kind: "session", sessionId: sessionId }, maxMessages: 50 };
        if (beforeSeq !== undefined) request.beforeSeq = beforeSeq;
        return Promise.resolve(session.events(request)).then(function (result) {
          var page = result?.ok === true ? result.value : result;
          var records = page?.records ?? [];
          for (var i = records.length - 1; i >= 0; i--) {
            var event = records[i]?.event;
            if (event?.type === "session/title") return event.data?.source?.kind ?? null;
          }
          var oldest = records[0]?.event?.seq;
          if (page?.hasMore === true && index + 1 < pages && typeof oldest === "number") {
            beforeSeq = oldest;
            return walk(index + 1);
          }
          return null;
        });
      };
      return walk(0).catch(function () { return null; });
    }

    /** 重新读取会话的锁定状态与全局解锁开关。 */
    function loadLockState(sessionId) {
      if (sessionId === undefined) {
        setLock({ sessionId: undefined, locked: false });
        return Promise.resolve();
      }
      return Promise.all([
        readSourceKind(clientCtx, sessionId),
        fetchConfig().catch(function () { return null; })
      ]).then(function (results) {
        var kind = results[0];
        var config = results[1];
        setLock({
          sessionId: sessionId,
          locked: kind === "user",
          allowUnlock: config?.allowUnlock !== false
        });
      });
    }

    /**
     * 模型目录，供弹窗里的选择器读取。
     *
     * 数据源是独立服务 remote.session，缺席时选择器降级为读不到目录。
     */
    var modelCatalog = createModelCatalog(undefined);

    /** 改名通过 sessions.using 通道完成。 */
    var sessionsRef = null;
    function renameSession(id, title) {
      return sessionsRef
        .using(id, { source: "workspaceOperation" }, function (ref) {
          return ref.binding.session.rename(title);
        })
        .then(function (result) {
          if (!result.ok) throw new Error(result.error ? result.error.message : "rename failed");
          // 手动改名会把标题来源置为 user，锁图标需立即出现；
          // 此时 sessionId 不变，loadLockState 的 effect 不会重跑，必须就地更新。
          setLock({ sessionId: id, locked: true });
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

    //#region 建议栏为小字 + chip + 重新生成，无分隔线。
    /**
     * 建议栏：一行小标题 + 一条建议一行 + 末尾「重新生成」。
     *
     * 每条建议占满一行，由 ghost 按钮负责 hover/圆角，这里只管左对齐与省略号。
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
          // 已经有候选就先展示已到达的候选，别让「思考中」压着结果。
          status === "loading" && titles.length === 0 ? e("span", { style: labelStyle }, t("modal.loading")) : null,
          status === "error"
            ? e("span", { style: Object.assign({}, labelStyle, { color: "var(--dsw-alias-state-error-primary)" }) }, t("modal.error"))
            : null
        ),
        // 每到达一条候选就渲染一条。
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
     * 设置区样式：一个圆角方框，与上方建议栏分隔。
     *
     * 浅色主题下各层底色相同，方框需带可见边框才不会隐形。
     *
     * 字段行是「标签+提示在左、控件在右」的横排；数字框宽 76px 以节省纵向空间。
     * 模型的两个字段例外（见 settingsRowBlock），并排两个输入框更矮。
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
     * 一行字段。分隔线用上边线而非下边线：标题行无需单独画线，
     * 也不会与首行叠成双线（内联样式无法使用相邻兄弟选择器）。
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
    /** 紧凑数字框：宽 76px，居中、等宽数字，右列对齐成一条线。 */
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
     * 设置面板：在弹窗内自绘，不依赖插槽。
     *
     * 读写走自己的 HTTP 桥（/config 读、/settings 写）。
     */
    function SettingsPanel(props) {
      var state = useStore(props.store);
      var reasoning = useStore(props.reasoningStore);
      // 入口挂载状态：槽位 entry 崩溃是静默的，这条状态是唯一可见信号，需常驻。
      var header = useStore(headerStatusStore);
      // 保存中状态由 status === saving 表达，保存时禁用按钮以防重复写。
      var disabled = state.status === "saving";
      var fieldText = function (field) {
        var value = state.draft[field];
        return value === undefined || value === null ? "" : String(value);
      };
      /** 左「标签+提示」/ 右「数字框」的一行，右列对齐成一条线。
       *
       * 取值范围写在 hint 里：越界值会被 schema 拒绝而显示「保存失败」，
       * 数字框本身不设 min/max/step。 */
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
       * 推理档位说明行。数据来自 /config 的 reasoning，面板打开时即有，无需额外请求。
       *
       * 四种状态分别呈现：可关闭 / 关不掉退最低档 / 非推理模型 / 读不到。
       * 后两种情况下模型仍在思考，不能与「已关闭」混为一谈。
       */
      var reasoningText = function (info) {
        if (info === null || info === undefined) return null;
        if (info.known !== true) return t("settings.reasoningUnknown");
        var efforts = Array.isArray(info.efforts) ? info.efforts : [];
        if (efforts.length === 0) return t("settings.reasoningNone");
        // 显式指定过档位，说的就不是「自动选了哪个」而是「按配置执行」。
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
       * 档位下拉，选项为「自动 + 模型声明的档位」，不提供自由输入框。
       *
       * 换模型后草稿里可能留着旧模型的档位，它不在新模型的 options 里，
       * 显示层回退成 auto，与实际生效的回退保持一致。
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

        // 允许手动解锁：关闭后锁图标变灰且不可点。
        e(
          "div",
          { style: settingsRow },
          e(
            "div",
            { style: { flex: "1", minWidth: 0 } },
            e("div", { style: settingsLabel }, t("settings.allowUnlock")),
            e("p", { style: settingsHint }, t("settings.allowUnlockHint"))
          ),
          e(P.Switch, {
            checked: state.draft.allowUnlock !== false,
            label: t("settings.allowUnlock"),
            disabled: disabled,
            onChange: function (next) { props.onEdit("allowUnlock", next); }
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
      var lock = useStore(lockStore);
      // 设置面板默认收起，点「设置」才展开。
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

      // 点锁解除手动固定：保留弹窗，把新标题回填输入框，状态由 onRestore 同步。
      var unlock = function () {
        if (renaming || !lock.allowUnlock) return;
        writeFailure(null);
        props.onRestore(target.sessionId).then(
          function (value) {
            if (typeof value?.title === "string") writeDraft(value.title);
          },
          function (reason) {
            writeFailure(t("modal.restoreFail") + "：" + (reason instanceof Error ? reason.message : String(reason)));
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
          // 这两个类名来自注入的样式表：dialog 限高、content 成为滚动区。
          // 不传的话内容变高会溢出视口。
          className: DIALOG_CLASS,
          contentClassName: DIALOG_CONTENT_CLASS,
          footer: e(
            React.Fragment,
            null,
            e(P.Button, { variant: "outline", disabled: renaming, onClick: close }, t("modal.cancel")),
            e(P.Button, { variant: "primary", disabled: blocked, onClick: confirm }, t("modal.rename"))
          )
        },
        // 锁定标记：钉在设置齿轮左边，仅当前会话被手动锁定时出现。
        lock.locked && lock.sessionId === target.sessionId
          ? e(
              "button",
              {
                type: "button",
                className: LOCK_ICON_CLASS + (lock.allowUnlock ? "" : " " + LOCK_DISABLED_CLASS),
                "aria-label": lock.allowUnlock ? t("lock.title") : t("lock.disabled"),
                title: lock.allowUnlock ? t("lock.title") : t("lock.disabled"),
                disabled: !lock.allowUnlock,
                onClick: unlock
              },
              lockGlyph()
            )
          : null,
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
          // 输入框样式逐条内联，与原生重命名窗口一致。
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
     * 顶部按钮与弹窗的组合体：一个 effect 生命周期，一组 store。
     *
     * 只接收 sessionId，不声明 inject。当前标题在点击时现读，避免使用过时缓存。
     */
    function HeaderAction(props) {
      var sessionId = props.sessionId;
      var target = useStore(renameTargetStore);
      var lock = useStore(lockStore);
      // 会话切换时读一次锁定状态；解锁后由 restore 本地即时更新，不轮询。
      React.useEffect(function () { loadLockState(sessionId); }, [sessionId]);
      var [suggestionStore] = React.useState(function () { return createStore({ status: "idle", titles: [] }); });
      var [settingsStore] = React.useState(function () {
        return createStore({ status: "idle", draft: {}, message: "" });
      });
      // 推理能力报告与草稿分开存：草稿每次 set 都需手动携带它，分开存可避免丢字段。
      var [reasoningStore] = React.useState(function () { return createStore(null); });

      var load = React.useCallback(function (id) {
        suggestionStore.set({ status: "loading", titles: [] });
        // 不传条数：由 host 按当前配置决定。
        // 每条候选到达就 push 进 store，先到先显示，不必等最慢的一条。
        fetchSuggestions(id, function (title) {
          var current = suggestionStore.getSnapshot();
          suggestionStore.set({ status: "loading", titles: current.titles.concat([title]) });
        }).then(
          function (result) {
            // 部分失败时保留已到达的候选。
            suggestionStore.set({ status: result.failures.length > 0 ? "error" : "ready", titles: result.titles });
          },
          function () { suggestionStore.set({ status: "error", titles: [] }); }
        );
      }, [suggestionStore]);

      /** 打开设置面板时拉取当前生效配置并填入草稿。 */
      var loadSettings = React.useCallback(function () {
        settingsStore.set({ status: "loading", draft: settingsStore.getSnapshot().draft, message: "" });
        fetchConfig().then(
          function (value) {
            reasoningStore.set(value.reasoning ?? null);
            settingsStore.set({
              status: "idle",
              draft: {
                autoRenameEnabled: value.autoRenameEnabled !== false,
                allowUnlock: value.allowUnlock !== false,
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
       * 换模型时重新探测推理能力，使档位、生效档位与输出上限与新模型一致。
       */
      var editSetting = function (field, value) {
        var current = settingsStore.getSnapshot();
        var draft = Object.assign({}, current.draft);
        draft[field] = value;
        // 换模型时把档位复位为 auto：新模型可能没有旧档位，
        // auto 是有 off 就关、否则取最低档的安全默认。
        if (field === "provider" || field === "model") {
          draft.reasoningEffort = "auto";
          // 用草稿里的 route 单独探测：先写 /settings 再读 /config 会在保存前
          // 改动生效配置。/config 因此接受可选的 route 参数。
          fetchConfig({ provider: draft.provider ?? "", model: draft.model ?? "" }).then(
            function (value) { reasoningStore.set(value.reasoning ?? null); },
            function () { /* 探测失败时保留原报告 */ }
          );
        }
        settingsStore.set({ status: current.status === "error" ? "idle" : current.status, draft: draft, message: "" });
      };

      var saveSettings = function () {
        var draft = settingsStore.getSnapshot().draft;
        var patch = {};
        if (typeof draft.autoRenameEnabled === "boolean") patch.autoRenameEnabled = draft.autoRenameEnabled;
        if (typeof draft.allowUnlock === "boolean") patch.allowUnlock = draft.allowUnlock;
        // 数字字段：只把能解析成有限数的送出去，非法草稿留在界面上供修改。
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
            // 「已保存」一次性显示后回到 idle：面板一直开着，常驻状态会过时。
            // 回写前确认快照仍是 saved，避免覆盖这两秒内对草稿的修改。
            setTimeout(function () {
              var snapshot = settingsStore.getSnapshot();
              if (snapshot.status === "saved") settingsStore.set({ status: "idle", draft: snapshot.draft, message: "" });
            }, SAVED_HINT_MS);
            // 条数改动在下一次拉取生效；这里刷新当前弹窗的建议。
            if (sessionId !== undefined) load(sessionId);
            // 解锁开关改动立即反映到锁图标。
            syncUnlockConfig(draft);
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
        // 预先拉好设置草稿，展开面板时即有值。
        loadSettings();
      };

      var regenerate = function (id) { load(id); };
      // 解除锁定后本地即时更新状态，避免再发一次读请求。
      var unlockSession = function (id) {
        return requestTitleRestore(id).then(function (value) {
          setLock({ sessionId: id, locked: value?.source?.kind === "user" });
          return value;
        });
      };

      // 仅供测试：面板动作是 HeaderAction 内的闭包，模块作用域拿不到，
      // 渲染一次入口后挂到组件上供测试调用。
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
            // 按钮默认 tertiary、无底色，hover/focus-visible 只提升文字颜色。
            // 用原生 button 保留键盘与辅助技术语义。
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
              onRegenerate: regenerate,
              onRestore: unlockSession
            })
          : null,
        lock.locked && lock.sessionId === sessionId
          ? e(
              "button",
              {
                type: "button",
                className: "dsh-auto-rename-lock-header",
                style: {
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  minHeight: "28px",
                  width: "28px",
                  // 用负 margin 收窄与前一个按钮的间距。
                  marginLeft: "-6px",
                  padding: 0,
                  border: "0",
                  borderRadius: "6px",
                  background: "transparent",
                  cursor: lock.allowUnlock ? "pointer" : "default",
                  opacity: lock.allowUnlock ? 1 : 0.5
                },
                "aria-label": lock.allowUnlock ? t("lock.title") : t("lock.disabled"),
                title: lock.allowUnlock ? t("lock.title") : t("lock.disabled"),
                disabled: !lock.allowUnlock,
                onClick: function () { unlockSession(sessionId); }
              },
              lockGlyph()
            )
          : null
      );
    }

    //#region 设置页
    /**
     * 设置区由表单组件渲染。
     *
     * plugins.bundle.config 是 keyed 槽，key 取包名，渲染在该包的详情页。
     */
    var SLOT_BUNDLE_CONFIG = "plugins.bundle.config";

    /**
     * 模型目录。
     *
     * 数据源是 ctx.remote.session.modelCatalog()：groups 中是当前可用的模型，
     * 列不出来的进 failures。
     *
     * remote 用 ctx.get 可选获取，不写进 exports.inject，避免成为硬依赖；
     * 取不到时退回手填两个字段。
     *
     * route key 用 JSON 编码，避免 model id 含 / 时拆分出错。
     */
    function routeKey(provider, model) {
      return JSON.stringify([provider, model]);
    }

    /**
     * 「跟随主模型」在选择器里的 id。用不可能与 routeKey 撞车的字符串：
     * routeKey 的产物一定是 `["provider","model"]` 形态，不含 `:` 前缀。
     */
    var FOLLOW_ID = "follow";

    /** 判断目录里是否有指定 route。 */
    function catalogHasRoute(groups, provider, model) {
      return groups.some(function (group) {
        return group.id === provider && (group.models ?? []).some(function (entry) { return entry.id === model; });
      });
    }

    /**
     * 创建目录 store 与加载器。
     *
     * session 是独立服务 remote.session，需单独取用。
     * load() 每次读 catalog.session 而非闭包捕获，以兼容服务晚于模块就绪。
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
     * 命名模型选择器：两个只读框显示当前选择，加一个图标按钮打开下拉。
     *
     * 只读是为了保证值与目录里的真实 route 一致，避免手填造成配置半对。
     * 修改一律走图标下拉从目录中选择。
     *
     * 下拉用 P.Menu，自带锚定定位、方向键遍历与关闭行为。
     * 下拉的 children 渲染在 items 之后，搜索行靠 CSS order:-1 提到最前
     * （.viewport 是 flex 列，order 生效）。
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

      // 选中项不在目录里（provider 换了、模型下架了）也要显示，
      // 补一条「不在当前目录」，避免被误认为配置丢失。
      var listed = catalogHasRoute(groups, provider, model);
      var stale = selected !== "" && !listed;

      // 打开时拉一次目录。idle 与 error 都重试：
      // 只在 idle 时拉的话，一次早失败会永久卡在「读不到」。
      React.useEffect(function () {
        if (open && (catalog.status === "idle" || catalog.status === "error")) props.catalog.load();
      }, [open, catalog.status]);

      var lowered = query.trim().toLowerCase();
      var items = [];
      // 第一项固定为「跟随主模型」：对应两个字段都清空。
      items.push({ id: FOLLOW_ID, label: t("settings.followHint") });
      if (stale) {
        items.push({ id: routeKey(provider, model), label: provider + " / " + model + " · " + t("settings.notListed") });
      }
      var matched = 0;
      for (var index = 0; index < groups.length; index++) {
        var group = groups[index];
        var models = (group.models ?? []).filter(function (entry) {
          if (lowered === "") return true;
          // 同时匹配模型名与 id：name 常是简写，id 是实际 route。
          return String(entry.name ?? "").toLowerCase().includes(lowered) ||
            String(entry.id ?? "").toLowerCase().includes(lowered);
        });
        if (models.length === 0) continue;
        // provider 命中关键词时整组保留，便于按 provider 名搜索。
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

      // 搜索行只在模型较多时显示。
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
     * 布尔字段 spec 提供 format(value)->text 与 parse(text)->{kind,value}。
     * 脏值比较、覆盖标记与恢复默认由表单框架处理。
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
      booleanField("allowUnlock"),
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

    /** 字段样式逐条内联，不依赖 CSS module。 */
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
     * 一行「命名模型」下拉：从目录中选择，替代手填 provider + model。
     *
     * 选中后同时暂存两个字段，一次「保存」写入两个值。
     * 自绘行自己画下边线。
     */
    function ModelSelectRow(props) {
      var t = props.t;
      var catalog = props.catalog;
      var provider = props.provider.text;
      var model = props.model.text;
      var selected = provider === "" || model === "" ? "" : routeKey(provider, model);
      var listed = catalogHasRoute(catalog.groups, provider, model);

      var options = [e("option", { key: "", value: "" }, t("settings.followHint"))];
      // 当前值不在目录里时也要显示，避免下拉把它归零成「跟随主模型」。
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
          // 按有无可选项判定而非 status：idle 与 loading 都无可选项，
          // 拉取失败但仍有旧 groups 时不禁用下拉。
          disabled: props.disabled || catalog.groups.length === 0,
          style: controlInput,
          value: selected,
          onChange: function (event) { props.onSelect(event.target.value); }
        }, options),
        e("p", { style: fieldHint }, catalog.groups.length === 0 ? t("settings.catalogLoading") : t("settings.modelHint"))
      );
    }

    /**
     * 一行「标题 + 说明 + 右侧开关」，自行拼装最小结构。
     *
     * 自绘行需自己画分隔线，相邻兄弟选择器不适用。
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
        // Switch 只接受 checked/onChange/label/disabled/title/className，没有 id，
        // 可见文字用 span，可访问名称交给它的 label。
        e(P.Switch, {
          checked: props.checked,
          disabled: props.disabled,
          label: props.label,
          onChange: props.onChange
        })
      );
    }

    /**
     * 详情页设置区的折叠卡片。
     *
     * 设置表单默认收进折叠卡片以免页面过长。
     * 形态为 button + aria-expanded + chevron 旋转。
     * 圆角用 --dsw-radius-xl；浅色主题下各层底色相同，边框必须可见。
     */
    var CARD_BODY_ID = "dsh-auto-rename-settings-card-body";
    var cardBox = {
      border: "0.5px solid var(--dsw-alias-border-l2)",
      borderRadius: "var(--dsw-radius-xl)",
      padding: "4px 16px 8px",
      minWidth: 0
    };
    var cardHead = {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "12px",
      width: "100%",
      padding: "10px 0",
      border: "none",
      background: "none",
      cursor: "pointer",
      font: "inherit",
      textAlign: "left"
    };
    var cardTitle = {
      margin: 0,
      fontSize: "14px",
      fontWeight: 500,
      lineHeight: "20px",
      color: "var(--dsw-alias-label-primary)"
    };
    var cardChevron = {
      display: "inline-flex",
      flex: "none",
      transition: "transform .16s"
    };

    function SettingsCard(props) {
      var t = props.t;
      var state = props.useAutoRenameCard(function (snapshot) { return snapshot; });
      // summary 视图只占一行。
      if (props.view === "summary") return t("description");
      // 不可用/只读状态由 SettingsForm 渲染，这里不提前返回，
      // 否则卡片会变成空白。
      var disabled = !state.writable || state.saving;
      var catalog = props.useAutoRenameCatalog(function (snapshot) { return snapshot; });
      var header = props.useAutoRenameHeader(function (snapshot) { return snapshot; });
      React.useEffect(function () {
        if (catalog.status === "idle" || catalog.status === "error") props.reloadCatalog();
      }, [catalog.status]);
      // 折叠状态默认收起：详情页的 README 已经很长。
      var openState = React.useState(false);
      var open = openState[0];
      var writeOpen = openState[1];
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

      // 默认走下拉，只有确实拿不到目录才退回手填两个字段。
      // 判据不能只看 groups.length > 0：首次渲染目录还是 idle（useEffect 未运行），
      // 那样会先闪一下手填框再变成下拉。
      // 拿不到目录时只换这一行的控件。
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

      // 折叠态不渲染 SettingsForm：表单的脏值暂存在 SettingsFormModel 中，
      // 组件卸载不丢，重开即恢复。
      return e(
        "section",
        { style: cardBox },
        e(
          "button",
          {
            type: "button",
            style: cardHead,
            "aria-expanded": open,
            "aria-controls": CARD_BODY_ID,
            title: open ? t("settings.hide") : t("settings.show"),
            onClick: function () { writeOpen(function (prev) { return !prev; }); }
          },
          e("span", { style: cardTitle }, t("settings.title")),
          e(
            "span",
            { style: Object.assign({}, cardChevron, { transform: open ? "rotate(180deg)" : "none" }), "aria-hidden": true },
            e(P.IconChevronDownOutlineRegular, { size: 14 })
          )
        ),
        open
          ? e(
              "div",
              { id: CARD_BODY_ID },
              e(
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
                    e(SwitchRow, {
                      key: "allowUnlock",
                      label: t("settings.allowUnlock"),
                      hint: t("settings.allowUnlockHint"),
                      checked: state.allowUnlock.text !== "false",
                      disabled: disabled,
                      onChange: function (next) { props.edit("allowUnlock", next ? "true" : "false"); }
                    }),
                    modelRow,
                    e(P.SettingsValueField, { key: "suggestionCount", ...fieldProps("suggestionCount", "settings.count"), numeric: true }),
                    e(P.SettingsValueField, { key: "maxOutputTokens", ...fieldProps("maxOutputTokens", "settings.tokens"), numeric: true }),
                    e(P.SettingsValueField, { key: "timeoutMs", ...fieldProps("timeoutMs", "settings.timeout"), numeric: true }),
                    e(P.SettingsValueField, { key: "targetCjkCharacters", ...fieldProps("targetCjkCharacters", "settings.cjk"), numeric: true }),
                    e("p", { key: "headerStatus", style: fieldHint }, headerStatusText(t, header))
                  ]
                }
              )
            )
          : null
      );
    }

    /**
     * 顶部入口的挂载状态，常驻显示在设置卡片底部。
     *
     * 槽位注册失败是静默的（entry 渲染期异常会被宿主错误边界吞掉），
     * 这行状态是唯一可见的注册结果信号。
     */
    var headerStatusStore = createStore({ state: "pending", message: "" });

    function headerStatusText(t, status) {
      if (status.state === "registered") return t("settings.headerOk");
      if (status.state === "pending") return t("settings.headerIdle");
      return t("settings.headerBad") + "：" + status.message;
    }

    /**
     * 设置页：注册到插件页的「内置插件配置」区。
     *
     * 取服务用 ctx.get 可选查找，ctx.slots 可直接读取；失败时静默降级。
     */
    function installSettingsCard(ctx) {
      ctx.effect(function () {
        // 整段兜住异常：卡片缺席只是少一块界面，
        // 不应让异常冒到 apply 而影响其余入口。
        try {
          var configForms = typeof ctx.get === "function" ? ctx.get("configForms") : undefined;
          // 没有 configForms 时卡片缺席，不抛错。
          if (typeof configForms?.get !== "function") return;
          if (typeof ctx.slots?.inject !== "function") return;

          // 没有 Config schema 时 get() 返回空，new SettingsFormModel 会抛，
          // 由下方 catch 兜住，卡片缺席即可。
          var form = new P.SettingsFormModel(configForms.get(NS), FORM_SPECS);
          var store = form.bind(function () { return formProjection(form); });
          var catalog = createModelCatalog(ctx.get("remote.session"));
          var actions = form.actions();
          var baseSave = actions.save;
          // 保存成功后同步锁图标的解锁开关，使详情页改动即时反映到顶部与弹窗。
          actions.save = function () {
            return Promise.resolve(baseSave ? baseSave() : undefined).then(function (result) {
              fetchConfig().then(syncUnlockConfig).catch(function () {});
              return result;
            });
          };
          // inject 面保持为稳定对象：渲染器按身份缓存，每次新建会让子组件重订阅。
          var face = {
            hooks: {
              autoRenameCard: store,
              autoRenameCatalog: catalog.store,
              autoRenameHeader: headerStatusStore
            },
            reloadCatalog: catalog.load,
            ...actions
          };

          // keyed 槽：key 是包名，与 pkg.name 匹配后才在详情页渲染配置区。
          var register = function () {
            return ctx.slots.inject(SLOT_BUNDLE_CONFIG, function () {
              try {
                return ctx.slots.register(
                  { name: SLOT_BUNDLE_CONFIG, key: NS, locale: NS, inject: function () { return face; } },
                  SettingsCard
                );
              } catch (error) {
                // 槽位未声明时只让卡片缺席，不让异常影响顶部入口。
                return function () {};
              }
            });
          };

          // 未服务本命名空间时整块不渲染。
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
      clientCtx = ctx;
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: ZH, en: EN });
      }, "dsh-auto-rename: dictionaries");
      t = ctx.locale.bind(NS);

      // 弹窗自绘所需的 CSS（限高 + 设置图标定位）在这里插入：
      // 只插一次，而组件可能被渲染多遍。
      installDialogStyles();

      // 模型目录：数据源是独立服务 remote.session。
      //
      // configForms/remote.session 不写进 exports.inject，避免缺依赖时 client 半边停摆。
      attachModelCatalog(ctx);

      // 两条设置入口读同一份配置（都走插件自己的 HTTP 桥）：
      //   1. 插件页「内置插件配置」区的卡片（槽位，主入口）
      //   2. 「AI 命名」弹窗里的齿轮（自绘，不依赖插槽）
      installSettingsCard(ctx);
      installHeaderAction(ctx);
    }

    /**
     * 把 remote.session 接到目录上。
     *
     * 取服务用可选查找 ctx.get，拿不到时轮询等待并设次数上限。
     * 到顶仍未就绪就放弃（选择器打开时再试一次，见 ModelPicker）。
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

      // 服务可能晚于本插件就绪：短轮询等待，上限约 15s（60 × 250ms）后停止。
      // setInterval 缺席时不轮询，不影响 apply 其余部分（选择器打开时还会再试）。
      if (typeof ctx.setInterval !== "function") return;
      var attempts = 0;
      var timer = ctx.setInterval(function () {
        if (attach() || ++attempts >= 60) ctx.clearInterval(timer);
      }, 250);
    }

    /**
     * 顶部入口：注册在会话页头部的 list 槽。
     *
     * 槽位 entry 渲染期抛错会被静默吞掉，因此把注册结果与错误原因写入
     * headerStatusStore，由设置卡片常驻显示。
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
    // 只声明必需的服务。configForms 与 remote.session 走 ctx.get 可选查找，
    // 避免缺任一个就影响整个 client 半边。
    exports.inject = ["slots", "locale", "sessions"];
    // 仅供测试：自绘的设置面板、入口状态 store 与读写配置的两条桥。
    // 运行时契约只使用 apply/inject 两个导出。
    exports.__test = {
      SettingsPanel: SettingsPanel,
      HeaderAction: HeaderAction,
      headerStatusStore: headerStatusStore,
      fetchConfig: fetchConfig,
      saveConfig: saveConfig,
      requestTitleRestore: requestTitleRestore,
      readSourceKind: readSourceKind,
      loadLockState: loadLockState,
      lockStore: lockStore,
      modelCatalog: modelCatalog,
      dictionaries: { zh: ZH, en: EN }
    };
    return module.exports;
  }
});
