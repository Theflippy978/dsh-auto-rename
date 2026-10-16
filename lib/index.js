/**
 * dsh-auto-rename —— Host 半边。
 *
 * 做两件事：
 *  1. 接管 SessionTitleService 的 provider 注册（automatic: "first-prompt"，
 *     Codex 式首个对话自动命名）。内置的 session-title-llm 行由
 *     cordis.patch.yml 禁用，因为 register() 全局唯一。
 *  2. 暴露 HTTP 桥，供 client 半边为「AI 命名建议」弹窗拉取 N 条候选。
 *
 * 依赖解析：@deepseek-ai/dsh-session-title-llm 只存在于 app.asar 内，
 * profile 的 node_modules 里没有，所以走 createRequire 在宿主运行时解析，
 * 与 dsh-better-sidebar / dsh-context 的做法一致。
 *
 * volatile 语义：Config 的字段全部 volatile，宿主 loader 收到新值就地提交到
 * 本进程的 config 引用，因此这里绝不缓存 resolveConfig 的结果——每次生成都重读。
 */

import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import z from "@deepseek-ai/schemastery";
import { NS, PROVIDER_ID, clampTitle, pickRecentMessages, pickSourceMessages, resolveConfig } from "./config.js";

/**
 * 用户可配项。
 *
 * 标题长度只有 targetCjkCharacters 一个旋钮（换算成显示宽度，中英文共用）；
 * 官方共享实现要求的 targetWords 由 resolveConfig 从它派生，不再单独暴露。
 */
export const Config = z.object({
  provider: z.string().volatile(),
  model: z.string().volatile(),
  targetCjkCharacters: z.number().step(1).min(1).max(400).volatile(),
  maxInputBytes: z.number().step(1).min(256).max(1048576).volatile(),
  maxOutputTokens: z.number().step(1).min(8).max(4096).volatile(),
  timeoutMs: z.number().step(1).min(1000).max(600000).volatile(),
  suggestionCount: z.number().step(1).min(1).max(5).volatile(),
  autoRenameEnabled: z.boolean().volatile()
});

export const inject = ["sessionTitle", "llm", "sessions", "webServer"];

/**
 * 在宿主运行时解析 @deepseek-ai/dsh-session-title-llm。
 *
 * 这个包只存在于 app.asar 内，profile 的 node_modules 里没有，所以不能写静态
 * import。三条路依次试（按实测成功率排序）：
 *
 *  1. 以 asar 内的 dsh/package.json 为锚做 createRequire。**这是实测命中的那条**：
 *     Electron 给 fs 打了 asar 补丁，asar 路径对它是普通路径。
 *  2. 从本文件逐级向上 createRequire（本地开发：把包链进 node_modules 时命中）。
 *  3. 裸标识符动态 import，仅作兜底。实测在 Electron 主进程里 ERR_MODULE_NOT_FOUND
 *     ——裸标识符走普通 node 解析链，看不到 asar 内部。
 *
 * Windows 上必须经 pathToFileURL：绝对路径直接喂 import() 会报
 * ERR_UNSUPPORTED_ESM_URL_SCHEME（"c:" 不是合法 scheme）。
 *
 * 实测方式：ELECTRON_RUN_AS_NODE=1 启动 DeepSeek Harness.exe 跑同一段解析。
 */
function loadDshModule(request) {
  const attempts = [];
  if (typeof process.resourcesPath === "string" && process.resourcesPath !== "") {
    attempts.push(() => {
      const anchor = path.join(process.resourcesPath, "app.asar", "dsh", "package.json");
      return import(pathToFileURL(createRequire(anchor).resolve(request)).href);
    });
  }
  attempts.push(() => {
    const require = createRequire(import.meta.url);
    const candidates = [import.meta.url];
    for (let up = 0; up < 6; up++) candidates.push(new URL(`../`.repeat(up + 1), import.meta.url).href);
    for (const base of candidates) {
      try {
        return import(pathToFileURL(require.resolve(request, { paths: [base] })).href);
      } catch { /* 换下一个根 */ }
    }
    throw new Error(`cannot resolve ${request} from ${import.meta.url}`);
  });
  attempts.push(() => import(request));

  // 串起来：前一条 reject 就试下一条，全部失败则抛出汇总错误。
  return attempts.reduce(
    (chain, attempt) => chain.catch(() => attempt()),
    Promise.reject(new Error("no resolution attempt"))
  ).catch((error) => {
    throw new Error(`${NS}: cannot load ${request} (${String(error)})`);
  });
}

/** 取服务：拿不到返回 undefined（被禁用或尚未注册时不炸）。 */
function readService(ctx, name) {
  try {
    return ctx.get(name);
  } catch {
    return undefined;
  }
}

export function apply(ctx, config) {
  const sessionTitle = readService(ctx, "sessionTitle");
  const llm = readService(ctx, "llm");
  if (!sessionTitle || !llm) {
    ctx.logger.warn(`${NS}: sessionTitle or llm service unavailable; auto-rename disabled`);
    return;
  }

  // 每次生成都重读 config：volatile 字段改了就地生效，不重启也不重挂载。
  const live = () => resolveConfig(config);

  // 启动时就校验一次，让「只配了 provider 没配 model」这类错误立刻出现在日志里，
  // 而不是等到第一个对话才发现。只警告不抛错——抛错会让整棵插件树启动失败。
  try {
    live();
  } catch (error) {
    ctx.logger.warn(`${NS}: invalid configuration — ${error instanceof Error ? error.message : String(error)}`);
  }

  registerTitleProvider(ctx, sessionTitle, llm, live);
  registerBridge(ctx, llm, live);
}

/** 注册全局唯一的 session-title provider；被占用时降级为只保留建议功能。 */
function registerTitleProvider(ctx, sessionTitle, llm, live) {
  try {
    sessionTitle.register({
      id: PROVIDER_ID,
      automatic: "first-prompt",
      async generate(request) {
        const resolved = live();
        if (!resolved.autoRenameEnabled) {
          // host 在调用 provider 之前已经写过确定性兜底标题，这里拒绝即等于
          // 「保持兜底标题」，也就是关闭自动命名的预期行为。
          throw new Error(`${NS}: automatic rename is disabled by configuration`);
        }
        // 自动命名只用第一条人类消息；字节预算按当前配置算，超了官方实现会
        // 直接抛错（表现为「没被命名」），所以裁剪必须在这里做。
        return generateTitle(
          ctx,
          llm,
          resolved,
          request,
          pickSourceMessages(request.messages, resolved.maxInputBytes)
        );
      }
    });
  } catch (error) {
    ctx.logger.warn(
      `${NS}: provider registration failed (another provider owns session titles?) — auto-rename disabled`,
      String(error)
    );
  }
}

/**
 * 委托给官方 @deepseek-ai/dsh-session-title-llm 的共享实现：它已经处理了
 * route 回退、JSON 框架化、字节上限、deadline、BlockAssembler 收流、
 * 纯文本校验与 normalizeSessionTitle 归一化。自己重写一遍只会引入偏差。
 *
 * 唯一要补的是长度：官方 normalizeSessionTitle 收到的上限是
 * Number.MAX_SAFE_INTEGER，等于完全不截断，所以「别太长」只能在这里守住。
 */
async function generateTitle(ctx, llm, resolved, request, selectedMessages) {
  const mod = await loadDshModule("@deepseek-ai/dsh-session-title-llm");
  const route = resolved.route ?? request.route;
  if (route === undefined) {
    throw new Error(`${NS}: no route available; configure provider and model together`);
  }
  const shaped = {
    targetWords: resolved.targetWords,
    targetCjkCharacters: resolved.targetCjkCharacters,
    maxInputBytes: resolved.maxInputBytes,
    maxOutputTokens: resolved.maxOutputTokens,
    timeoutMs: resolved.timeoutMs,
    provider: route.provider,
    model: route.model
  };
  const result = await mod.generateSessionTitleWithLlm(ctx, shaped, request, selectedMessages, PROVIDER_ID);
  return { ...result, title: clampTitle(result.title, resolved.targetCjkCharacters) };
}

/** 只接受本机来源，避免把 LLM 调用暴露给任意网页。 */
function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
  const host = request.headers?.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try {
    hostUrl = new URL("http://" + host);
  } catch {
    return false;
  }
  if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/**
 * 流式写出：每行一个 JSON 对象（NDJSON）。
 *
 * 头必须在第一行之前就发出去，所以 writeHead 在这里做一次；之后每条候选
 * 一到就 write 一行并 flush，客户端因此能逐条渲染，不必等最慢的一条。
 * 错误发生在头之后时不能再用状态码表达，只能作为一行 {type:"error"} 下发。
 */
function openNdjson(res) {
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    // no-transform 让宿主的 gzip 中间件跳过这条响应：压缩会把逐条写出的行攒成
    // 一个块再吐，客户端的逐条渲染就退化成一次性出现（host 的 filter 认这个头）。
    "cache-control": "no-store, no-transform",
    // 反代层（nginx 等）同样默认缓冲响应，显式关掉。
    "x-accel-buffering": "no"
  });
  // writeHead 只把状态记在内存里，不写 socket：不 flush 的话客户端要等到第一次
  // write 才拿到响应头，fetch() 会一直挂着（实测）。flush 之后 headersSent 即为
  // true，所以「流已开始」的判定从这一刻起生效。
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  return (event) => {
    res.write(JSON.stringify(event) + "\n");
  };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * 只接受用户可配的那几个字段，并按类型过滤。
 *
 * 这是信任边界：请求来自浏览器，必须假定它可能带任何键（包括 profile 行里的
 * 非 Config 字段）。白名单 + 类型检查在写入前完成，坏值直接丢掉而不是写进去。
 */
function pickWritableConfig(body) {
  const out = {};
  if (typeof body.autoRenameEnabled === "boolean") out.autoRenameEnabled = body.autoRenameEnabled;
  for (const field of ["targetCjkCharacters", "maxInputBytes", "maxOutputTokens", "timeoutMs", "suggestionCount"]) {
    const value = body[field];
    if (typeof value === "number" && Number.isFinite(value)) out[field] = value;
  }
  for (const field of ["provider", "model"]) {
    const value = body[field];
    if (typeof value === "string") out[field] = value.trim() === "" ? undefined : value;
  }
  return out;
}

/** HTTP 桥：/suggest 拉建议，/config 回显当前生效配置。 */
function registerBridge(ctx, llm, live) {
  const webServer = readService(ctx, "webServer");
  if (!webServer || typeof webServer.register !== "function") return;

  const guard = (req, res) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: "loopback requests only" });
      return false;
    }
    if (req.method !== "POST") {
      writeJson(res, 405, { error: `method not allowed: ${req.method ?? ""}` });
      return false;
    }
    return true;
  };

  const routes = [
    {
      kind: "exact",
      path: `/${NS}/config`,
      handler: (req, res) => {
        if (!guard(req, res)) return;
        // live() 会因半对配置抛错；这里必须接住，否则坏配置会让 HTTP 处理器直接崩。
        try {
          const resolved = live();
          writeJson(res, 200, { ok: true, value: { ...resolved, route: resolved.route ?? null } });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
    },
    {
      /**
       * 写配置。设置面板（在「AI 命名」弹窗里）用它落盘，不再依赖宿主插槽。
       *
       * 走宿主 settings 服务的 update(ns, patch)：namespace 就是 profile 里的行 id，
       * 也正是 NS。字段全 volatile，写完 loader 会把新值提交到本进程的 config 引用，
       * 下一次生成即生效（不必重启，也不必重挂载）。
       */
      kind: "exact",
      path: `/${NS}/settings`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const body = await readJsonBody(req);
        if (body === undefined || typeof body !== "object" || body === null || Array.isArray(body)) {
          writeJson(res, 400, { ok: false, error: "malformed JSON body" });
          return;
        }
        const patch = pickWritableConfig(body);
        if (Object.keys(patch).length === 0) {
          writeJson(res, 400, { ok: false, error: "no writable field in the request" });
          return;
        }
        const settings = readService(ctx, "settings");
        if (!settings || typeof settings.update !== "function") {
          // 部署没挂 settings 服务时明确报错，而不是假装保存成功。
          writeJson(res, 503, { ok: false, error: "the host settings service is unavailable" });
          return;
        }
        try {
          await settings.update(NS, patch);
          const resolved = live();
          writeJson(res, 200, { ok: true, value: { ...resolved, route: resolved.route ?? null } });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
    },
    {
      kind: "exact",
      path: `/${NS}/suggest`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const body = await readJsonBody(req);
        if (body === undefined) {
          writeJson(res, 400, { ok: false, error: "malformed JSON body" });
          return;
        }
        const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
        if (sessionId === "") {
          writeJson(res, 400, { ok: false, error: "sessionId is required" });
          return;
        }
        try {
          const resolved = live();
          const session = readService(ctx, "sessions")?.get?.(sessionId);
          if (session === undefined) {
            writeJson(res, 404, { ok: false, error: `session "${sessionId}" is not live` });
            return;
          }
          // 流一旦打开（writeHead + flushHeaders）就不能再改状态码，所以所有
          // 「还没开始生成就已注定失败」的判定必须先做完：源消息为空、配置半对
          // 这类错误必须还能用 500 表达，否则客户端只会看到一个 200 加一行 error。
          const plan = prepareSuggestions(resolved, session, body.count);
          const write = openNdjson(res);
          await suggestTitles(
            ctx,
            llm,
            resolved,
            session,
            plan,
            (title) => write({ type: "title", title }),
            (message) => write({ type: "error", message })
          );
          write({ type: "done" });
          res.end();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (res.headersSent === true || res.writableEnded === true) {
            // 流已经开始：只能把失败作为一行补下去，再收尾。
            try {
              res.write(JSON.stringify({ type: "error", message }) + "\n");
              res.write(JSON.stringify({ type: "done" }) + "\n");
            } catch { /* 客户端已断开，没有可写的通道 */ }
            res.end();
            return;
          }
          writeJson(res, 500, { ok: false, error: message });
        }
      }
    }
  ];

  ctx.effect(() => {
    const disposers = routes.map((route) => webServer.register(route));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, `${NS}: http bridge`);
}

/** 手动弹窗取最近几条人类消息做命名源（自动命名只用第一条）。 */
const SUGGEST_SOURCE_MESSAGES = 3;

/**
 * 开流之前能确定的全部事实：条数、源消息、路由。
 *
 * 单独抽出来是因为**顺序有意义**：这些校验一旦失败必须还能用 HTTP 状态码表达，
 * 而流一打开（writeHead + flushHeaders）就只剩 error 行了。放在这里也让
 * suggestTitles 只负责「并发跑 N 条」，不再重复算一遍。
 */
function prepareSuggestions(resolved, session, count) {
  const total = Math.max(1, Math.min(resolved.suggestionCount, Number(count) || resolved.suggestionCount));
  const messages = pickRecentMessages(
    collectUserMessages(session),
    SUGGEST_SOURCE_MESSAGES,
    resolved.maxInputBytes
  );
  if (messages.length === 0) throw new Error(`${NS}: this session has no user message to name it from`);
  return {
    total,
    messages,
    route: resolved.route ?? latestRoute(session)
  };
}

/**
 * 并行生成 N 条候选，**谁先完成谁先交给回调**。
 *
 * 与自动命名共用 generateTitle，因此提示词、框架化、超时、收流、归一化、
 * 长度截断全部一致；两处区别只在源消息（见 SUGGEST_SOURCE_MESSAGES）与会话
 * 视图（见 silentSession）。
 *
 * 这里的 Promise.all **只用来等全部结束**，不参与结果收集：每条候选一 settle 就
 * 立刻回调（成功 onTitle、失败 onError），所以回调顺序就是完成顺序。若改成先
 * 收集数组再统一返回，首条候选会被最慢的一条拖住，逐条显示就没了意义。
 */
async function suggestTitles(ctx, llm, resolved, session, plan, onTitle, onError) {
  await Promise.all(Array.from({ length: plan.total }, async () => {
    const request = {
      session: silentSession(session),
      messages: plan.messages,
      route: plan.route,
      signal: AbortSignal.timeout(resolved.timeoutMs)
    };
    try {
      const result = await generateTitle(ctx, llm, resolved, request, plan.messages);
      onTitle(result.title);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }));
}

/**
 * 给「建议」用的会话视图。
 *
 * 官方共享实现会往 session 上 append 一条 session/title-llm-request，那是自动
 * 命名流程的审计记录（一次会话只写一条）。建议是用户随手触发、还能反复重新生成
 * 的，若照写就会往会话日志里堆事件（每次打开约 3 条、每条约 5KB）。所以这里挡掉
 * append。共享实现只用到 session 的 id 与 append 两处，id 必须保留——它透传给
 * llm.stream 做路由与遥测。
 */
function silentSession(session) {
  return {
    id: session.id,
    append() {}
  };
}

/**
 * 从会话事件里取合格的人类文本消息，形状对齐 host 的
 * collectSessionTitleMessages（`{ seq, text }`）。
 */
function collectUserMessages(session) {
  const events = typeof session.snapshotEvents === "function" ? session.snapshotEvents() : [];
  const out = [];
  for (const event of events) {
    if (event?.type !== "user/message") continue;
    if (event.data?.source?.kind !== "user") continue;
    const blocks = Array.isArray(event.data.content) ? event.data.content : [];
    const text = blocks
      .filter((block) => block?.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (text.trim() === "") continue;
    out.push({ seq: event.seq, text });
  }
  return out;
}

/** 从会话里反推最近一次请求使用的模型路由（request/header 事件）。 */
function latestRoute(session) {
  const events = typeof session.snapshotEvents === "function" ? session.snapshotEvents() : [];
  for (let index = events.length - 1; index >= 0; index--) {
    const config = events[index]?.type === "request/header" ? events[index].data?.header?.config : undefined;
    if (config?.provider && config?.model) return { provider: config.provider, model: config.model };
  }
  return undefined;
}

export const name = NS;
