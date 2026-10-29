import type { Logger, Universal } from "koishi";
import {
  isMessage,
  type AgentMessageOf,
  type ChannelInput,
  type Message,
  type WillDebug,
  type WillState,
  type WillEngine,
  type WillObservation,
} from "koishi-plugin-aka-yesimbot";

import { hasImage, hasQuote, mentionKind, quotedIds } from "./message-context.js";
import type { PolicyWillingnessConfig } from "./types.js";

const DIRECT_CHANNEL_TYPE = 1 satisfies Universal.Channel.Type;

export class PolicyWillingnessEngine implements WillEngine {
  private score = 0;
  private lastMessageAt: number | null = null;
  private lastDecayAt: number | null = null;
  /** Platform IDs of messages this bot sent, so quotes of them can be told apart from other quotes. */
  private readonly ownIds = new Set<string>();
  private readonly ownIdOrder: string[] = [];

  public constructor(
    private readonly config: PolicyWillingnessConfig,
    private readonly logger: Logger,
  ) {
    this.score = config.initialScore;
  }

  public async decide(input: ChannelInput, _state: WillState): Promise<"wait" | "trigger"> {
    if (!isMessage(input)) {
      return isPokeEvent(input) ? this.decidePoke(input) : "wait";
    }
    if (this.config.ignoredUserIds.includes(input.data.user.id)) {
      return "wait";
    }

    const now = Date.now();
    const decayed =
      this.lastDecayAt === null || this.lastMessageAt === null ? this.score : decayScore(this.score, this.lastDecayAt, this.lastMessageAt, now, this.config);
    const next = calculateScore(decayed, input.data, this.config);
    const probability = calculateProbability(next, this.config);

    this.score = next;
    this.lastMessageAt = now;
    this.lastDecayAt = now;

    const forced = shouldForce(input.data, this.config, (id) => this.ownIds.has(id));
    const decision: "wait" | "trigger" = forced || Math.random() < probability ? "trigger" : "wait";
    this.logger.debug("will_policy.willingness", {
      messageId: input.id,
      channelId: input.data.channel.id,
      previousScore: decayed,
      score: next,
      probability,
      decision,
      forced,
    });
    return decision;
  }

  private decidePoke(input: AgentMessageOf<"yesimbot.event">): "wait" | "trigger" {
    const now = Date.now();
    const decayed =
      this.lastDecayAt === null || this.lastMessageAt === null ? this.score : decayScore(this.score, this.lastDecayAt, this.lastMessageAt, now, this.config);
    const next = addGain(decayed, this.config.pokeGain, this.config);
    const probability = calculateProbability(next, this.config);

    this.score = next;
    this.lastMessageAt = now;
    this.lastDecayAt = now;

    const decision: "wait" | "trigger" = Math.random() < probability ? "trigger" : "wait";
    this.logger.debug("will_policy.willingness", { messageId: input.id, channelId: input.data.channel.id, score: next, probability, decision, forced: true });
    return decision;
  }

  public async observe(result: WillObservation): Promise<void> {
    const sent = result.sentMessageIds;
    for (const id of sent ?? []) this.rememberOwn(id);
    // Runtimes that predate sentMessageIds report nothing; keep charging once per turn for them.
    const count = sent === undefined ? 1 : sent.length;
    const cost = this.config.replyCost * count;
    this.score = Math.max(0, this.score - cost);
    this.logger.debug("will_policy.reply_cost", { score: this.score, replyCost: this.config.replyCost, sent: count, cost });
  }

  /** Records a message the bot delivered outside of `observe`, e.g. from the delivered event. */
  public rememberOwn(id: string): void {
    if (!id || this.ownIds.has(id)) return;
    this.ownIds.add(id);
    this.ownIdOrder.push(id);
    if (this.ownIdOrder.length > 500) this.ownIds.delete(this.ownIdOrder.shift()!);
  }

  public getCurrentWillingness(): number {
    return this.score;
  }

  public debug(): WillDebug {
    return {
      engine: "willingness",
      score: this.score,
      probability: calculateProbability(this.score, this.config),
      config: this.config as unknown as Record<string, unknown>,
    };
  }
}

function decayScore(score: number, lastDecayAt: number, lastMessageAt: number, now: number, config: PolicyWillingnessConfig): number {
  if (now < lastDecayAt) return score;
  const weightedSeconds = weightedSilenceSeconds(lastDecayAt, lastMessageAt, now, config);
  const decayed =
    score > config.probabilityThreshold && config.probabilityThreshold > 0
      ? decayHighScore(score, weightedSeconds, config.probabilityThreshold, config.decayHalfLifeSeconds)
      : score * 0.5 ** (weightedSeconds / config.decayHalfLifeSeconds);
  return decayed < 0.01 ? 0 : Math.max(0, decayed);
}

function weightedSilenceSeconds(lastDecayAt: number, lastMessageAt: number, now: number, config: PolicyWillingnessConfig): number {
  const hotEnd = lastMessageAt + config.hotWindowSeconds * 1_000;
  const warmEnd = lastMessageAt + config.warmWindowSeconds * 1_000;
  const overlap = (start: number, end: number) => Math.max(0, Math.min(now, end) - Math.max(lastDecayAt, start)) / 1_000;
  return (
    overlap(lastMessageAt, hotEnd) * config.hotDecayWeight +
    overlap(hotEnd, warmEnd) * config.warmDecayWeight +
    Math.max(0, now - Math.max(lastDecayAt, warmEnd)) / 1_000
  );
}

function decayHighScore(score: number, weightedSeconds: number, threshold: number, halfLife: number): number {
  const weightedSecondsToThreshold = 2 * halfLife * Math.log2(score / threshold);
  if (weightedSeconds <= weightedSecondsToThreshold) {
    return score * 0.5 ** ((0.5 * weightedSeconds) / halfLife);
  }
  return threshold * 0.5 ** ((weightedSeconds - weightedSecondsToThreshold) / halfLife);
}

function calculateScore(current: number, data: Message, config: PolicyWillingnessConfig): number {
  const attributes =
    (mentionKind(data.selfId, data.elements) === "none" ? 0 : config.mentionGain) +
    (hasQuote(data.elements) ? config.quoteGain : 0) +
    (hasImage(data.elements) ? config.imageGain : 0) +
    (data.channel.type === DIRECT_CHANNEL_TYPE ? config.directGain : 0);
  const multiplier = hasKeyword(data.elements, config.keywords) ? config.keywordMultiplier : config.defaultMultiplier;
  const ratio = current / config.maxScore;
  const marginalGain = Math.max(0, 1 - ratio ** 2);
  const gain = (config.textGain + attributes) * multiplier * marginalGain * dynamicGainMultiplier(ratio);
  return Math.min(config.maxScore, Math.max(0, current + gain));
}

function addGain(current: number, rawGain: number, config: PolicyWillingnessConfig): number {
  const ratio = current / config.maxScore;
  const gain = rawGain * Math.max(0, 1 - ratio ** 2) * dynamicGainMultiplier(ratio);
  return Math.min(config.maxScore, Math.max(0, current + gain));
}

function calculateProbability(score: number, config: PolicyWillingnessConfig): number {
  if (score <= config.probabilityThreshold) return 0;
  return Math.min(1, Math.max(0, (score - config.probabilityThreshold) * config.probabilityAmplifier));
}

function dynamicGainMultiplier(ratio: number): number {
  if (ratio < 0.2) return 1;
  if (ratio < 0.8) return Math.max(1, -(((ratio - 0.5) * 2) ** 2) + 2);
  return 1 - (ratio - 0.8) / 0.2;
}

function hasKeyword(elements: readonly unknown[] | undefined, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return false;
  const text = elements
    ?.flatMap((element) => {
      if (element && typeof element === "object" && "attrs" in element) {
        const attrs = (element as { attrs?: Record<string, unknown> }).attrs;
        return typeof attrs?.content === "string" ? [attrs.content] : [];
      }
      return [];
    })
    .join("");
  return keywords.some((keyword) => matchesKeyword(text ?? "", keyword));
}

const ASCII_WORD = /^[\x21-\x7e ]+$/;

function isAsciiWord(char: string | undefined): boolean {
  return char !== undefined && /[a-z0-9_]/.test(char);
}

/**
 * `/pattern/flags` is a regular expression. A keyword made only of ASCII must stand as a whole
 * word, so "ai" does not hit "said". Other keywords (Chinese has no word boundaries) still match
 * as substrings; prefer longer phrases for them.
 */
export function matchesKeyword(text: string, keyword: string): boolean {
  if (!keyword) return false;
  const regex = /^\/(.+)\/([a-z]*)$/.exec(keyword);
  if (regex) {
    try {
      return new RegExp(regex[1]!, regex[2]).test(text);
    } catch {
      return false;
    }
  }
  if (!ASCII_WORD.test(keyword)) return text.includes(keyword);
  const haystack = text.toLowerCase();
  const needle = keyword.toLowerCase();
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + 1)) {
    const before = haystack[index - 1];
    const after = haystack[index + needle.length];
    if (!isAsciiWord(before) && !isAsciiWord(after)) return true;
  }
  return false;
}

function shouldForce(data: Message, config: PolicyWillingnessConfig, isOwn: (id: string) => boolean): boolean {
  if (config.directForce && data.channel.type === DIRECT_CHANNEL_TYPE) return true;
  if (config.mentionForce && mentionKind(data.selfId, data.elements) !== "none") return true;
  return config.quoteForce && quotedIds(data.elements).some(isOwn);
}

function isPokeEvent(input: AgentMessageOf<"yesimbot.event">): boolean {
  return input.role === "custom" && input.type === "yesimbot.event" && (input.data as { eventType?: string }).eventType === "notice.poke";
}
