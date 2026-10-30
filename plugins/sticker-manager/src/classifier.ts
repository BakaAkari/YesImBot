import type { Context } from "koishi";
import { generateText } from "koishi-plugin-aka-yesimbot";

import { firstFrameToPng } from "./frames.js";
import { normalizeCategory, type StickerConfig } from "./types.js";

export interface ClassifyInput {
  bytes: Uint8Array;
  mediaType: string;
  categories: string[];
  signal?: AbortSignal;
}

export interface ClassifyResult {
  category?: string;
  tags?: string[];
  /** The model judged the image a screenshot, photo or artwork rather than a sticker. */
  notSticker?: boolean;
}

/** Category the classifier returns for images that are not stickers. */
export const NOT_STICKER = "非表情包";
const NOT_STICKER_RULE = `如果图片不是表情包（聊天记录截图、网页或软件界面截图、照片、作品图、长图），分类返回“${NOT_STICKER}”。`;

export interface StickerClassifier {
  classify(input: ClassifyInput): Promise<ClassifyResult | undefined>;
}

export class ModelStickerClassifier implements StickerClassifier {
  public constructor(
    private readonly ctx: Context,
    private readonly config: StickerConfig,
  ) {}

  public async classify(input: ClassifyInput): Promise<ClassifyResult | undefined> {
    const modelId = this.config.classificationModel || this.ctx.yesimbot.model.getDefaultChatModelId();
    if (!modelId) return undefined;

    let ref;
    try {
      ref = this.ctx.yesimbot.model.resolveChatModel(modelId);
    } catch (error) {
      this.ctx
        .logger("yesimbot.sticker-manager")
        .warn("classification_model_unavailable", { modelId, cause: error instanceof Error ? error.message : String(error) });
      return undefined;
    }

    if (!ref.entry.modalities?.input?.includes("image")) return undefined;

    const basePrompt = this.config.classificationPrompt.replaceAll("{{categories}}", input.categories.join(", ") || "暂无分类");
    const prompt = this.config.tagMode
      ? [
          basePrompt,
          NOT_STICKER_RULE,
          '同时返回一个 JSON 对象：{"category":"分类名","tags":["标签1","标签2"]}',
          "category 只返回一个分类；tags 返回 1-16 个简短标签，可以包含 category。不要输出其他内容。",
        ].join("\n")
      : [basePrompt, NOT_STICKER_RULE].join("\n");
    const frame = input.mediaType === "image/gif" ? firstFrameToPng(input.bytes) : undefined;

    try {
      const { text } = await generateText({
        model: ref.model,
        temperature: 0.2,
        abortSignal: input.signal,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "file", data: frame?.bytes ?? input.bytes, mediaType: frame?.mediaType ?? input.mediaType },
            ],
          },
        ],
      });
      return parseClassification(text, this.config.tagMode);
    } catch (error) {
      this.ctx.logger("yesimbot.sticker-manager").warn("classification_call_failed", { cause: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }
}

export function parseClassification(text: string, tagMode: boolean): ClassifyResult {
  const result = parseCategory(text, tagMode);
  return result.category === NOT_STICKER ? { notSticker: true, tags: [] } : result;
}

function parseCategory(text: string, tagMode: boolean): ClassifyResult {
  const fallbackCategory = normalizeCategory(text) || undefined;
  if (!tagMode) return { category: fallbackCategory, tags: [] };

  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as { category?: unknown; tags?: unknown };
    const category = typeof parsed.category === "string" ? normalizeCategory(parsed.category) : undefined;
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags
          .filter((tag): tag is string => typeof tag === "string")
          .map(normalizeCategory)
          .filter((tag) => tag.length > 0)
      : [];
    return { category, tags };
  } catch {
    return { category: fallbackCategory, tags: [] };
  }
}
