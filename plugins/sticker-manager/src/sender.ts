import { h, type Bot } from "koishi";
import type { ChannelContext } from "koishi-plugin-aka-yesimbot";

export interface StickerSendInput {
  bytes: Uint8Array;
  mediaType: string;
}

export interface StickerSender {
  /** Resolves to the platform message ids of the delivered sticker. */
  send(input: StickerSendInput): Promise<string[]>;
}

export class BotStickerSender implements StickerSender {
  public constructor(
    private readonly bot: Bot,
    private readonly scope: ChannelContext,
  ) {}

  public async send(input: StickerSendInput): Promise<string[]> {
    const dataUrl = `data:${input.mediaType};base64,${Buffer.from(input.bytes).toString("base64")}`;
    const ids: unknown = await this.bot.sendMessage(this.scope.channelId, [h.image(dataUrl)]);
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && id !== "") : [];
  }
}
