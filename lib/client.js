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
      "settings.provider": "Naming provider",
      "settings.providerHint": "Fill it together with Model; leave empty to follow the conversation's main model.",
      "settings.modelName": "Naming model",
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

    /** 一行「标题 + 说明 + 右侧开关」：官方没有 SettingsSwitchField，自己拼最小的一行。 */
    function SwitchRow(props) {
      return e(
        "div",
        { style: { display: "flex", alignItems: "center", gap: "12px", minWidth: 0 } },
        e(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0, flex: "1" } },
          e("span", { style: { fontSize: "13px", color: "var(--dsw-alias-label-primary)" } }, props.label),
          e("p", { style: { margin: "0", fontSize: "12px", lineHeight: "17px", color: "var(--dsw-alias-label-tertiary)" } }, props.hint)
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
            e(P.SettingsValueField, { key: "provider", ...fieldProps("provider", "settings.provider"), placeholder: t("settings.followHint") }),
            e(P.SettingsValueField, { key: "model", ...fieldProps("model", "settings.modelName"), placeholder: t("settings.followHint") }),
            e(P.SettingsValueField, { key: "suggestionCount", ...fieldProps("suggestionCount", "settings.count"), numeric: true }),
            e(P.SettingsValueField, { key: "maxOutputTokens", ...fieldProps("maxOutputTokens", "settings.tokens"), numeric: true }),
            e(P.SettingsValueField, { key: "timeoutMs", ...fieldProps("timeoutMs", "settings.timeout"), numeric: true }),
            e(P.SettingsValueField, { key: "targetWords", ...fieldProps("targetWords", "settings.words"), numeric: true }),
            e(P.SettingsValueField, { key: "targetCjkCharacters", ...fieldProps("targetCjkCharacters", "settings.cjk"), numeric: true }),
            headerError === "" ? null : e("p", { key: "headerError", role: "alert", style: { margin: "0", fontSize: "12px", color: "var(--dsw-alias-state-error-primary)" } }, t("settings.headerBad") + "：" + headerError)
          ]
        }
      );
    }

    /**
     * 顶部入口注册失败的原因。卡片是唯一可见的报错通道（GUI 拿不到渲染进程
     * console），所以只在真出错时多一行，平时不留任何调试文字。
     */
    var headerError = "";

    function installSettingsCard(ctx) {
      if (typeof ctx.configForms?.get !== "function" || typeof ctx.configForms?.whileServed !== "function") return;
      var form = new P.SettingsFormModel(ctx.configForms.get(NS), FORM_SPECS);
      var store = form.bind(function () { return formProjection(form); });
      // inject 面必须是稳定对象：渲染器按 face 身份缓存，每次新建会让子组件重订阅。
      var face = { hooks: { autoRenameCard: store }, ...form.actions() };

      ctx.effect(function () {
        return function () { form.dispose(); };
      }, "dsh-auto-rename: settings form");

      ctx.effect(function () {
        return ctx.configForms.whileServed([NS], function () {
          try {
            return ctx.slots.inject(SLOT_PLUGIN_CONFIG, function () {
              return ctx.slots.register(
                { name: SLOT_PLUGIN_CONFIG, key: NS, locale: NS, inject: function () { return face; } },
                SettingsCard
              );
            });
          } catch (error) {
            // 槽位没被声明（例如部署没组合插件页）时只让卡片缺席。
            // 不接住的话异常会从 apply 抛出，连顶部入口一起杀掉。
            if (typeof ctx.logger?.warn === "function") ctx.logger.warn(`${NS}: settings card unavailable — ${errorMessage(error)}`);
            return function () {};
          }
        });
      }, "dsh-auto-rename: settings card");
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
     * 拿不到渲染进程 console —— 所以注册失败的原因记进 headerError，由设置卡片
     * 在真出错时多显示一行（平时不留任何调试文字）。
     */
    function installHeaderAction(ctx) {
      sessionsRef = ctx.sessions;
      ctx.effect(function () {
        if (typeof ctx.slots?.inject !== "function") {
          headerError = "slots 服务不可用";
          return;
        }
        var watch =
          typeof ctx.slots.onEntryError === "function"
            ? ctx.slots.onEntryError(function (key, entry, error) {
                if (key !== SLOT_HEADER_ACTIONS) return;
                headerError = errorMessage(error);
              })
            : undefined;
        return ctx.slots.inject(SLOT_HEADER_ACTIONS, function () {
          try {
            var dispose = ctx.slots.register(
              { name: SLOT_HEADER_ACTIONS, id: NS, order: 20, locale: NS },
              HeaderAction
            );
            headerError = "";
            return function () {
              dispose();
              if (typeof watch === "function") watch();
            };
          } catch (error) {
            headerError = errorMessage(error);
            return function () {};
          }
        });
      }, "dsh-auto-rename: header action");
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale", "sessions", "configForms"];
    return module.exports;
  }
});
