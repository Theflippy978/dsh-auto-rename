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
  "autoRenameEnabled"
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
  assert.equal(provider.automatic, "first-prompt", "Codex-style first-prompt cadence");
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
  apply(ctx, { provider: "magpie", model: "group/never-stuck" });

  const result = await registered[0].generate({
    session: {},
    messages: [{ seq: 7, text: "写一个 DSH 自动重命名插件" }],
    signal: AbortSignal.timeout(1000)
  });
  // 替身回显它收到的 route 与源消息数量，证明参数确实透传到位
  assert.equal(result.title, "stub:1:magpie/group/never-stuck");
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

// ---- 5. 关闭自动命名后仍注册 provider，但 generate 明确拒绝 ----

{
  const { ctx, services } = makeCtx();
  const registered = [];
  services.set("sessionTitle", { register: (p) => registered.push(p) });
  services.set("llm", {});
  services.set("sessions", { get: () => undefined });
  services.set("webServer", makeWebServer([]));
  apply(ctx, { autoRenameEnabled: false });
  await assert.rejects(
    () => registered[0].generate({ session: {}, messages: [], signal: AbortSignal.timeout(1000) }),
    /automatic rename is disabled/
  );
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

  // 显式成对配置 → route 回显
  {
    const second = makeCtx();
    second.services.set("sessionTitle", { register: () => {} });
    second.services.set("llm", {});
    second.services.set("sessions", { get: () => undefined });
    second.services.set("webServer", makeWebServer(second.routes));
    apply(second.ctx, { provider: "magpie", model: "group/never-stuck" });
    const r = makeRes();
    await second.routes.find((r) => r.path === "/dsh-auto-rename/config").handler(makeReq({}), r);
    assert.deepEqual(r.body.value.route, { provider: "magpie", model: "group/never-stuck" });
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
    __testTitleGeneration: ({ selectedMessages }) => new Promise((resolve, reject) => {
      const index = gates.length;
      gates.push({
        resolve: () => {
          active--;
          resolve({ title: `Candidate ${index}`, messageSeqs: selectedMessages.map((message) => message.seq) });
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
  apply(ctx, { provider: "magpie", model: "test-model", suggestionCount: 3 });

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
  apply(ctx, { provider: "magpie", model: "test-model", suggestionCount: 2 });

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
  apply(failing.ctx, { provider: "magpie", model: "test-model" });
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
  apply(half.ctx, { provider: "magpie" });
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
    makeReq({ targetCjkCharacters: 16, autoRenameEnabled: false, provider: "magpie", model: "m" }),
    res
  );
  assert.equal(res.status, 200, "a valid patch is accepted");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].ns, "dsh-auto-rename", "the namespace is this plugin's profile entry id");
  assert.deepEqual(updates[0].patch, {
    targetCjkCharacters: 16,
    autoRenameEnabled: false,
    provider: "magpie",
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
  apply(ctx, { provider: "magpie" });
  assert.equal(warns.length, 1, "half-pair config must warn at boot");
  assert.match(warns[0], /must be configured together/);

  // 但真正用到时（生成/建议）必须明确失败，而不是静默产出空标题
  const res = makeRes();
  const second = makeCtx();
  second.services.set("sessionTitle", { register: () => {} });
  second.services.set("llm", {});
  second.services.set("sessions", { get: () => undefined });
  second.services.set("webServer", makeWebServer(second.routes));
  apply(second.ctx, { provider: "magpie" });
  await second.routes.find((r) => r.path === "/dsh-auto-rename/config").handler(makeReq({}), res);
  assert.equal(res.status, 500, "a half-pair config must fail loudly when actually used");
  assert.match(res.body.error, /must be configured together/);
}

console.log("apply smoke ok: metadata, degrade, provider shape, routes, guards, config echo");
