// 测试替身：只为验证 host 半边的调用接线。
//
// 形状对齐被替身依赖的接口：resolveSessionTitleLlmConfig 只认 5 个键，
// executeSessionTitleLlm 返回 { blocks, finish, model }。
export function resolveSessionTitleLlmConfig(value) {
  const keys = new Set(["maxInputBytes", "maxOutputTokens", "timeoutMs", "provider", "model"]);
  for (const key of Object.keys(value ?? {})) {
    if (!keys.has(key)) throw new Error(`session-title-llm: unknown config key "${key}"`);
  }
  const hasProvider = typeof value?.provider === "string" && value.provider !== "";
  const hasModel = typeof value?.model === "string" && value.model !== "";
  if (hasProvider !== hasModel) {
    throw new Error("session-title-llm: provider and model must be supplied together");
  }
  return { ...value };
}

export async function executeSessionTitleLlm(ctx, config, request, titleProvider, prepared) {
  if (request.signal?.aborted !== true) {
    // 未取消 = 正常执行；已取消时返回带 abort finish 的空响应，让调用方按 finish.kind 自行判断。
    if (typeof ctx.__testTitleGeneration === "function") {
      return ctx.__testTitleGeneration({ config, request, prepared, titleProvider });
    }
    if (config.provider === undefined || config.model === undefined) {
      throw new Error("session-title-llm: no logged request route is available; configure provider and model together");
    }
    return {
      blocks: [{ type: "text", text: `stub:${prepared.messageSeqs.length}:${config.provider}/${config.model}` }],
      finish: { kind: "stop" },
      model: { provider: config.provider, model: config.model }
    };
  }
  return { blocks: [], finish: { kind: "aborted" }, model: null };
}
