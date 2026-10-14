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
      "settings.enable": "首个对话自动命名",
      "settings.enableHint": "仅在会话首条消息发出、标题仍为空时触发一次；命名只读第一条人类消息。手动重命名后不再自动改写。",
      "settings.model": "命名模型",
      "settings.modelHint": "只列出宿主已认证、当前能用的模型；选「跟随主模型」则不额外调用小模型。",
      "settings.notListed": "不在当前目录",
      "settings.catalogLoading": "正在读取宿主已认证的模型…",
      "settings.provider": "命名 Provider",
      "settings.providerHint": "与 Model 成对填写；留空表示跟随当前对话的主模型。",
      "settings.modelName": "命名 Model",
      "settings.modelNameHint": "建议指定一个便宜的小模型；留空跟随主模型。",
      "settings.count": "建议条数",
      "settings.countHint": "重命名窗口一次给出几条候选。",
      "settings.tokens": "输出上限（token）",
      "settings.tokensHint": "标题很短，64 足够。",
      "settings.timeout": "超时（毫秒）",
      "settings.timeoutHint": "单次生成标题的最长等待时间。",
      "settings.words": "目标词数",
      "settings.wordsHint": "非中文标题的目标长度。",
      "settings.cjk": "中文字数上限",
      "settings.cjkHint": "中文标题最多几个字；超出会被硬截断。",
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
      "settings.enable": "Rename on first prompt",
      "settings.enableHint": "Fires once when the first message is sent and the title is still empty, from that first human message only. A manual rename pins the title.",
      "settings.model": "Naming model",
      "settings.modelHint": "Only models the Host has authenticated and can currently list are shown; “follow main model” skips the extra call.",
      "settings.notListed": "not in current catalog",
      "settings.catalogLoading": "Reading the Host's authenticated models…",
      "settings.provider": "Naming provider",
      "settings.providerHint": "Fill it together with Model; leave empty to follow the conversation's main model.",
      "settings.modelName": "Naming model id",
      "settings.modelNameHint": "A cheap small model is recommended; leave empty to follow the main model.",
      "settings.count": "Suggestions",
      "settings.countHint": "How many candidates the rename dialog offers at once.",
      "settings.tokens": "Output limit (tokens)",
      "settings.tokensHint": "Titles are short; 64 is plenty.",
      "settings.timeout": "Timeout (ms)",
      "settings.timeoutHint": "Longest wait for one generated title.",
      "settings.words": "Target words",
      "settings.wordsHint": "Target length for non-CJK titles.",
      "settings.cjk": "Max CJK characters",
      "settings.cjkHint": "Hard cap for CJK titles; longer output is truncated.",
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

    /** 建议桥：POST 到 host 半边，解 {ok, value} 信封，失败时把 message 带给 UI。 */
    function fetchSuggestions(sessionId) {
      return fetch("/" + NS + "/suggest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sessionId })
      }).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok || !body || body.ok !== true) {
            throw new Error(body && body.error ? body.error : "http " + res.status);
          }
          var titles = body.value && Array.isArray(body.value.titles) ? body.value.titles : [];
          return titles;
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
          status === "loading" ? e("span", { style: labelStyle }, t("modal.loading")) : null,
          status === "error"
            ? e("span", { style: Object.assign({}, labelStyle, { color: "var(--dsw-alias-state-error-primary)" }) }, t("modal.error"))
            : null
        ),
        status === "ready"
          ? state.titles.map(function (title, index) {
              return e(
                P.Button,
                {
                  key: index,
                  variant: "ghost",
                  size: "sm",
                  onClick: function () { props.onPick(title); },
                  title: title,
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
            })
          : null,
        status === "ready" || status === "error"
          ? e(
              P.Button,
              {
                variant: "ghost",
                size: "sm",
                onClick: props.onRegenerate,
                style: { alignSelf: "flex-start", fontSize: "11px", height: "22px", padding: "0 6px" }
              },
              t("modal.regenerate")
            )
          : null
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
          footer: e(
            React.Fragment,
            null,
            e(P.Button, { variant: "outline", disabled: renaming, onClick: close }, t("modal.cancel")),
            e(P.Button, { variant: "primary", disabled: blocked, onClick: confirm }, t("modal.rename"))
          )
        },
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

      var load = React.useCallback(function (id) {
        suggestionStore.set({ status: "loading", titles: [] });
        // 不传条数：由 host 按当前配置决定（设置里改了条数要立刻生效）
        fetchSuggestions(id).then(
          function (titles) { suggestionStore.set({ status: "ready", titles: titles }); },
          function () { suggestionStore.set({ status: "error", titles: [] }); }
        );
      }, [suggestionStore]);

      var open = function () {
        if (sessionId === undefined) return;
        renameTargetStore.set({ sessionId: sessionId, currentTitle: liveTitle(sessionId) });
        load(sessionId);
      };

      var regenerate = function (id) { load(id); };

      return e(
        React.Fragment,
        null,
        e(
          P.Button,
          {
            // 形态对齐同槽位的原生入口（「智能体团队」的触发器、「创造模式」的标签）：
            // 无边框、透明底、悬停才填充、图标 14 + 小字文字。这套由宿主 Button 的
            // ghost 变体 + sm 尺寸提供，插件包没有 CSS module，所以一律走宿主原语，
            // 不自绘 hover/焦点/disabled —— 自绘会把宿主的悬停态盖掉。
            // 不写 aria-label：可见文字就是它的名字（写了反而盖掉它）。
            variant: "ghost",
            size: "sm",
            icon: e(P.IconSparkleRegular, { size: 14 }),
            onClick: open,
            title: t("action.aria"),
            disabled: sessionId === undefined
          },
          t("action.label")
        ),
        target !== null && target.sessionId === sessionId
          ? e(RenameDialog, {
              target: target,
              store: suggestionStore,
              onClose: function () { renameTargetStore.set(null); suggestionStore.set({ status: "idle", titles: [] }); },
              onRename: renameSession,
              onRegenerate: regenerate
            })
          : null
      );
    }

    //#region 设置卡片
    /**
     * 走宿主官方设置表单：SettingsForm + SettingsValueField + SettingsFormModel。
     *
     * 之前整张卡是自绘 inline style，且注册在 settings.plugin.item —— 那个槽位
     * 在当前宿主的 app.asar 里一个文件都没有（全量扫过），slots.inject 于是
     * 永不触发，卡片其实从未渲染过。现行槽位是 plugins.bundle.config（按包名
     * keyed，挂在插件详情页），dsh-context / dsh-univer-office / dsh-ponytail
     * 用的都是它。改用官方原语后排版与宿主其它设置页天然一致，也不用自己维持。
     */
    var SLOT_PLUGIN_CONFIG = "plugins.bundle.config";

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

    /** 目录里是否确实有这条 route。 */
    function catalogHasRoute(groups, provider, model) {
      return groups.some(function (group) {
        return group.id === provider && (group.models ?? []).some(function (entry) { return entry.id === model; });
      });
    }

    /** 建一个目录 store + 加载器；remote 由 ctx.inject 交来，可能为 undefined。 */
    function createModelCatalog(remote) {
      var store = createStore({ status: "idle", groups: [] });
      var loading = false;
      function load() {
        if (typeof remote?.session?.modelCatalog !== "function") {
          store.set({ status: "error", groups: [] });
          return;
        }
        if (loading) return;
        loading = true;
        var current = store.getSnapshot();
        store.set({ status: "loading", groups: current.groups });
        Promise.resolve(remote.session.modelCatalog()).then(
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
      return { store: store, load: load };
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
      P.settingsNumberField("targetWords"),
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
            e(P.SettingsValueField, { key: "targetWords", ...fieldProps("targetWords", "settings.words"), numeric: true }),
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
     * 设置卡片。
     *
     * configForms 与 remote 都走 ctx.inject 延迟取（与 dsh-mcp-connector /
     * dsh-univer-office 一致），不写进 exports.inject：那是硬依赖，部署没组合
     * settings 或 remote 时整个 client 半边都不会激活，连顶部按钮一起丢。
     * 延迟注入既等到服务就绪，又允许它永远不来（那一块界面缺席而已）。
     */
    function installSettingsCard(ctx) {
      if (typeof ctx.inject !== "function") return;
      ctx.inject(["configForms", "remote"], function (formCtx) {
        var configForms = formCtx.configForms;
        if (typeof configForms?.get !== "function" || typeof configForms?.whileServed !== "function") return;

        var form = new P.SettingsFormModel(configForms.get(NS), FORM_SPECS);
        var store = form.bind(function () { return formProjection(form); });
        var catalog = createModelCatalog(formCtx.remote);
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
          return configForms.whileServed([NS], function () {
            try {
              return formCtx.slots.inject(SLOT_PLUGIN_CONFIG, function () {
                return formCtx.slots.register(
                  { name: SLOT_PLUGIN_CONFIG, key: NS, locale: NS, inject: function () { return face; } },
                  SettingsCard
                );
              });
            } catch (error) {
              // 槽位没被声明（例如部署没组合插件页）时只让卡片缺席。
              // 不接住的话异常会从 apply 抛出，连顶部入口一起杀掉。
              if (typeof formCtx.logger?.warn === "function") formCtx.logger.warn(`${NS}: settings card unavailable — ${errorMessage(error)}`);
              return function () {};
            }
          });
        }, "dsh-auto-rename: settings card");
      });
    }
    //#endregion

    async function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: ZH, en: EN });
      }, "dsh-auto-rename: dictionaries");
      t = ctx.locale.bind(NS);

      installSettingsCard(ctx);
      installHeaderAction(ctx);
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
    // 只声明硬性需要的服务。configForms 走 ctx.inject、remote 走 ctx.get，
    // 免得部署缺任一个就把整个 client 半边（含顶部按钮）一起弄没。
    exports.inject = ["slots", "locale", "sessions"];
    return module.exports;
  }
});
