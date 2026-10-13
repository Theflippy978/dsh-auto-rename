// 测试替身：只为验证 host 半边的调用接线，不复制官方实现。
export async function generateSessionTitleWithLlm(ctx, config, request, selectedMessages, titleProvider) {
  if (config.provider === undefined || config.model === undefined) {
    throw new Error("session-title-llm: no logged request route is available; configure provider and model together");
  }
  return {
    title: `stub:${selectedMessages.length}:${config.provider}/${config.model}`,
    messageSeqs: selectedMessages.map((m) => m.seq),
    model: { provider: config.provider, model: config.model }
  };
}
