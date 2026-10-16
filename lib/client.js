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
      "description": "首个对话自动命名，并在重命名窗口给出 AI 建议。",
      "settings.title": "自动重命名",
      "settings.show": "设置",
      "settings.hide": "收起设置",
      "settings.saved": "已保存",
      "settings.enable": "首个对话自动命名",
      "settings.enableHint": "仅在会话首条消息发出、标题仍为空时触发一次；命名只读第一条人类消息。手动重命名后不再自动改写。",
      "settings.model": "命名模型",
      "settings.modelHint": "只列出宿主已认证、当前能用的模型；选「跟随主模型」则不额外调用小模型。",
      "settings.pickModel": "选择命名模型",
      "settings.searchModel": "搜索模型",
      "settings.noMatch": "没有匹配的模型。",
      "settings.notListed": "不在当前目录",
      "settings.catalogUnavailable": "读不到宿主已认证的模型；命名将跟随当前对话的主模型。",
      "settings.catalogLoading": "正在读取宿主已认证的模型…",
      "settings.provider": "Provider",
      "settings.providerHint": "与 Model 成对填写；留空表示跟随当前对话的主模型。",
      "settings.modelName": "Model",
      "settings.modelNameHint": "建议指定一个便宜的小模型；留空跟随主模型。",
      "settings.count": "建议条数",
      "settings.countHint": "重命名窗口一次给出几条候选。",
      "settings.tokens": "输出上限（token）",
      "settings.tokensHint": "标题很短，64 足够。",
      "settings.timeout": "超时（毫秒）",
      "settings.timeoutHint": "单次生成标题的最长等待时间。",
      "settings.cjk": "标题宽度（中文字数）",
      "settings.cjkHint": "中英文共用的唯一长度旋钮：1 个汉字 = 2 个半角单位，所以 12 等于中文 12 字、英文 24 个字符（含空格）。超出硬截断。",
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
      "description": "Names the first prompt automatically and suggests titles in the rename dialog.",
      "settings.title": "Auto rename",
      "settings.show": "Settings",
      "settings.hide": "Hide settings",
      "settings.saved": "Saved",
      "settings.enable": "Rename on first prompt",
      "settings.enableHint": "Fires once when the first message is sent and the title is still empty, from that first human message only. A manual rename pins the title.",
      "settings.model": "Naming model",
      "settings.modelHint": "Only models the Host has authenticated and can currently list are shown; “follow main model” skips the extra call.",
      "settings.pickModel": "Choose the naming model",
      "settings.searchModel": "Search models",
      "settings.noMatch": "No matching model.",
      "settings.notListed": "not in current catalog",
      "settings.catalogUnavailable": "Could not read the Host's authenticated models; naming will follow the conversation's main model.",
      "settings.catalogLoading": "Reading the Host's authenticated models…",
      "settings.provider": "Provider",
      "settings.providerHint": "Fill it together with Model; leave empty to follow the conversation's main model.",
      "settings.modelName": "Model",
      "settings.modelNameHint": "A cheap small model is recommended; leave empty to follow the main model.",
      "settings.count": "Suggestions",
      "settings.countHint": "How many candidates the rename dialog offers at once.",
      "settings.tokens": "Output limit (tokens)",
      "settings.tokensHint": "Titles are short; 64 is plenty.",
      "settings.timeout": "Timeout (ms)",
      "settings.timeoutHint": "Longest wait for one generated title.",
      "settings.cjk": "Title width (CJK characters)",
      "settings.cjkHint": "The single length knob for both scripts: one CJK character = 2 half-width units, so 12 means 12 Chinese characters or 24 Latin characters including spaces. Longer output is truncated.",
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

    /** 读当前生效配置（含服务端解析出的默认值）。 */
    function fetchConfig() {
      return fetch("/" + NS + "/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
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
      // 入口挂载状态：原本住在那张从未显示的设置卡里（用户 2026-10-14 要求保留）。
      // GUI 拿不到渲染进程 console，槽位 entry 崩掉又是静默消失，所以这行必须留着。
      var header = useStore(headerStatusStore);
      var disabled = state.saving === true;
      var fieldText = function (field) {
        var value = state.draft[field];
        return value === undefined || value === null ? "" : String(value);
      };
      /** 左「标签+提示」/ 右「数字框」的一行 —— 右列对齐成一条线。 */
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
            state.saving ? t("saving") : t("save")
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
            settingsStore.set({
              status: "idle",
              draft: {
                autoRenameEnabled: value.autoRenameEnabled !== false,
                suggestionCount: value.suggestionCount,
                maxOutputTokens: value.maxOutputTokens,
                timeoutMs: value.timeoutMs,
                targetCjkCharacters: value.targetCjkCharacters,
                provider: value.route ? value.route.provider : "",
                model: value.route ? value.route.model : ""
              },
              message: ""
            });
          },
          function (reason) {
            settingsStore.set({ status: "error", draft: {}, message: errorMessage(reason) });
          }
        );
      }, [settingsStore]);

      /** 编辑只改草稿，点保存才落盘。 */
      var editSetting = function (field, value) {
        var current = settingsStore.getSnapshot();
        var draft = Object.assign({}, current.draft);
        draft[field] = value;
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
        settingsStore.set({ status: "saving", draft: draft, message: "" });
        saveConfig(patch).then(
          function (value) {
            settingsStore.set({ status: "saved", draft: settingsStore.getSnapshot().draft, message: "" });
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
     * 槽位是 `plugins.item`（带 id/label，在插件页里作为一个可点条目），与官方
     * settings-web-search / -subagent / -agent-loop 完全一致。**不要**改回
     * `plugins.bundle.config`：那是 keyed 槽，插件管理器按 `ledger.bundles.has(pkg.name)`
     * 决定详情页里渲不渲染那块配置区，而 ledger 又来自该槽位上已注册的 key ——
     * 注册没进去就永远不渲染（实测注册代码本身是走通的，见 client-smoke）。
     */
    var SLOT_PLUGIN_ITEM = "plugins.item";

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
     * group/never-stuck），用 "/" 拼接再 split 会拆错。官方 model-selection
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
     * 设置页（宿主插槽版）—— **已停用**，保留代码仅供追溯。
     *
     * 历史：注册到 `plugins.item`（官方 settings-web-search / -subagent / -agent-loop
     * 都用它），也试过 `plugins.bundle.config`。两种写法在本机都实测过：注册代码
     * 确实走通（插桩替身里能成功 register），但真实界面始终不渲染，根因未定位。
     *
     * 现在设置改在「AI 命名」弹窗里自绘（见 SettingsPanel），那条路径只依赖**已验证
     * 可用**的顶部按钮槽位 + 我们自己的 HTTP 桥，不再赌宿主设置页的激活链。
     *
     * 不要再把 apply 接回这个函数：宿主插槽那条链一旦不满足，失败是静默的
     * （entry 不渲染、不报错），排查成本极高。
     */
    function installSettingsCard(ctx) {
      // ⚠️ 这段代码整体已停用，**不要照抄这里的 ctx.inject**：apply 收到的 ctx 是
      // runner 的受限 facade，读 `ctx.inject` 会抛错（见 attachModelCatalog 的注释）。
      // 保留原文仅为追溯历史，接回去之前先把取服务改成 ctx.get。
      if (typeof ctx.inject !== "function") return;
      ctx.inject(["configForms"], function (formCtx) {
        var configForms = formCtx.get("configForms");
        if (typeof configForms?.get !== "function") return;

        var form = new P.SettingsFormModel(configForms.get(NS), FORM_SPECS);
        var store = form.bind(function () { return formProjection(form); });
        var catalog = createModelCatalog(formCtx.get("remote.session"));
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

        formCtx.effect(function () {
          return function () { form.dispose(); };
        }, "dsh-auto-rename: settings form");

        formCtx.effect(function () {
          try {
            return formCtx.slots.inject(SLOT_PLUGIN_ITEM, function () {
              return formCtx.slots.register(
                {
                  name: SLOT_PLUGIN_ITEM,
                  id: NS,
                  order: 60,
                  // label 是 thunk：切语言时宿主会重新读，不必重新注册。
                  label: function () { return t("settings.title"); },
                  locale: NS,
                  inject: function () { return face; }
                },
                SettingsCard
              );
            });
          } catch (error) {
            // 槽位没被声明时只让卡片缺席，不让异常从 apply 抛出并杀掉顶部入口。
            if (typeof formCtx.logger?.warn === "function") formCtx.logger.warn(`${NS}: settings page unavailable — ${errorMessage(error)}`);
            return function () {};
          }
        }, "dsh-auto-rename: settings page");
      });
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

      // installSettingsCard(ctx) 已停用：设置改在「AI 命名」弹窗里自绘。
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
    // 只声明硬性需要的服务。configForms 走 ctx.inject、`remote.session` 走
    // attachModelCatalog（先 get 后 inject），免得部署缺任一个就把整个 client
    // 半边（含顶部按钮）一起弄没。
    exports.inject = ["slots", "locale", "sessions"];
    // 仅供测试：弹窗内自绘的设置面板、入口状态 store，以及读写配置的两条桥。
    // 宿主契约只用 apply/inject 两个导出。
    exports.__test = {
      SettingsPanel: SettingsPanel,
      headerStatusStore: headerStatusStore,
      fetchConfig: fetchConfig,
      saveConfig: saveConfig,
      modelCatalog: modelCatalog,
      dictionaries: { zh: ZH, en: EN }
    };
    return module.exports;
  }
});
