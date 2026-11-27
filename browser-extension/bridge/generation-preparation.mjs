import { validImageSizeRequest, requestedImageSize, normalizeMagpieSize } from "../lib/image-size.mjs";

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

export function validateGenerationOptions(body) {
  if (!["zh", "en"].includes(body.language)) throw bad("无效提示词语言");
  const { aspectRatio } = body;
  if (!validImageSizeRequest(body.imageSize)) throw bad("像素尺寸须为宽高数字或自动");
  if (body.submittedImageSize !== undefined || body.sizeRule !== undefined) throw bad("提交尺寸和规则由本机服务计算");
  if (aspectRatio !== undefined && (!aspectRatio || typeof aspectRatio !== "object" || Array.isArray(aspectRatio)
    || Object.keys(aspectRatio).some(key => !["width", "height"].includes(key))
    || ![aspectRatio.width, aspectRatio.height].every(value => Number.isInteger(value) && value >= 1 && value <= 10000)
    || aspectRatio.width / aspectRatio.height < 1 / 20 || aspectRatio.width / aspectRatio.height > 20))
    throw bad("宽高须为 1–10000 的整数，比例须在 1:20 至 20:1 之间");
}

function validateGenerationSize(body, settings) {
  if (settings.imageProvider === "magpie") {
    if (body.aspectRatio !== undefined) throw bad("Magpie 使用像素尺寸，不接受宽高比例");
  } else if (body.imageSize !== undefined) throw bad("像素尺寸仅用于 Magpie 生图");
}

function generationSizeSnapshot(settings, value) {
  if (settings.imageProvider !== "magpie") return undefined;
  const imageSize = requestedImageSize(value);
  const { submittedImageSize, sizeRule } = normalizeMagpieSize(settings.model, imageSize);
  return { ...(imageSize ? { imageSize } : {}), submittedImageSize, sizeRule };
}

// Preparation does not admit tasks or write images. Callers keep eligibility checks
// around these steps, and check dependencies only after their image validation.
export function createGenerationPreparation({ imageSettings, generationContext, cliBusy, agents, magpieInspector, requireFeature }) {
  return {
    async prepare(body, { frozen, signal } = {}) {
      let modelSettings = frozen?.modelSettings;
      if (!frozen) {
        const selected = imageSettings.selection();
        modelSettings = selected.provider === "codex" ? await generationContext({ signal }) : { ...selected, imageProvider: selected.provider };
        signal?.throwIfAborted();
        if (cliBusy()) throw bad("Agent CLI 正在安装或更新，请等待完成。", 409);
        if (agents.busy) throw bad("正在验证模型，请稍候", 409);
      }
      validateGenerationSize(body, modelSettings);
      // An accepted snapshot, including legacy dimensions, is execution intent.
      const sizeSnapshot = frozen ? frozen.sizeSnapshot : generationSizeSnapshot(modelSettings, body.imageSize);
      return { modelSettings, sizeSnapshot };
    },
    async check(modelSettings, signal) {
      if (modelSettings.imageProvider === "magpie") {
        const catalog = await magpieInspector({ baseUrl: modelSettings.baseUrl, signal });
        signal?.throwIfAborted();
        if (!catalog.models.some(item => item.id === modelSettings.model)) throw bad("Magpie 生图模型已不可用，请在生图设置刷新目录并重新选择。", 409);
      }
      if (modelSettings.imageProvider) return;
      await requireFeature("generation");
    },
    restoreBatch(batch, modelSettings) {
      const sizeSnapshot = modelSettings.imageProvider === "magpie" ? {
        ...(batch.imageSize ? { imageSize: { ...batch.imageSize } } : {}),
        submittedImageSize: batch.sizeRule ? structuredClone(batch.submittedImageSize) : batch.imageSize || null,
        ...(batch.sizeRule ? { sizeRule: batch.sizeRule } : {}),
      } : undefined;
      if (["openai", "gemini"].includes(modelSettings.imageProvider) && !modelSettings.apiKey) throw bad("批次生图凭据快照已失效，请重新提交", 409);
      return { modelSettings, sizeSnapshot };
    },
  };
}
