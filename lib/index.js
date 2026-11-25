/**
 * Host 半边：注册标题 provider，并提供供客户端拉取命名建议的 HTTP 路由。
 *
 * 标题节拍随配置切换：自动刷新开启时为 all-prompts（每条新消息刷新标题），
 * 关闭时为 first-prompt（只用首条消息命名一次）。provider 全局唯一。
 *
 * 依赖在运行时解析。Config 字段全部 volatile，值就地更新，
 * 因此不缓存 resolveConfig 的结果，每次生成都重读。
 */

import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import z from "@deepseek-ai/schemastery";
import {
  NS,
  PROVIDER_ID,
  TITLE_ATTEMPTS,
  AUTO_EFFORT,
  buildShortenPrompt,
  buildSystemPrompt,
  clampTitle,
  frameMessages,
  frameShorten,
  pickReasoningEffort,
  pickRecentMessages,
  reasoningBudget,
  describeReasoning,
  resolveConfig,
  titleExceedsBudget,
  titleFromResponse,
  DEFAULTS
} from "./config.js";

/**
 * 可配置项。
 *
 * 标题长度只有 targetCjkCharacters 一个旋钮（换算成显示宽度，中英文共用）；
 * targetWords 由 resolveConfig 派生，不作为独立配置项。
 *
 * 每个字段都声明 .default()，供「恢复默认」读取 schema 的基准值；
 * 缺少默认值时恢复默认会把输入框置空。默认值与 DEFAULTS 保持一致。
 * provider/model 默认为空串，表示跟随主模型。
 *
 * .volatile() 表示字段变化不触发插件重载，可与 .default() 共存。
 */
export const Config = z.object({
  provider: z.string().default("").volatile(),
  model: z.string().default("").volatile(),
  targetCjkCharacters: z.number().step(1).min(1).max(400).default(DEFAULTS.targetCjkCharacters).volatile(),
  maxInputBytes: z.number().step(1).min(256).max(1048576).default(DEFAULTS.maxInputBytes).volatile(),
  maxOutputTokens: z.number().step(1).min(8).max(4096).default(DEFAULTS.maxOutputTokens).volatile(),
  timeoutMs: z.number().step(1).min(1000).max(600000).default(DEFAULTS.timeoutMs).volatile(),
  suggestionCount: z.number().step(1).min(1).max(5).default(DEFAULTS.suggestionCount).volatile(),
  autoRenameEnabled: z.boolean().default(DEFAULTS.autoRenameEnabled).volatile(),
  allowUnlock: z.boolean().default(DEFAULTS.allowUnlock).volatile(),
  reasoningEffort: z.string().default(AUTO_EFFORT).volatile()
});

export const inject = ["sessionTitle", "llm", "sessions", "webServer"];

/**
 * 在运行时解析执行层依赖，按优先级尝试三条路径。
 *
 *  1. 以宿主资源目录内的 package.json 为锚创建 createRequire。
 *  2. 从本文件逐级向上 createRequire。
 *  3. 裸标识符动态 import，作为兜底。
 *
 * 前一条失败则尝试下一条，全部失败时抛出汇总错误。
 * Windows 上绝对路径需经 pathToFileURL 转换后才能传给 import()。
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
      } catch { /* 尝试下一个基准路径 */ }
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

/** 取服务，不可用时返回 undefined。 */
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

  // 每次生成都重读配置：volatile 字段就地更新。
  const live = () => resolveConfig(config);

  // 启动时校验一次配置，使此类错误立即出现在日志中。
  // 只警告不抛错：抛错会导致插件树启动失败。
  try {
    live();
  } catch (error) {
    ctx.logger.warn(`${NS}: invalid configuration — ${error instanceof Error ? error.message : String(error)}`);
  }

  registerTitleProvider(ctx, sessionTitle, live);
  registerBridge(ctx, live, sessionTitle);
}

/** 注册全局唯一的标题 provider；名额被占用时降级为只保留建议功能。 */
function registerTitleProvider(ctx, sessionTitle, live) {
  // register() 返回的 disposer 挂到 effect 上，卸载时释放全局名额。
  ctx.effect(() => {
  try {
    return sessionTitle.register({
      id: PROVIDER_ID,
      /**
       * 节拍用 getter 实现：字段是 volatile 的，值就地更新且不重新注册 provider，
       * 写死快照会让配置切换无法生效。每次排程都会现读 automatic。
       *
       * all-prompts：每条新消息都重读最近几条并刷新标题。
       * first-prompt：只在无父会话、首条消息、尚无标题时排程一次；
       * 该判断同步执行，兜底标题随后写入，因此这一次 generate() 仍会执行。
       * 关闭后仍由 AI 命名，只是只用首条消息、之后不再改写。
       *
       * validateProvider 会读取一次 automatic，配置不完整时返回默认值。
       */
      get automatic() {
        try {
          return live().autoRenameEnabled ? "all-prompts" : "first-prompt";
        } catch {
          return "all-prompts";
        }
      },
      async generate(request) {
        // 用最近的消息重新概括，使标题跟上话题变化。
        // 关闭自动刷新时排程已限制在首条消息，这里不再重复拒绝。
        // 条数封顶并按字节裁剪，超过 maxInputBytes 会在拼帧时抛错。
        const resolved = live();
        const selected = pickRecentMessages(request.messages, AUTO_SOURCE_MESSAGES, resolved.maxInputBytes);
        if (selected.length === 0) throw new Error(`${NS}: this session has no user message to name it from`);
        return generateTitle(ctx, resolved, request, selected);
      }
    });
  } catch (error) {
    ctx.logger.warn(
      `${NS}: provider registration failed (another provider owns session titles?) — auto-rename disabled`,
      String(error)
    );
    return () => {};
  }
  }, `${NS}: title provider`);
}

/**
 * 单次尝试的取消信号：上游取消信号与本尝试独立的超时信号组合。
 *
 * 每次尝试需要满额超时预算，共用单一超时会让重试只剩剩余时间，
 * 在慢调用场景下失去意义。
 *
 * 上游 signal 表示取消（会话被取代、服务下线）而非超时，需继续传导；
 * 若它已 abort，调用方对 signal.aborted 的检查会跳过重试。
 */
function attemptSignal(upstream, timeoutMs) {
  const timer = AbortSignal.timeout(timeoutMs);
  return upstream === undefined ? timer : AbortSignal.any([upstream, timer]);
}

/**
 * /config 的可选 route 覆盖：草稿里的 provider/model 齐全才采用，否则返回当前值。
 *
 * 不完整的 route（只填 provider）不用于探测：resolveModelInfo 拿到空 model
 * 只会返回 undefined，界面会误判为读不到能力。
 * 跟随主模型（两者都空）同样回退：实际 route 在生成时另行决定。
 */
function pickProbeRoute(current, body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return current;
  const provider = typeof body.provider === "string" ? body.provider.trim() : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (provider === "" || model === "") return current;
  return { provider, model };
}

/**
 * 模型能力探测的超时上限。
 *
 * resolveModelInfo 会请求 adapter，可能长时间无响应。
 * 探测失败不影响命名，缺少超时会让 /config 请求一直不返回。
 */
const PROBE_TIMEOUT_MS = 5000;

/**
 * 探测模型能力：推理档位、上下文与默认 maxTokens。
 *
 * 失败一律返回 undefined：能力探测是可选增强，探测不到时沿用原有行为，
 * 不能因此让整次命名失败。adapter 超时或模型下线都属于可预期情况。
 */
async function probeModelInfo(ctx, route, signal) {
  if (route === undefined) return undefined;
  const llm = readService(ctx, "llm");
  if (llm === undefined || typeof llm.resolveModelInfo !== "function") return undefined;
  try {
    return await llm.resolveModelInfo(route.provider, route.model, signal);
  } catch {
    return undefined;
  }
}

/**
 * 超长标题的一次缩短重试。
 *
 * 由模型改写以保留语义，避免 clampTitle 硬切丢掉后半句或切坏词。
 * 失败（超时、取消、空输出、原样返回、仍超长）一律返回 undefined，
 * 调用方沿用 clampTitle 的结果。
 *
 * 使用独立的满额超时，不占用主调用剩余预算。
 * 建议路径传入的 session 屏蔽了 append，这里追加的审计事件同样被丢弃。
 */
async function shortenTitle(ctx, mod, execution, request, resolved, messageSeqs, raw, effortMode) {
  const signal = attemptSignal(request.signal, resolved.timeoutMs);
  try {
    const response = await mod.executeSessionTitleLlm(
      ctx,
      execution,
      { ...request, signal },
      PROVIDER_ID,
      {
        system: buildShortenPrompt(resolved),
        input: frameShorten(raw),
        messageSeqs,
        selectReasoningEffort: (model) => pickReasoningEffort(model, effortMode)
      }
    );
    const candidate = titleFromResponse(response);
    // 只在确实符合预算时采用：模型可能原样返回或换个说法仍超长。
    if (titleExceedsBudget(candidate, resolved.targetCjkCharacters)) return undefined;
    return clampTitle(candidate, resolved.targetCjkCharacters);
  } catch {
    return undefined;
  }
}

/**
 * 执行层负责路由、字节上限、deadline、调用准备、审计与收流；
 * 本模块负责提示词、输出解读与长度约束。
 */
async function generateTitle(ctx, resolved, request, selectedMessages) {
  const mod = await loadDshModule("@deepseek-ai/dsh-session-title-llm");
  const route = resolved.route ?? request.route;
  if (route === undefined) {
    throw new Error(`${NS}: no route available; configure provider and model together`);
  }
  // 调用执行层前探测模型能力：其 maxTokens 在配置阶段已定死，configure 回调无法修改。
  // 探测信号带独立超时，并并入 request.signal 以传导上游取消。
  const modelInfo = await probeModelInfo(ctx, route, attemptSignal(request.signal, PROBE_TIMEOUT_MS));
  // 配置的档位：auto = 有 off 就关、没有就退最低档；具体 id = 照办（越界自动回退）。
  const effortMode = resolved.reasoningEffort ?? AUTO_EFFORT;
  // resolveSessionTitleLlmConfig 只认这 5 个键，多一个就抛 unknown config key。
  const execution = mod.resolveSessionTitleLlmConfig({
    maxInputBytes: resolved.maxInputBytes,
    maxOutputTokens: reasoningBudget(modelInfo, resolved.maxOutputTokens, effortMode),
    timeoutMs: resolved.timeoutMs,
    provider: route.provider,
    model: route.model
  });
  const messageSeqs = selectedMessages.map((message) => message.seq);
  // 只把 provider 写入的标题作为锚点，兜底标题（截断的首条消息）不算，
  // 否则模型会把「保持原样」也当成合格结果。
  const anchor = request.currentTitle?.source?.kind === "provider" ? request.currentTitle.title : undefined;
  const system = buildSystemPrompt(resolved, anchor !== undefined);
  const input = frameMessages(selectedMessages, anchor);
  let lastError;
  for (let attempt = 0; attempt < TITLE_ATTEMPTS; attempt++) {
    // 每次尝试用一份独立信号，并并入 request.signal 以传导上游取消。
    // deadline 取 signal 与 timeoutMs 中的先到者，复用旧信号会让后续只剩剩余预算。
    const attemptRequest = { ...request, signal: attemptSignal(request.signal, resolved.timeoutMs) };
    const response = await mod.executeSessionTitleLlm(ctx, execution, attemptRequest, PROVIDER_ID, {
      system,
      input,
      messageSeqs,
      selectReasoningEffort: (model) => pickReasoningEffort(model, effortMode)
    });
    try {
      const raw = titleFromResponse(response);
      let title = clampTitle(raw, resolved.targetCjkCharacters);
      // 长度要求在提示词里是软约束，首次输出可能超预算。
      // 先给模型一次机会自行压缩并保住语义，失败或仍超长则沿用 clampTitle 结果。
      // 上游已取消时不再重试，否则只会立即 abort。
      if (titleExceedsBudget(raw, resolved.targetCjkCharacters) && attemptRequest.signal?.aborted !== true) {
        const shortened = await shortenTitle(ctx, mod, execution, request, resolved, messageSeqs, raw, effortMode);
        if (shortened !== undefined) title = shortened;
      }
      return {
        title,
        messageSeqs,
        model: response.model
      };
    } catch (error) {
      lastError = error;
      // 只重试推理耗尽预算这一种：思考长度不定，同预算重跑可能成功。
      // tool-calls、空文本等失败重跑结果相同，重试只是多一次调用。
      if (response?.finish?.kind !== "max-tokens") throw error;
      // 上游已取消时不再重试，否则只会立即 abort 并多写一条审计事件。
      // 超时不在排除之列：新信号已给出满额预算。
      // 这里读 attemptRequest.signal，它由上游信号与本次超时合成，
      // 因此上游取消经由 attemptSignal 传导后才能被拦截。
      if (attemptRequest.signal?.aborted === true) throw error;
    }
  }
  throw lastError;
}

/** 只接受本机来源，避免把调用接口暴露给任意网页。 */
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
 * 以 NDJSON 流式写出：每行一个 JSON 对象。
 *
 * 响应头在首行之前发出；之后每条候选写出一行，客户端可逐条渲染，
 * 无需等待最慢的一条。头发出之后的错误只能用一行 {type:"error"} 表达。
 */
function openNdjson(res) {
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    // no-transform 使中间件跳过压缩：压缩会把逐行写出的数据攒成一块，
    // 客户端的逐条渲染退化为一次性出现。
    "cache-control": "no-store, no-transform",
    // 关闭代理层的响应缓冲。
    "x-accel-buffering": "no"
  });
  // writeHead 只记录状态，不写 socket：不 flush 时客户端要等第一次 write
  // 才能拿到响应头，fetch() 会挂起。flush 之后 headersSent 为 true，
  // 据此判定流已开始。
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
 * 按白名单与类型过滤可写字段，这是写入前的信任边界。
 *
 * 请求来自浏览器，可能携带任意键；白名单与类型检查在写入前完成，
 * 不合法的值直接丢弃。
 *
 * 返回 { set, unset } 而非单个 patch：清空字段必须用 unset 表达。
 * settings.update 会剥掉 undefined，因此 { provider: undefined } 不会删除字段。
 */
function pickWritableConfig(body) {
  const set = {};
  const unset = [];
  if (typeof body.autoRenameEnabled === "boolean") set.autoRenameEnabled = body.autoRenameEnabled;
  if (typeof body.allowUnlock === "boolean") set.allowUnlock = body.allowUnlock;
  for (const field of ["targetCjkCharacters", "maxInputBytes", "maxOutputTokens", "timeoutMs", "suggestionCount"]) {
    const value = body[field];
    if (typeof value === "number" && Number.isFinite(value)) set[field] = value;
  }
  for (const field of ["provider", "model"]) {
    const value = body[field];
    if (typeof value !== "string") continue;
    // 空串表示跟随主模型，即删除这一层的覆盖值。
    if (value.trim() === "") unset.push(field);
    else set[field] = value;
  }
  // 档位只校验非空字符串：合法档位取决于当前模型，由 /config 的 reasoning.efforts 给出。
  // 配置了不支持的档位时，pickReasoningEffort 会自动回退。
  if (typeof body.reasoningEffort === "string" && body.reasoningEffort.trim() !== "") {
    set.reasoningEffort = body.reasoningEffort.trim();
  }
  return { set, unset };
}

/** HTTP 路由：/suggest 提供建议，/config 回显配置，/refresh-title 解除手动标题的固定。 */
function registerBridge(ctx, live, sessionTitle) {
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
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        // live() 会因配置不完整抛错，这里接住以避免 HTTP 处理器崩溃。
        try {
          const resolved = live();
          // 可选的 route 覆盖用于设置面板换模型后更新推理说明：只读不写，
          // 探测草稿里的模型档位，不改动生效配置。缺字段则退回生效值。
          const probe = pickProbeRoute(resolved.route, await readJsonBody(req));
          // 同时报告该模型支持的档位、实际采用的档位与输出上限。
          // 探测失败只使 reasoning.known 为 false，不影响其余字段。
          const modelInfo = await probeModelInfo(ctx, probe, AbortSignal.timeout(PROBE_TIMEOUT_MS));
          writeJson(res, 200, {
            ok: true,
            value: {
              ...resolved,
              route: resolved.route ?? null,
              reasoning: describeReasoning(modelInfo, resolved.maxOutputTokens, resolved.reasoningEffort ?? AUTO_EFFORT)
            }
          });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
    },
    {
      /**
       * 通过 HTTP 路由写配置，供设置面板使用。
       *
       * 调用 settings 服务的 update(ns, patch)，namespace 为 NS。
       * 字段是 volatile 的，写入后下一次生成即生效，无需重启或重新挂载。
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
        const { set, unset } = pickWritableConfig(body);
        if (Object.keys(set).length === 0 && unset.length === 0) {
          writeJson(res, 400, { ok: false, error: "no writable field in the request" });
          return;
        }
        const settings = readService(ctx, "settings");
        if (!settings || (typeof settings.update !== "function" && typeof settings.mutate !== "function")) {
          // settings 服务不可用时明确报错，而非假装保存成功。
          writeJson(res, 503, { ok: false, error: "the host settings service is unavailable" });
          return;
        }
        // 清空字段只能用 mutate 的 {op:"unset"}：update 会剥掉 undefined。
        if (unset.length > 0 && typeof settings.mutate !== "function") {
          writeJson(res, 501, {
            ok: false,
            error: "this host cannot clear a field; upgrade the host to reset provider/model"
          });
          return;
        }
        try {
          if (unset.length > 0) {
            const ops = [
              ...Object.entries(set).map(([field, value]) => ({ op: "set", path: [field], value })),
              ...unset.map((field) => ({ op: "unset", path: [field] }))
            ];
            await settings.mutate(NS, ops);
          } else {
            await settings.update(NS, set);
          }
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
          // 流打开（writeHead + flushHeaders）后不能再改状态码，
          // 因此开流前完成所有可预见的失败判定：源消息为空、配置不完整等
          // 错误仍需用 500 表达，否则客户端只会收到 200 加一行 error。
          const plan = prepareSuggestions(resolved, session, body.count);
          const write = openNdjson(res);
          await suggestTitles(
            ctx,
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
    },
    {
      /**
       * 解除手动标题的固定：把 source.kind 从 user 交还给自动命名体系。
       *
       * 宿主在标题来源为 user 时会跳过自动命名，refresh 是唯一的显式解除入口。
       * 有可用 provider 且会话有输入时，它会重新生成一条 provider 标题；
       * 否则落到 fallback 标题。调用方依据返回的 source.kind 判断结果。
       */
      kind: "exact",
      path: `/${NS}/refresh-title`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const body = await readJsonBody(req);
        if (body === undefined || typeof body !== "object" || body === null || Array.isArray(body)) {
          writeJson(res, 400, { ok: false, error: "malformed JSON body" });
          return;
        }
        const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
        if (sessionId === "") {
          writeJson(res, 400, { ok: false, error: "sessionId is required" });
          return;
        }
        if (typeof sessionTitle?.refresh !== "function") {
          writeJson(res, 503, { ok: false, error: "session-title refresh is unavailable" });
          return;
        }
        try {
          const session = readService(ctx, "sessions")?.get?.(sessionId);
          if (session === undefined) {
            writeJson(res, 404, { ok: false, error: `session "${sessionId}" is not live` });
            return;
          }
          const snapshot = await sessionTitle.refresh(session);
          writeJson(res, 200, {
            ok: true,
            value: { title: snapshot?.title ?? null, source: snapshot?.source ?? null }
          });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
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

/** 建议路径取最近几条人类消息作为命名源。 */
const SUGGEST_SOURCE_MESSAGES = 3;

/**
 * 自动命名使用的源消息条数。
 *
 * 比建议路径多几条：自动命名要覆盖对话累积的话题，条数太少会丢失早期主题。
 * 总量上限由 maxInputBytes 约束。
 */
const AUTO_SOURCE_MESSAGES = 6;

/**
 * 在开流前确定条数、源消息与路由。
 *
 * 单独抽出是为了保证顺序：这些校验失败时仍能用 HTTP 状态码表达，
 * 流一旦打开就只剩 error 行。这样 suggestTitles 只负责并发生成。
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
 * 并行生成 N 条候选，每条完成即交给回调。
 *
 * 与自动命名共用 generateTitle，提示词、框架化、超时、收流、归一化与长度截断一致；
 * 区别只在源消息条数与会话视图。
 *
 * Promise.all 只用于等待全部结束，不参与结果收集：
 * 每条候选一 settle 就分别调用 onTitle 或 onError，回调顺序即完成顺序。
 * 若先收集数组再统一返回，首条候选会被最慢的一条拖住，逐条显示就失去意义。
 */
async function suggestTitles(ctx, resolved, session, plan, onTitle, onError) {
  await Promise.all(Array.from({ length: plan.total }, async () => {
    const request = {
      session: silentSession(session),
      messages: plan.messages,
      route: plan.route
      // 超时由每次 attempt 自己生成的信号负责，不设外层 signal。
    };
    try {
      const result = await generateTitle(ctx, resolved, request, plan.messages);
      onTitle(result.title);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }));
}

/**
 * 建议路径使用的会话视图，屏蔽 append。
 *
 * 执行层会向 session 追加审计事件，屏蔽后可避免重复触发时堆积日志。
 * 执行层只用到 session 的 id 与 append：id 保留，用于路由与遥测。
 */
function silentSession(session) {
  return {
    id: session.id,
    append() {}
  };
}

/**
 * 从会话事件中提取人类文本消息，形状为 { seq, text }。
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

/** 从会话事件中反推最近一次请求使用的模型路由。 */
function latestRoute(session) {
  const events = typeof session.snapshotEvents === "function" ? session.snapshotEvents() : [];
  for (let index = events.length - 1; index >= 0; index--) {
    const config = events[index]?.type === "request/header" ? events[index].data?.header?.config : undefined;
    if (config?.provider && config?.model) return { provider: config.provider, model: config.model };
  }
  return undefined;
}

export const name = NS;
