import type { Element } from "koishi";

/** A human message recovered from the channel session. */
export interface RestoredHuman {
  readonly kind: "human";
  readonly selfId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly userId: string;
  readonly name: string;
  readonly elements: readonly Element[];
  readonly timestamp: number;
}

/** One bot turn that delivered messages, recovered from `send_message` results. */
export interface RestoredSelfTurn {
  readonly kind: "self";
  readonly messages: Array<{ messageId: string; text: string }>;
  readonly timestamp: number;
}

export type RestoredItem = RestoredHuman | RestoredSelfTurn;

type Loose = Record<string, unknown>;

const isObject = (value: unknown): value is Loose => typeof value === "object" && value !== null;
const asString = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const asNumber = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/**
 * Walks stored session entries (oldest first) and recovers the chat the semantic engine saw:
 * human messages, and the bot's delivered messages grouped per turn. Every field is checked,
 * since the entries come from disk and may predate the current format.
 */
export function readSession(entries: readonly unknown[]): RestoredItem[] {
  const items: RestoredItem[] = [];
  const sendTexts = new Map<string, string[]>();
  const turns = new Map<string, RestoredSelfTurn>();

  for (const entry of entries) {
    if (!isObject(entry) || entry.type !== "message" || !isObject(entry.data)) continue;
    const message = entry.data;
    const timestamp = asNumber(message.timestamp) ?? asNumber(entry.timestamp) ?? 0;

    if (message.role === "custom" && message.type === "yesimbot.message" && isObject(message.data)) {
      const data = message.data;
      const user = isObject(data.user) ? data.user : {};
      const channel = isObject(data.channel) ? data.channel : {};
      items.push({
        kind: "human",
        selfId: asString(data.selfId) ?? "",
        channelId: asString(channel.id) ?? "",
        messageId: asString(data.messageId) ?? asString(message.id) ?? "",
        userId: asString(user.id) ?? "",
        name: asString(user.name) ?? "",
        elements: Array.isArray(data.elements) ? (data.elements as Element[]) : [],
        timestamp,
      });
      continue;
    }

    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isObject(part) || part.toolName !== "send_message") continue;
      const callId = asString(part.toolCallId) ?? "";
      if (part.type === "tool-call") {
        const input = isObject(part.input) ? part.input : {};
        sendTexts.set(callId, strings(input.messages));
        continue;
      }
      if (part.type !== "tool-result" || !isObject(part.output) || !isObject(part.output.value)) continue;
      const ids = strings(part.output.value.messageIds);
      if (ids.length === 0) continue;
      const texts = sendTexts.get(callId) ?? [];
      const turnKey = asString(entry.turnId) ?? callId;
      let turn = turns.get(turnKey);
      if (!turn) {
        turn = { kind: "self", messages: [], timestamp };
        turns.set(turnKey, turn);
        items.push(turn);
      }
      // A message may be split on delivery, so ids and texts do not always pair up.
      ids.forEach((messageId, index) => turn.messages.push({ messageId, text: texts[index] ?? (ids.length === 1 ? texts.join(" ") : "") }));
    }
  }
  return items;
}
