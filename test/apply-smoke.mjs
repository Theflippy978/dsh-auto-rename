/**
 * apply() 冒烟测试：用假的 ctx 把 host 半边跑一遍，验证
 *  - 服务缺失时不抛错（降级）
 *  - provider 注册形状正确（id / automatic / generate）
 *  - HTTP 桥路由的 kind/path 正确，且拒绝非 POST 与非本机来源
 *  - 建议路由能走通（LLM 用替身）
 *
 * 这一步不需要 DSH 在跑，是「改完先证明接线对」的最小成本手段。
 * 依赖：node_modules/@deepseek-ai/schemastery（指向 profile 里那份）。
 */

import assert from "node:assert/strict";
import { apply, Config, inject, name } from "../lib/index.js";
import { REASONING_TOKEN_FLOOR, TITLE_ATTEMPTS } from "../lib/config.js";

// ---- 假 ctx ----

function makeCtx(overrides = {}) {
  const services = new Map();
  const effects = [];
  const warns = [];
  const routes = [];
  const ctx = {
    get: (key) => services.get(key),
    effect: (fn, label) => {
      effects.push({ label, dispose: fn() });
    },
    logger: { warn: (...args) => warns.push(args.join(" ")) },
    ...overrides
  };
  return { ctx, services, effects, warns, routes };
}

function makeWebServer(routes) {
  return {
    register: (route) => {
      routes.push(route);
      return () => {};
    }
  };
}

/**
 * 最小 response 替身：记录 status 与 JSON body。
 *
 * headersSent 必须模拟真实语义：node 的 writeHead 一旦调用它就为 true，
 * 之后不可能再改状态码。替身若不给这个属性，「未开流就失败应走 500」那条
 * 断言就是恒真的废话（实测踩过：真实环境里 writeHead 后 headersSent 立刻为 true）。
 */
function makeRes() {
  return {
    status: undefined,
    headers: undefined,
    body: undefined,
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(text) {
      this.body = text === undefined ? undefined : JSON.parse(text);
      this.writableEnded = true;
    }
  };
}

function makeStreamRes() {
  return {
    status: undefined,
    headers: undefined,
    chunks: [],
    ended: false,
    headersSent: false,
    writableEnded: false,
    flushed: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    flushHeaders() {
      this.flushed = true;
    },
    write(chunk) {
      this.chunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) this.write(chunk);
      this.ended = true;
      this.writableEnded = true;
    },
    get events() {
      return this.chunks.join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    }
  };
}

/** 最小 request 替身：本机 + POST + 给定 body。 */
function makeReq(body, { address = "127.0.0.1", host = "127.0.0.1:19387", method = "POST" } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  return {
    socket: { remoteAddress: address },
    headers: { host },
    method,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    }
  };
}

// ---- 1. 元数据 ----

assert.equal(name, "dsh-auto-rename");
assert.deepEqual(inject, ["sessionTitle", "llm", "sessions", "webServer"]);
assert.ok(Config, "Config must be exported");

// 标题长度只有 targetCjkCharacters 一个旋钮：targetWords 已从 schema 移除，
// 由 resolveConfig 从宽度预算派生。schema 是宿主 loader 校验 profile 的依据，
// 留着它就会让「改了没反应」变成界面能填、后端不认。
assert.deepEqual(Object.keys(Config.dict), [
  "provider",
  "model",
  "targetCjkCharacters",
  "maxInputBytes",
  "maxOutputTokens",
  "timeoutMs",
  "suggestionCount",
  "autoRenameEnabled",
  "reasoningEffort"
], "the config schema must expose exactly the user-facing fields");

// ---- 2. 服务缺失时降级，不抛错 ----

{
  const { ctx, warns } = makeCtx();
  apply(ctx, {});
  assert.equal(warns.length, 1, "missing services must warn exactly once");
  assert.match(warns[0], /sessionTitle or llm service unavailable/);
}

// ---- 3. 正常路径：注册 provider + 两条路由 ----

{
  const { ctx, services, warns, routes } = makeCtx();
  const registered = [];
  services.set("sessionTitle", { register: (provider) => registered.push(provider) });
  services.set("llm", { stream: async function* () {} });
  services.set("sessions", { get: () => undefined });
  services.set("webServer", makeWebServer(routes));

  apply(ctx, {});
  assert.equal(warns.length, 0, "healthy path must not warn");

  // provider 形状
  assert.equal(registered.length, 1, "exactly one provider registered");
  const provider = registered[0];
  assert.equal(provider.id, "dsh-auto-rename", "provider id is the traceable source marker");
  assert.equal(provider.automatic, "all-prompts", "every new human message refreshes the title");
  assert.equal(typeof provider.generate, "function");

  // 路由形状：config 读、settings 写（设置面板）、suggest 拉建议
  assert.deepEqual(
    routes.map((route) => [route.kind, route.path]),
    [
      ["exact", "/dsh-auto-rename/config"],
      ["exact", "/dsh-auto-rename/settings"],
      ["exact", "/dsh-auto-rename/suggest"]
    ]
  );
  assert.ok(routes.every((route) => typeof route.handler === "function"));
}

// ---- 4. provider.generate 走通全链路（session-title-llm 用 test/stubs 替身） ----

{
  const { ctx, services } = makeCtx();
  const registered = [];
  services.set("sessionTitle", { register: (p) => registered.push(p) });
  services.set("llm", {});
  services.set("sessions", { get: () => undefined });
  services.set("webServer", makeWebServer([]));
  apply(ctx, { provider: "acme", model: "nested/main" });

  const result = await registered[0].generate({
    session: {},
    messages: [{ seq: 7, text: "写一个 DSH 自动重命名插件" }],
    signal: AbortSignal.timeout(1000)
  });
  // 替身回显它收到的 route 与源消息数量，证明参数确实透传到位
  assert.equal(result.title, "stub:1:acme/nested/main");
  assert.deepEqual(result.messageSeqs, [7], "the source message seq must be carried through");
}

// ---- 4b. 未配 provider/model 时回退到 host 交来的 request.route ----

{
  const { ctx, services } = makeCtx();
  const registered = [];
  services.set("sessionTitle", { register: (p) => registered.push(p) });
  services.set("llm", {});
  services.set("sessions", { get: () => undefined });
  services.set("webServer", makeWebServer([]));
  apply(ctx, {});

  const result = await registered[0].generate({
    session: {},
    messages: [{ seq: 1, text: "hi" }],
    route: { provider: "from-session", model: "logged-model" },
    signal: AbortSignal.timeout(1000)
  });
  assert.equal(result.title, "stub:1:from-session/logged-model", "must follow the session's logged route");
}

// ---- 4c. 两条路都没有 route 时明确报错，不静默产出空标题 ----

{
  const { ctx, services } = makeCtx();
  const registered = [];
  services.set("sessionTitle", { register: (p) => registered.push(p) });
  services.set("llm", {});
  services.set("sessions", { get: () => undefined });
  services.set("webServer", makeWebServer([]));
  apply(ctx, {});
  await assert.rejects(
    () => registered[0].generate({ session: {}, messages: [{ seq: 1, text: "hi" }], signal: AbortSignal.timeout(1000) }),
    /no route available/
  );
}

// ---- 4d. 推理档位与预算：关得掉就关、关不掉退最低档并抬预算 ----
// 用户四项要求里 1/2/3 的接线全在这一段。断错时的症状是「标题静默为空」或
// 「莫名多花几秒」，都不会报错，所以必须在这里守住参数确实传到了执行层。
{
  const reasoningModel = {
    reasoning: {
      efforts: [
        { id: "low", name: "Low" },
        { id: "high", name: "High" }
      ],
      defaultEffort: "high"
    }
  };
  const generate = async (llm, config) => {
    const { ctx, services } = makeCtx();
    const registered = [];
    services.set("sessionTitle", { register: (p) => registered.push(p) });
    services.set("llm", llm);
    services.set("sessions", { get: () => undefined });
    services.set("webServer", makeWebServer([]));
    let seen;
    ctx.__testTitleGeneration = (payload) => {
      seen = payload;
      return {
        blocks: [{ type: "text", text: "标题" }],
        finish: { kind: "stop" },
        model: { provider: "acme", model: "test-model" }
      };
    };
    apply(ctx, { provider: "acme", model: "test-model", maxOutputTokens: 64, ...config });
    await registered[0].generate({ session: {}, messages: [{ seq: 1, text: "hi" }], signal: AbortSignal.timeout(1000) });
    return seen;
  };

  // 关不掉推理的模型：档位退到最低（不是默认档），预算抬到下限。
  const probing = { resolveModelInfo: async () => reasoningModel };
  const fallback = await generate(probing, {});
  assert.equal(fallback.config.maxOutputTokens, REASONING_TOKEN_FLOOR, "a model that always reasons gets the reasoning floor");
  assert.equal(typeof fallback.prepared.selectReasoningEffort, "function", "the effort picker reaches the shared executor");
  assert.equal(
    fallback.prepared.selectReasoningEffort(reasoningModel),
    "low",
    "no off → the lowest effort, not the model default"
  );

  // 支持 off 的模型：真关掉，预算不动。
  const offModel = { reasoning: { efforts: [{ id: "off", name: "Off" }, { id: "low", name: "Low" }] } };
  const off = await generate({ resolveModelInfo: async () => offModel }, {});
  assert.equal(off.config.maxOutputTokens, 64, "a model that can switch reasoning off keeps the user budget");
  assert.equal(off.prepared.selectReasoningEffort(offModel), "off", "off is used when the model offers it");

  // 关闭档在不同网关里也叫 `none`。它同样该关掉推理、同样不抬预算 —— 写死只认
  // off 的话，这种模型会被白抬到 4096。
  const noneModel = { reasoning: { efforts: [{ id: "none", name: "None" }, { id: "low", name: "Low" }] } };
  const noneOff = await generate({ resolveModelInfo: async () => noneModel }, {});
  assert.equal(noneOff.config.maxOutputTokens, 64, "a model that switches reasoning off via none keeps the user budget");
  assert.equal(noneOff.prepared.selectReasoningEffort(noneModel), "none", "none is used when that is the model's off id");

  // 非推理模型：不传档位，预算也不动。
  const plain = await generate({ resolveModelInfo: async () => ({}) }, {});
  assert.equal(plain.config.maxOutputTokens, 64, "a non-reasoning model keeps the user budget");
  assert.equal(plain.prepared.selectReasoningEffort({}), undefined, "a non-reasoning model gets no effort at all");

  // 探测失败 / 服务没有这个方法：命名照常，按「可能在推理」保守抬预算。
  const broken = await generate({ resolveModelInfo: async () => { throw new Error("adapter is down"); } }, {});
  assert.equal(broken.config.maxOutputTokens, REASONING_TOKEN_FLOOR, "a failed probe falls back to the floor instead of failing the run");
  assert.equal(broken.prepared.selectReasoningEffort(undefined), undefined, "and no effort is sent without model info");
  const noProbe = await generate({}, {});
  assert.equal(noProbe.config.maxOutputTokens, REASONING_TOKEN_FLOOR, "a host without resolveModelInfo still names sessions");
}

// ---- 4b. 推理吃满预算时重试一次；其他失败不重试 ----
{
  const reasoningModel = { reasoning: { efforts: [{ id: "low", name: "Low" }] } };
  // 按序返回预设响应，并记录调用次数。signal 由调用方给，方便「两次尝试之间」
  // 取消上游；hooks 用来在第一次调用后做点动作。
  const run = async (responses, signal = AbortSignal.timeout(5000), hooks = {}) => {
    const { ctx, services } = makeCtx();
    const registered = [];
    services.set("sessionTitle", { register: (p) => registered.push(p) });
    services.set("llm", { resolveModelInfo: async () => reasoningModel });
    services.set("sessions", { get: () => undefined });
    services.set("webServer", makeWebServer([]));
    let calls = 0;
    ctx.__testTitleGeneration = () => {
      const next = responses[Math.min(calls, responses.length - 1)];
      if (calls === 0) hooks.onFirstCall?.();
      if (calls === 1) hooks.onSecondCall?.();
      calls++;
      return next;
    };
    apply(ctx, { provider: "acme", model: "test-model" });
    const request = { session: {}, messages: [{ seq: 1, text: "hi" }], signal };
    let result;
    let error;
    try {
      result = await registered[0].generate(request);
    } catch (thrown) {
      error = thrown;
    }
    return { calls, result, error };
  };
  const truncated = { blocks: [{ type: "text", text: "" }], finish: { kind: "max-tokens" }, model: { provider: "acme", model: "m" } };
  const ok = { blocks: [{ type: "text", text: "标题" }], finish: { kind: "stop" }, model: { provider: "acme", model: "m" } };

  // 第一次吃满、第二次成功：应当重试并拿到标题。
  const retried = await run([truncated, ok]);
  assert.equal(retried.calls, 2, "a truncated title is retried exactly once");
  assert.equal(retried.result?.title, "标题", "the retry result is used");

  // 两次都吃满：把错误抛出去（上层只记日志），且不再多试第三次。
  const exhausted = await run([truncated]);
  assert.equal(exhausted.calls, TITLE_ATTEMPTS, "retries stop at TITLE_ATTEMPTS");
  assert.match(String(exhausted.error?.message), /maxOutputTokens/, "the original failure is surfaced");

  // tool-calls 不是预算问题：同结果重跑没有意义，只调用一次。
  const toolCalls = await run([{ blocks: [{ type: "tool-call" }], finish: { kind: "tool-calls" }, model: { provider: "acme", model: "m" } }]);
  assert.equal(toolCalls.calls, 1, "a non-budget failure is not retried");
  assert.match(String(toolCalls.error?.message), /text only/, "and it still fails loudly");

  // 上游真的被取消时不能重试：会话被取代、宿主关服务都走这条路，多开一次只会
  // 立刻 abort 并多写一条审计事件。所以取消必须赶在「进入 catch」之前，
  // 落在 attempt 0 里 —— 那次复用调用方的 request.signal，守卫原样拦住，
  // 测的是「守卫在位」而不是 attemptSignal 本身。
  const controller = new AbortController();
  const cancelled = await run([truncated, ok], controller.signal, { onFirstCall: () => controller.abort() });
  assert.equal(cancelled.calls, 1, "an upstream cancelled during attempt 0 is not retried");
  assert.match(String(cancelled.error?.message), /maxOutputTokens/, "the original failure is still surfaced");

  // 取消赶在 attempt 1 之前：onSecondCall 是在 attempt 1 的 generateTitle 里
  // 取消上游，attempt 1 已经跑起来了。要测的是「attempt 2 之前取消」，得让取消
  // 落在 attempt 1 返回之后、attempt 2 之前 —— 而那一步是 generateTitle 内部，
  // 没有 hook 可挂。所以用三次响应：第二次也吃满，第三次才成功；hook 挂在
  // 第二次返回前（onSecondCall）取消 → attempt 2 的 attemptRequest.signal 由
  // attemptSignal 合成，只有它把上游并进来才拦得住。
  const controller2 = new AbortController();
  const cancelledBetween = await run([truncated, truncated, ok], controller2.signal, { onSecondCall: () => controller2.abort() });
  assert.equal(cancelledBetween.calls, 2, "the retry is dispatched");
  assert.equal(cancelledBetween.result, undefined, "but an already-cancelled upstream produces no title");
  assert.match(String(cancelledBetween.error?.message), /maxOutputTokens/, "the original failure is surfaced, not a cancelled retry");
}

// ---- 4c. 每次重试拿一份满额超时，而不是接着吃上次剩下的 ----
// executeSessionTitleLlm 的 deadline = request.signal ⊔ timeoutMs。原先两次尝试共用
// 调用方那一个信号：第一次把 40 秒用掉，重试就只剩 20 秒，慢模型（实测单次
// 25–40 秒）必然赶不上，重试形同虚设。所以第 2+ 次必须换新信号。
{
  const reasoningModel = { reasoning: { efforts: [{ id: "low", name: "Low" }] } };
  const { ctx, services } = makeCtx();
  const registered = [];
  services.set("sessionTitle", { register: (p) => registered.push(p) });
  services.set("llm", { resolveModelInfo: async () => reasoningModel });
  services.set("sessions", { get: () => undefined });
  services.set("webServer", makeWebServer([]));
  const seen = [];
  ctx.__testTitleGeneration = (payload) => {
    seen.push(payload.request.signal);
    return seen.length === 1
      ? { blocks: [], finish: { kind: "max-tokens" }, model: { provider: "acme", model: "m" } }
      : { blocks: [{ type: "text", text: "标题" }], finish: { kind: "stop" }, model: { provider: "acme", model: "m" } };
  };
  apply(ctx, { provider: "acme", model: "test-model", timeoutMs: 60 });

  const upstream = AbortSignal.timeout(5000);
  const result = await registered[0].generate({ session: {}, messages: [{ seq: 1, text: "hi" }], signal: upstream });
  assert.equal(seen.length, 2, "the retry still runs");
  assert.notStrictEqual(seen[1], upstream, "a retry must not reuse the caller's signal");
  assert.equal(seen[1].aborted, false, "the retry signal is fresh, so it carries a full budget instead of the remainder");
  // 上游取消半段移到了下面「cancelled」用例，这里只留满额超时的断言。
  assert.equal(result.title, "标题", "and the retry result is used");

  // 合成信号必须仍然听上游的：attemptSignal 丢掉上游 = 上游取消后重试照样发车。
  // 构造：上游在第一次尝试**内部**取消，attempt 1 一 dispatch 就撞上已取消的
  // 合成信号，替身按真实实现返回 aborted 空响应 → finish.kind 不是 max-tokens →
  // generateTitle 抛错，calls 停在 1。MUTANT 下重试信号不认上游 → 第二次照跑 → calls 2。
  const controller = new AbortController();
  const onceRegistered = [];
  services.set("sessionTitle", { register: (p) => onceRegistered.push(p) });
  apply(ctx, { provider: "acme", model: "test-model", timeoutMs: 60 });
  let cancelledCalls = 0;
  ctx.__testTitleGeneration = () => {
    cancelledCalls++;
    if (cancelledCalls === 1) controller.abort();
    return { blocks: [], finish: { kind: "max-tokens" }, model: {} };
  };
  await assert.rejects(
    onceRegistered[0].generate({ session: {}, messages: [{ seq: 1, text: "hi" }], signal: controller.signal }),
    /unexpected finish "aborted"|maxOutputTokens/,
    "an already-cancelled upstream stops at the first attempt"
  );
  assert.equal(cancelledCalls, 1, "cancellation stops after the first attempt");
}

// ---- 5. 关闭自动刷新 = 换节拍为 first-prompt，而不是拒绝命名 ----

{
  const { ctx, services, routes } = makeCtx();
  const registered = [];
  services.set("sessionTitle", { register: (p) => registered.push(p) });
  services.set("llm", {});
  services.set("sessions", { get: () => undefined });
  services.set("webServer", makeWebServer(routes));
  // 宿主对 volatile 字段是「就地提交到同一个 config 引用」，所以替身也必须就地改
  // 这个对象。不这样接的话，这条测试就只是在测我自己手改对象，测不到真路径。
  const raw = { autoRenameEnabled: false, provider: "acme", model: "nested/main" };
  services.set("settings", {
    update: async (_ns, patch) => {
      Object.assign(raw, patch);
    }
  });
  apply(ctx, raw);
  const provider = registered[0];
  const settingsRoute = routes.find((r) => r.path === "/dsh-auto-rename/settings");
  assert.equal(provider.automatic, "first-prompt", "disabled auto refresh names the first prompt only");

  // 关掉之后 generate() 必须照常出 AI 标题：first-prompt 那一次排程是宿主在写
  // 兜底标题之前**同步**做的判断，所以这一次调用真的会发生。旧实现在这里抛错，
  // 等于关掉就再没有 AI 命名、只剩首条消息截断 —— 那不是用户要的语义。
  const titled = await provider.generate({
    session: {},
    messages: [{ seq: 1, text: "阅读文档完成接手" }],
    signal: AbortSignal.timeout(2000)
  });
  assert.equal(typeof titled.title, "string", "a first-prompt title is still generated by the model");
  assert.deepEqual(titled.messageSeqs, [1], "the first message is the source");

  // 就地切换：volatile 字段改了宿主**不会**重新 register()，所以节拍必须是活的
  // getter。快照写死的话「关闭」要等重启才生效 —— 正是本仓库记过多次的假生效。
  await settingsRoute.handler(makeReq({ autoRenameEnabled: true }), makeRes());
  assert.equal(registered.length, 1, "flipping a setting must not re-register the provider");
  assert.equal(provider.automatic, "all-prompts", "the cadence follows the setting without re-registering");
  await settingsRoute.handler(makeReq({ autoRenameEnabled: false }), makeRes());
  assert.equal(provider.automatic, "first-prompt", "and flips back just as live");
}

// 配置坏掉（只配 provider 没配 model）时节拍不能抛错：register() 的
// validateProvider 会读一次 automatic，抛出来会让 provider 整个注册失败，
// 而重挂载不会再来一次 —— 错节拍一路带到重启。
{
  const { ctx, services, warns } = makeCtx();
  const registered = [];
  services.set("sessionTitle", { register: (p) => registered.push(p) });
  services.set("llm", {});
  services.set("sessions", { get: () => undefined });
  services.set("webServer", makeWebServer([]));
  apply(ctx, { provider: "acme" });
  assert.equal(registered.length, 1, "a broken route pair still registers a provider");
  assert.equal(registered[0].automatic, "all-prompts", "an unreadable config falls back to the default cadence");
  assert.ok(warns.length >= 1, "the bad config is warned about at startup");
}

// ---- 6. HTTP 桥的守卫 ----

{
  const { ctx, services, routes } = makeCtx();
  services.set("sessionTitle", { register: () => {} });
  services.set("llm", {});
  services.set("sessions", { get: () => undefined });
  services.set("webServer", makeWebServer(routes));
  apply(ctx, {});
  // 按路径取，不用索引：路由数量会变（加设置写路由时索引断言就断过一次）。
  const routeOf = (path) => routes.find((route) => route.path === path);
  const configRoute = routeOf("/dsh-auto-rename/config");
  const suggestRoute = routeOf("/dsh-auto-rename/suggest");
  const settingsRoute = routeOf("/dsh-auto-rename/settings");
  assert.ok(configRoute && suggestRoute && settingsRoute, "all three bridge routes must be registered");

  // 非本机来源 → 403
  let res = makeRes();
  await configRoute.handler(makeReq({}, { address: "10.0.0.7" }), res);
  assert.equal(res.status, 403);

  // 跨站 → 403
  res = makeRes();
  const crossReq = makeReq({});
  crossReq.headers["sec-fetch-site"] = "cross-site";
  await configRoute.handler(crossReq, res);
  assert.equal(res.status, 403);

  // GET → 405
  res = makeRes();
  await configRoute.handler(makeReq(undefined, { method: "GET" }), res);
  assert.equal(res.status, 405);

  // 本机 POST → 200，且回显生效配置
  res = makeRes();
  await configRoute.handler(makeReq({}), res);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.value.route, null, "no explicit route when unconfigured");
  assert.equal(res.body.value.suggestionCount, 3);
  // 推理能力报告：设置面板靠它显示「这个模型支持哪些档位、本次会用哪个」。
  // llm 服务在这里是空对象（没有 resolveModelInfo），所以必须报 known:false，
  // 而不是谎报「不支持推理」——两者在界面上是不同的话。
  assert.equal(res.body.value.reasoning.known, false, "an unavailable probe is reported as unknown");
  assert.deepEqual(res.body.value.reasoning.efforts, []);
  assert.equal(res.body.value.reasoning.maxOutputTokens, REASONING_TOKEN_FLOOR, "the reported budget matches what generate would use");

  // 显式成对配置 → route 回显
  {
    const second = makeCtx();
    second.services.set("sessionTitle", { register: () => {} });
    second.services.set("llm", {});
    second.services.set("sessions", { get: () => undefined });
    second.services.set("webServer", makeWebServer(second.routes));
    apply(second.ctx, { provider: "acme", model: "nested/main" });
    const r = makeRes();
    await second.routes.find((r) => r.path === "/dsh-auto-rename/config").handler(makeReq({}), r);
    assert.deepEqual(r.body.value.route, { provider: "acme", model: "nested/main" });
  }

  // 6c. /config 的可选 route 覆盖：设置面板「换模型后立刻更新推理说明」用。
  //     只读探测，绝不能改生效配置 —— 用户还没点保存，而自动命名随时可能触发。
  {
    const third = makeCtx();
    third.services.set("sessionTitle", { register: () => {} });
    // 替身按 provider/model 分档：能分辨「探测的是生效配置还是草稿里的模型」。
    third.services.set("llm", {
      resolveModelInfo: async (provider, model) => (
        provider === "provider-b" && model === "draft-model"
          ? { reasoning: { efforts: [{ id: "off" }, { id: "low" }], defaultEffort: "off" } }
          : undefined
      )
    });
    third.services.set("sessions", { get: () => undefined });
    third.services.set("webServer", makeWebServer(third.routes));
    apply(third.ctx, { provider: "acme", model: "nested/main", maxOutputTokens: 64, reasoningEffort: "auto" });
    const handler = third.routes.find((r) => r.path === "/dsh-auto-rename/config").handler;

    // 生效模型探测不到 → known:false（不是谎报「非推理模型」）。
    res = makeRes();
    await handler(makeReq({}), res);
    assert.equal(res.body.value.reasoning.known, false, "the effective model is still the probe target by default");

    // 草稿里成对的 route → 探测它，回显它的档位与预算。
    res = makeRes();
    await handler(makeReq({ provider: "provider-b", model: "draft-model" }), res);
    assert.equal(res.body.value.reasoning.known, true, "a paired draft route is probed instead of the effective one");
    assert.deepEqual(res.body.value.reasoning.efforts, ["off", "low"], "the draft model's efforts are reported");
    assert.equal(res.body.value.reasoning.effort, "off", "auto picks off when the draft model supports it");
    assert.equal(res.body.value.reasoning.maxOutputTokens, 64, "a model that can turn reasoning off keeps the user budget");
    // route 回显仍是生效配置：这条请求只是在「看」，没有改任何东西。
    assert.deepEqual(res.body.value.route, { provider: "acme", model: "nested/main" });

    // 半个 route 不能拿去探测：界面上会显示成「读不到能力」，
    // 而真实原因是「配置半对」—— 这种误导比不探测更糟。必须退回生效 route。
    res = makeRes();
    await handler(makeReq({ provider: "provider-b" }), res);
    assert.equal(res.body.value.reasoning.known, false, "a half pair falls back to the effective route");
    // 跟随主模型（两个都空）同样退回：主模型 route 由 latestRoute 在生成时决定。
    res = makeRes();
    await handler(makeReq({ provider: "", model: "" }), res);
    assert.equal(res.body.value.reasoning.known, false, "following the main model falls back too");
  }

  // 缺 sessionId → 400
  res = makeRes();
  await suggestRoute.handler(makeReq({}), res);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /sessionId is required/);

  // 坏 JSON → 400
  res = makeRes();
  const badReq = makeReq(undefined);
  badReq[Symbol.asyncIterator] = async function* () {
    yield Buffer.from("{not json", "utf8");
  };
  await suggestRoute.handler(badReq, res);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /malformed JSON body/);

  // 会话不存在 → 404
  res = makeRes();
  await suggestRoute.handler(makeReq({ sessionId: "nope" }), res);
  assert.equal(res.status, 404);
  assert.match(res.body.error, /is not live/);
}

// ---- 6b. 建议并行生成、先完成先流出；部分失败不丢已到达候选 ----

{
  const gates = [];
  let active = 0;
  let maxActive = 0;
  const session = {
    id: "live",
    snapshotEvents: () => [1, 2, 3].map((seq) => ({
      type: "user/message",
      seq,
      data: { source: { kind: "user" }, content: [{ type: "text", text: `message ${seq}` }] }
    }))
  };
  const { ctx, services, routes } = makeCtx({
    __testTitleGeneration: ({ prepared }) => new Promise((resolve, reject) => {
      const index = gates.length;
      gates.push({
        resolve: () => {
          active--;
          // 替身必须返回 executeSessionTitleLlm 的真实形状（blocks + finish），
          // 标题字符串由 lib/config.js 的 titleFromResponse 从 blocks 里取。
          resolve({
            blocks: [{ type: "text", text: `Candidate ${index}` }],
            finish: { kind: "stop" },
            model: { provider: "acme", model: "test-model" },
            messageSeqs: prepared.messageSeqs
          });
        },
        reject: (error) => { active--; reject(error); }
      });
      active++;
      maxActive = Math.max(maxActive, active);
    })
  });
  services.set("sessionTitle", { register: () => {} });
  services.set("llm", {});
  services.set("sessions", { get: (id) => id === "live" ? session : undefined });
  services.set("webServer", makeWebServer(routes));
  apply(ctx, { provider: "acme", model: "test-model", suggestionCount: 3 });

  const response = makeStreamRes();
  const pending = routes.find((r) => r.path === "/dsh-auto-rename/suggest").handler(makeReq({ sessionId: "live", count: 3 }), response);
  for (let attempt = 0; attempt < 20 && gates.length < 3; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(gates.length, 3, "all candidate generations start before any finishes");
  assert.equal(maxActive, 3, "three model requests overlap");
  assert.equal(response.headers["content-type"], "application/x-ndjson; charset=utf-8");
  assert.equal(response.flushed, true, "headers must be flushed so the client sees them before the first title");

  gates[2].resolve();
  for (let attempt = 0; attempt < 20 && response.chunks.length < 1; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(response.events, [{ type: "title", title: "Candidate 2" }], "first completed candidate is written before slower requests finish");
  assert.equal(response.ended, false, "stream stays open while requests remain");

  gates[1].reject(new Error("one model failed"));
  for (let attempt = 0; attempt < 20 && response.chunks.length < 2; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(response.events[1], { type: "error", message: "one model failed" }, "failure is reported without discarding prior candidates");
  gates[0].resolve();
  await pending;
  assert.deepEqual(response.events, [
    { type: "title", title: "Candidate 2" },
    { type: "error", message: "one model failed" },
    { type: "title", title: "Candidate 0" },
    { type: "done" }
  ], "results stream in completion order and finish with done");
  assert.equal(response.ended, true);
}

// ---- 6c. 三条全失败仍逐条报错并以 done 收尾；未开始就失败才用 500 ----

{
  const session = {
    id: "live",
    snapshotEvents: () => [{
      type: "user/message",
      seq: 1,
      data: { source: { kind: "user" }, content: [{ type: "text", text: "hello" }] }
    }]
  };
  const { ctx, services, routes } = makeCtx({
    __testTitleGeneration: () => { throw new Error("provider is down"); }
  });
  services.set("sessionTitle", { register: () => {} });
  services.set("llm", {});
  services.set("sessions", { get: (id) => id === "live" ? session : undefined });
  services.set("webServer", makeWebServer(routes));
  apply(ctx, { provider: "acme", model: "test-model", suggestionCount: 2 });

  const response = makeStreamRes();
  await routes.find((r) => r.path === "/dsh-auto-rename/suggest").handler(makeReq({ sessionId: "live", count: 2 }), response);
  assert.deepEqual(response.events, [
    { type: "error", message: "provider is down" },
    { type: "error", message: "provider is down" },
    { type: "done" }
  ], "every failed candidate reports its own error line, then done closes the stream");

  // 会话里没有人类消息 = 还没开始写流就失败，此时仍应能用状态码表达。
  const empty = { id: "empty", snapshotEvents: () => [] };
  const failing = makeCtx({ __testTitleGeneration: () => { throw new Error("unreachable"); } });
  failing.services.set("sessionTitle", { register: () => {} });
  failing.services.set("llm", {});
  failing.services.set("sessions", { get: (id) => id === "empty" ? empty : undefined });
  failing.services.set("webServer", makeWebServer(failing.routes));
  apply(failing.ctx, { provider: "acme", model: "test-model" });
  const plain = makeRes();
  await failing.routes.find((r) => r.path === "/dsh-auto-rename/suggest").handler(makeReq({ sessionId: "empty" }), plain);
  assert.equal(plain.status, 500, "a failure before the stream opens still uses a status code");
  assert.match(plain.body.error, /no user message/);

  // 半对配置（只配 provider）也是「开流前就注定失败」，必须仍能用 500 表达；
  // 若把 prepareSuggestions 挪到 openNdjson 之后，这条会退化成 200 + error 行。
  const half = makeCtx({ __testTitleGeneration: () => { throw new Error("unreachable"); } });
  half.services.set("sessionTitle", { register: () => {} });
  half.services.set("llm", {});
  half.services.set("sessions", { get: (id) => id === "live" ? session : undefined });
  half.services.set("webServer", makeWebServer(half.routes));
  apply(half.ctx, { provider: "acme" });
  const halfRes = makeRes();
  await half.routes.find((r) => r.path === "/dsh-auto-rename/suggest").handler(makeReq({ sessionId: "live" }), halfRes);
  assert.equal(halfRes.status, 500, "a half-pair route must fail before the stream opens");
  assert.match(halfRes.body.error, /must be configured together/);
}

// ---- 6d. 设置写路由：白名单 + settings 服务缺席时明确报错 ----

{
  const { ctx, services, routes } = makeCtx();
  const updates = [];
  services.set("sessionTitle", { register: () => {} });
  services.set("llm", {});
  services.set("sessions", { get: () => undefined });
  services.set("webServer", makeWebServer(routes));
  services.set("settings", { update: async (ns, patch) => updates.push({ ns, patch }) });
  apply(ctx, {});
  const settingsRoute = routes.find((r) => r.path === "/dsh-auto-rename/settings");

  // 正常写入：只把白名单字段交给 settings.update，命名空间就是本插件的行 id。
  let res = makeRes();
  await settingsRoute.handler(
    makeReq({ targetCjkCharacters: 16, autoRenameEnabled: false, provider: "acme", model: "m" }),
    res
  );
  assert.equal(res.status, 200, "a valid patch is accepted");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].ns, "dsh-auto-rename", "the namespace is this plugin's profile entry id");
  assert.deepEqual(updates[0].patch, {
    targetCjkCharacters: 16,
    autoRenameEnabled: false,
    provider: "acme",
    model: "m"
  });

  // 信任边界：请求里夹带的未知键必须被丢掉，不能原样写进 profile 行。
  res = makeRes();
  await settingsRoute.handler(
    makeReq({ targetCjkCharacters: 10, evil: { nested: true }, disabled: true, inject: ["shell"] }),
    res
  );
  assert.equal(res.status, 200);
  assert.deepEqual(updates[1].patch, { targetCjkCharacters: 10 }, "unknown keys never reach the host settings service");

  // 类型不对的值同样丢掉（字符串数字不隐式转换）。
  res = makeRes();
  await settingsRoute.handler(makeReq({ suggestionCount: "3", maxOutputTokens: null }), res);
  assert.equal(res.status, 400, "a patch with no valid field is rejected");
  assert.match(res.body.error, /no writable field/);
  assert.equal(updates.length, 2, "nothing was written for the rejected request");

  // 空字符串的 provider/model 表示「清空 = 跟随主模型」，必须原样传下去（undefined 让宿主删键）。
  res = makeRes();
  await settingsRoute.handler(makeReq({ provider: "", model: "  " }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(updates[2].patch, { provider: undefined, model: undefined }, "blank route fields clear the override");

  // settings 服务缺席 → 503，不能假装保存成功。
  const bare = makeCtx();
  bare.services.set("sessionTitle", { register: () => {} });
  bare.services.set("llm", {});
  bare.services.set("sessions", { get: () => undefined });
  bare.services.set("webServer", makeWebServer(bare.routes));
  apply(bare.ctx, {});
  const bareRes = makeRes();
  await bare.routes.find((r) => r.path === "/dsh-auto-rename/settings").handler(makeReq({ targetCjkCharacters: 12 }), bareRes);
  assert.equal(bareRes.status, 503, "without the settings service the write fails loudly");
  assert.match(bareRes.body.error, /settings service is unavailable/);
}

// ---- 7. 半对配置在启动时警告（抛错会让整棵插件树起不来，所以只警告） ----

{
  const { ctx, services, warns } = makeCtx();
  services.set("sessionTitle", { register: () => {} });
  services.set("llm", {});
  services.set("sessions", { get: () => undefined });
  services.set("webServer", makeWebServer([]));
  apply(ctx, { provider: "acme" });
  assert.equal(warns.length, 1, "half-pair config must warn at boot");
  assert.match(warns[0], /must be configured together/);

  // 但真正用到时（生成/建议）必须明确失败，而不是静默产出空标题
  const res = makeRes();
  const second = makeCtx();
  second.services.set("sessionTitle", { register: () => {} });
  second.services.set("llm", {});
  second.services.set("sessions", { get: () => undefined });
  second.services.set("webServer", makeWebServer(second.routes));
  apply(second.ctx, { provider: "acme" });
  await second.routes.find((r) => r.path === "/dsh-auto-rename/config").handler(makeReq({}), res);
  assert.equal(res.status, 500, "a half-pair config must fail loudly when actually used");
  assert.match(res.body.error, /must be configured together/);
}

console.log("apply smoke ok: metadata, degrade, provider shape, routes, guards, config echo");
