/**
 * dsh-auto-rename —— Client 半边。
 *
 * 三块 UI：
 *  1. 对话页顶部 `创造模式` 右侧的「AI 命名」按钮（conversation.session.header.actions）。
 *  2. 自绘的重命名 Modal：形态对齐 host 原生重命名窗口（同款 Modal、同款
 *     title / input / IME 守卫 / Enter 确认 / 取消与重命名 footer），
 *     输入框下方一条 Codex 式小字建议栏：3 个可点击 chip + 重新生成。
 *  3. 设置卡片（settings.plugin.item）：命名模型、条数、token 上限等。
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
      "modal.empty": "暂无建议",
      "modal.error": "建议获取失败",
      "modal.hint": "点击建议可直接填入；也可手动修改后重命名。",
      "modal.noSession": "没有打开的会话",
      "settings.title": "自动重命名",
      "settings.enable": "首个对话自动命名",
      "settings.enableHint": "仅在会话的首条消息发出、标题仍为空时触发一次（与 Codex 一致）。手动重命名后不再自动改写。",
      "settings.model": "命名模型",
      "settings.modelHint": "留空表示跟随当前对话的主模型。建议指定一个便宜的小模型。",
      "settings.provider": "Provider",
      "settings.modelName": "Model",
      "settings.followHint": "跟随对话主模型",
      "settings.count": "建议条数",
      "settings.tokens": "输出上限",
      "settings.timeout": "超时（毫秒）",
      "settings.words": "目标词数",
      "settings.cjk": "目标中文字数",
      "settings.saved": "已保存",
      "state.loading": "读取中…",
      "state.readOnly": "本部署的设置为只读。",
      "error.rejected": "本部署没有接受这次修改，值已保留供你核对。"
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
      "modal.empty": "No suggestion",
      "modal.error": "Failed to fetch suggestion",
      "modal.hint": "Click a suggestion to fill it in, or edit manually before renaming.",
      "modal.noSession": "No open session",
      "settings.title": "Auto rename",
      "settings.enable": "Rename on first prompt",
      "settings.enableHint": "Fires once when the first message is sent and the title is still empty (same as Codex). A manual rename pins the title.",
      "settings.model": "Naming model",
      "settings.modelHint": "Leave empty to follow the conversation's main model. A cheap small model is recommended.",
      "settings.provider": "Provider",
      "settings.modelName": "Model",
      "settings.followHint": "Follow conversation model",
      "settings.count": "Suggestions",
      "settings.tokens": "Output limit",
      "settings.timeout": "Timeout (ms)",
      "settings.words": "Target words",
      "settings.cjk": "Target CJK chars",
      "settings.saved": "Saved",
      "state.loading": "Loading…",
      "state.readOnly": "This deployment stores settings read-only.",
      "error.rejected": "This deployment did not accept the change; your value was kept for review."
    };

    /**
     * 文案取值。apply 时经 ctx.locale.bind(NS) 换成宿主语言版本；
     * 在那之前（组件定义阶段不会用到）回退到中文表。
     */
    var t = function (key) { return ZH[key] !== undefined ? ZH[key] : key; };

    /** 订阅一个 store，subscribe 身份稳定（避免每次 render 重新订阅）。 */
    function useStore(store) {
      var subscribe = React.useMemo(function () {
        return function (listener) { return store.subscribe(listener); };
      }, [store]);
      var getSnapshot = React.useMemo(function () { return function () { return store.getSnapshot(); }; }, [store]);
      return useS(getSnapshot, subscribe);
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

    //#region 建议栏（Codex 式：小字 + chip + 重新生成，无分隔线）
    function SuggestionStrip(props) {
      var state = useStore(props.store);
      var status = state.status;
      return e(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "6px",
            marginTop: "8px",
            fontSize: "11px",
            color: "var(--dsw-alias-label-tertiary)"
          }
        },
        e("span", null, t("modal.suggest")),
        status === "loading"
          ? e("span", { style: { color: "var(--dsw-alias-label-tertiary)" } }, t("modal.loading"))
          : null,
        status === "error"
          ? e("span", { style: { color: "var(--dsw-alias-state-error-primary)" } }, t("modal.error"))
          : null,
        status === "ready"
          ? state.titles.map(function (title, index) {
              return e(
                P.Pill,
                {
                  key: index,
                  onClick: function () { props.onPick(title); },
                  title: title
                },
                title
              );
            })
          : null,
        status === "ready" || status === "error"
          ? e(
              "button",
              {
                type: "button",
                onClick: props.onRegenerate,
                style: {
                  background: "none",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  font: "inherit",
                  color: "var(--dsw-alias-label-secondary)"
                }
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

    /** 顶部按钮 + Modal 的组合体：一个 effect 生命周期，一个 store。 */
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
        renameTargetStore.set({ sessionId: sessionId, currentTitle: props.currentTitle || "" });
        load(sessionId);
      };

      var regenerate = function (id) { load(id); };

      return e(
        React.Fragment,
        null,
        e(
          P.Button,
          {
            variant: "outline",
            size: "sm",
            onClick: open,
            "aria-label": t("action.aria"),
            disabled: sessionId === undefined
          },
          t("action.label")
        ),
        target !== null && target.sessionId === sessionId
          ? e(RenameDialog, {
              target: target,
              store: suggestionStore,
              onClose: function () { renameTargetStore.set(null); suggestionStore.set({ status: "idle", titles: [] }); },
              onRename: props.onRename,
              onRegenerate: regenerate
            })
          : null
      );
    }

    //#region 设置卡片
    /** ponytail 同款排版：一行一控件，不自创视觉。 */
    var row = {
      display: "flex",
      alignItems: "center",
      gap: "12px",
      padding: "8px 10px",
      borderRadius: "var(--dsw-radius-sm, 6px)",
      backgroundColor: "var(--dsw-alias-bg-layer-1)"
    };
    var rowText = { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0, flex: 1 };
    var rowName = { fontSize: "13px", color: "var(--dsw-alias-label-primary)" };
    var rowHint = { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)", lineHeight: 1.4 };
    var controlStyle = {
      font: "inherit",
      color: "var(--dsw-alias-label-primary)",
      background: "var(--dsw-alias-bg-base)",
      border: "1px solid var(--dsw-alias-border-l2)",
      borderRadius: "var(--dsw-radius-sm, 6px)",
      padding: "4px 8px"
    };

    /**
     * 本地草稿 + 失焦提交：不每敲一个字符就写盘。
     *
     * key 绑在「服务端值」上：写入成功后宿主回显新值，key 变化即重挂载，
     * 草稿随之对齐真值。输入过程中服务端值不变，因此不会打断打字。
     */
    function NumberControl(props) {
      var state = React.useState(props.value === undefined ? "" : String(props.value));
      return e("input", {
        key: String(props.value),
        type: "number",
        value: state[0],
        disabled: props.disabled,
        onChange: function (event) { state[1](event.target.value); },
        onBlur: function () { props.onCommit(state[0].trim()); },
        style: Object.assign({ width: "100px" }, controlStyle)
      });
    }

    function TextControl(props) {
      var state = React.useState(props.value === undefined ? "" : String(props.value));
      return e("input", {
        key: String(props.value),
        type: "text",
        value: state[0],
        placeholder: props.placeholder,
        disabled: props.disabled,
        onChange: function (event) { state[1](event.target.value); },
        onBlur: function () { props.onCommit(state[0].trim()); },
        style: Object.assign({ width: "200px" }, controlStyle)
      });
    }

    /** 一个带小标题的字段组。 */
    function Field(props) {
      return e("div", { style: { display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 } },
        e("span", { style: rowHint }, props.label),
        props.children
      );
    }

    function SettingsPanel(props) {
      var scope = props.scope;
      var subscribe = React.useMemo(function () {
        return function (listener) { return scope.subscribe(listener); };
      }, [scope]);
      var getSnapshot = React.useMemo(function () { return function () { return scope.getSnapshot(); }; }, [scope]);
      var snapshot = useS(getSnapshot, subscribe);
      // 设置只在宿主服务就绪后才有意义；未就绪时整卡不渲染。
      if (snapshot.status !== "ready") return null;
      var value = snapshot.value || {};
      var writable = snapshot.writable === true;

      return e(SettingsForm, {
        scope: scope,
        value: value,
        writable: writable
      });
    }

    function SettingsForm(props) {
      var scope = props.scope;
      var value = props.value;
      var disabled = !props.writable;
      var [busy, setBusy] = React.useState(false);
      var [note, setNote] = React.useState(null);

      /**
       * 写入走官方 scope.set / scope.unset。失败时以服务端读回的快照为准，
       * 不做本地乐观改值——面板显示的必须是真值。
       */
      var write = React.useCallback(function (key, next) {
        setBusy(true);
        setNote(null);
        var op = next === undefined ? scope.unset(key) : scope.set(key, next);
        Promise.resolve(op).then(
          function () { setBusy(false); setNote(t("settings.saved")); },
          function () { setBusy(false); setNote(t("error.rejected")); }
        );
      }, [scope]);

      var setNumber = function (key) {
        return function (text) {
          if (text === "") return write(key, undefined);
          if (Number.isFinite(Number(text))) return write(key, Number(text));
          return undefined;
        };
      };
      var setText = function (key) {
        return function (text) {
          return write(key, text === "" ? undefined : text);
        };
      };

      var locked = busy || disabled;

      return e(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "12px", maxWidth: "720px" } },
        e("h3", { style: { fontSize: "15px", fontWeight: 600, margin: 0, color: "var(--dsw-alias-label-primary)" } }, t("settings.title")),
        e(
          "div",
          { style: row },
          e("div", { style: rowText },
            e("span", { style: rowName }, t("settings.enable")),
            e("span", { style: rowHint }, t("settings.enableHint"))
          ),
          e(P.Switch, {
            checked: value.autoRenameEnabled !== false,
            disabled: locked,
            label: t("settings.enable"),
            onChange: function (next) { write("autoRenameEnabled", next); }
          })
        ),
        e(Field, { label: t("settings.model") },
          e("p", { style: Object.assign({}, rowHint, { margin: "0 0 4px" }) }, t("settings.modelHint")),
          e("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
            e(Field, { label: t("settings.provider") },
              e(TextControl, { value: value.provider, disabled: locked, placeholder: t("settings.followHint"), onCommit: setText("provider") })
            ),
            e(Field, { label: t("settings.modelName") },
              e(TextControl, { value: value.model, disabled: locked, placeholder: t("settings.followHint"), onCommit: setText("model") })
            )
          )
        ),
        e("div", { style: { display: "flex", gap: "16px", flexWrap: "wrap" } },
          [
            ["suggestionCount", "settings.count"],
            ["maxOutputTokens", "settings.tokens"],
            ["timeoutMs", "settings.timeout"],
            ["targetWords", "settings.words"],
            ["targetCjkCharacters", "settings.cjk"]
          ].map(function (pair) {
            return e(Field, { key: pair[0], label: t(pair[1]) },
              e(NumberControl, { value: value[pair[0]], disabled: locked, onCommit: setNumber(pair[0]) })
            );
          })
        ),
        e("span", { style: rowHint }, note !== null ? note : t("settings.saved"))
      );
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
     * 设置卡片：走官方 settingsScope 接口。
     *
     * settingsScope.bind({namespace, decode}) 返回一个 scope，暴露
     * getSnapshot/subscribe/set/unset——这是 dsh-mcp-connector 在用的官方写法，
     * 比 configForms 的 ops/revision 通道少一层手工构造。
     */
    function installSettingsCard(ctx) {
      if (typeof ctx.inject !== "function") return;
      ctx.inject(["settingsScope"], function (settingsCtx) {
        if (typeof settingsCtx?.settingsScope?.bind !== "function") return;
        var scope = settingsCtx.settingsScope.bind({ namespace: NS });
        if (typeof scope?.getSnapshot !== "function" || typeof scope?.subscribe !== "function") return;

        settingsCtx.effect(function () {
          return settingsCtx.slots.inject("settings.plugin.item", function () {
            return settingsCtx.slots.register(
              {
                name: "settings.plugin.item",
                key: NS,
                locale: NS,
                inject: function () { return { scope: scope }; }
              },
              SettingsPanel
            );
          });
        }, "dsh-auto-rename: settings card");
      });
    }

    /**
     * 顶部入口：注册在 `创造模式` 右侧的 list 槽。
     *
     * inject 收到的是 sessionId；组件从 props 拿数据，不触碰 ctx（渲染器铁律），
     * 因此这里把重命名动作与当前标题一起打包进 props。
     */
    function installHeaderAction(ctx) {
      var sessions = ctx.sessions;
      ctx.effect(function () {
        return ctx.slots.inject("conversation.session.header.actions", function () {
          return ctx.slots.register(
            {
              name: "conversation.session.header.actions",
              id: NS,
              order: 20,
              locale: NS,
              inject: function (sessionId) {
                var summary = sessions.list.getSnapshot().byId[sessionId];
                return {
                  sessionId: sessionId,
                  currentTitle: summary ? summary.displayTitle : "",
                  onRename: function (id, title) {
                    return sessions
                      .using(id, { source: "workspaceOperation" }, function (ref) {
                        return ref.binding.session.rename(title);
                      })
                      .then(function (result) {
                        if (!result.ok) throw new Error(result.error ? result.error.message : "rename failed");
                      });
                  }
                };
              }
            },
            HeaderAction
          );
        });
      }, "dsh-auto-rename: header action");
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale", "sessions"];
    return module.exports;
  }
});
