import type { Element } from "koishi";

/** One line of channel history as the semantic gate sees it. */
export interface HistoryEntry {
  readonly messageId: string;
  readonly userId: string;
  readonly name: string;
  readonly text: string;
  readonly timestamp: number;
  readonly self: boolean;
  /** Sender is on the ignore list (another bot); shown for context, never acted on. */
  readonly ignored: boolean;
}

/**
 * Recent messages of one channel plus the counters the semantic engine needs:
 * which platform messages are the bot's own (to recognise quotes of them) and how much
 * humans and the bot have said lately (to keep the bot's share near a normal member's).
 */
export class ChannelHistory {
  private readonly entries: HistoryEntry[] = [];
  private readonly ownIds = new Set<string>();
  private readonly ownIdOrder: string[] = [];
  /** Timestamps of human messages, for the share window. */
  private readonly humanAt: Array<{ at: number; userId: string }> = [];
  /** Timestamps of bot turns that actually said something. */
  private readonly selfTurnAt: number[] = [];

  public constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  public addHuman(entry: Omit<HistoryEntry, "self">): void {
    this.push({ ...entry, self: false });
    if (!entry.ignored) this.humanAt.push({ at: entry.timestamp, userId: entry.userId });
    this.prune(entry.timestamp);
  }

  public addSelf(messageId: string, text: string, timestamp: number): void {
    this.rememberOwn(messageId);
    this.push({ messageId, userId: "", name: "", text, timestamp, self: true, ignored: false });
  }

  public recordSelfTurn(messageIds: readonly string[], timestamp: number): void {
    for (const id of messageIds) this.rememberOwn(id);
    if (messageIds.length > 0) this.selfTurnAt.push(timestamp);
    this.prune(timestamp);
  }

  public isOwn(messageId: string): boolean {
    return this.ownIds.has(messageId);
  }

  public recent(count: number): readonly HistoryEntry[] {
    return this.entries.slice(-count);
  }

  public lastSelfAt(): number | undefined {
    return this.selfTurnAt.at(-1);
  }

  /** Human messages and bot speaking turns inside the share window ending at `now`. */
  public share(now: number): { human: number; self: number; topHuman: number } {
    this.prune(now);
    const perUser = new Map<string, number>();
    for (const { userId } of this.humanAt) perUser.set(userId, (perUser.get(userId) ?? 0) + 1);
    return { human: this.humanAt.length, self: this.selfTurnAt.length, topHuman: Math.max(0, ...perUser.values()) };
  }

  private push(entry: HistoryEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }

  private rememberOwn(id: string): void {
    if (!id || this.ownIds.has(id)) return;
    this.ownIds.add(id);
    this.ownIdOrder.push(id);
    if (this.ownIdOrder.length > 500) this.ownIds.delete(this.ownIdOrder.shift()!);
  }

  private prune(now: number): void {
    const since = now - this.windowMs;
    while (this.humanAt.length > 0 && this.humanAt[0]!.at < since) this.humanAt.shift();
    while (this.selfTurnAt.length > 0 && this.selfTurnAt[0]! < since) this.selfTurnAt.shift();
  }
}

/** Flattens message elements into the short plain text the gate reads. */
export function renderElements(elements: readonly Element[] | undefined, selfId: string, selfName: string, isOwn: (id: string) => boolean): string {
  const parts: string[] = [];
  for (const element of elements ?? []) {
    const attrs = (element.attrs ?? {}) as Record<string, unknown>;
    switch (element.type) {
      case "text":
        if (typeof attrs.content === "string") parts.push(attrs.content);
        break;
      case "at": {
        const type = String(attrs.type ?? "");
        if (type === "all") parts.push("@全体成员");
        else if (type === "here") parts.push("@在线成员");
        else if (String(attrs.id) === selfId) parts.push(`@${selfName}`);
        else parts.push(`@${typeof attrs.name === "string" && attrs.name ? attrs.name : String(attrs.id ?? "某人")}`);
        break;
      }
      case "quote":
      case "reply": {
        const id = String(attrs.id ?? "");
        parts.push(isOwn(id) ? `[回复${selfName}的消息]` : "[回复某条消息]");
        break;
      }
      case "img":
      case "image":
        parts.push("[图片]");
        break;
      case "face":
      case "mface":
        parts.push("[表情]");
        break;
      case "audio":
      case "record":
        parts.push("[语音]");
        break;
      case "video":
        parts.push("[视频]");
        break;
      case "file":
        parts.push("[文件]");
        break;
      case "forward":
        parts.push("[合并转发]");
        break;
      default:
        break;
    }
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}
