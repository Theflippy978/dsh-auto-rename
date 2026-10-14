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

/** 最小 response 替身：记录 status 与 JSON body。 */
function makeRes() {
  return {
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(text) {
      this.body = text === undefined ? undefined : JSON.parse(text);
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

  // 路由形状
  assert.deepEqual(
    routes.map((route) => [route.kind, route.path]),
    [
      ["exact", "/dsh-auto-rename/config"],
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
  const configRoute = routes[0];
  const suggestRoute = routes[1];

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
    await second.routes[0].handler(makeReq({}), r);
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
  await second.routes[0].handler(makeReq({}), res);
  assert.equal(res.status, 500, "a half-pair config must fail loudly when actually used");
  assert.match(res.body.error, /must be configured together/);
}

console.log("apply smoke ok: metadata, degrade, provider shape, routes, guards, config echo");
