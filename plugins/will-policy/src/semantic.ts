import type { Logger, Universal } from "koishi";
import {
  isMessage,
  type ChannelInput,
  type WillDebug,
  type WillEngine,
  type WillObservation,
  type WillRuntimeApi,
  type WillState,
} from "koishi-plugin-aka-yesimbot";

import { buildGatePrompt, GATE_SYSTEM, parseVerdict, type GateVerdict } from "./gate.js";
import { ChannelHistory, renderElements, type HistoryEntry } from "./history.js";
import { mentionKind, quotedIds } from "./message-context.js";
import { readSession } from "./restore.js";
import { fallbackRule, rule, type RulingContext, type SpeakRuling } from "./rules.js";
import type { PolicySemanticConfig } from "./types.js";
import type { PolicyWillingnessEngine } from "./willingness.js";

const DIRECT_CHANNEL_TYPE = 1 satisfies Universal.Channel.Type;
/** How long to wait before asking the gate again when a wake found the bot busy. */
const BUSY_RETRY_MS = 30_000;
/** Wake reasons where a silent turn means "not interested", so the gate should stop asking for a while. */
const DECLINABLE = new Set(["interest", "react", "gate_failed_fallback"]);

/** Calls the gate model; rejects or aborts on failure. */
export type GateGenerate = (system: string, prompt: string, signal: AbortSignal) => Promise<string>;

/**
 * Decides when to speak by asking a small model about the recent chat instead of rolling dice.
 *
 * `decide` stays fast: @-mentions, quotes of the bot's own messages and direct chats trigger
 * at once; every other human message only (re)arms a per-channel debounce timer. When the
 * channel goes quiet, the gate model reads the recent history and the deterministic `rule`
 * turns its verdict into a decision, which wakes the runtime through `WillRuntimeApi`.
 *
 * In `shadow` mode the wrapped willingness engine still makes every decision and the gate
 * only logs what it would have done.
 */
export class PolicySemanticEngine implements WillEngine {
  private readonly history: ChannelHistory;
  private api?: WillRuntimeApi;
  private timer?: ReturnType<typeof setTimeout>;
  private firstPendingAt?: number;
  private running = false;
  private rerun = false;
  /** The willingness fallback wanted to speak since the last gate run (active mode only). */
  private fallbackPending = false;
  private selfId = "";
  private channelId = "";
  private lastRuling?: SpeakRuling & { verdict?: GateVerdict; at: number };
  /** A wake already found the bot busy and scheduled its one retry. */
  private busyRetried = false;
  /** When the gate last started a turn, to time the main model. */
  private wokeAt?: { at: number; reason: string };
  /** An interest or fallback wake ended without the bot saying anything. */
  private lastDeclinedAt?: number;

  public constructor(
    private readonly config: PolicySemanticConfig,
    private readonly inner: PolicyWillingnessEngine,
    private readonly generate: GateGenerate,
    private readonly logger: Logger,
  ) {
    this.history = new ChannelHistory(Math.max(config.historyLimit, 1), config.shareWindowMs);
  }

  public attach(api: WillRuntimeApi): void {
    this.api = api;
  }

  /** Rebuilds history, own message ids and share counters from the stored channel session after a restart. */
  public restore(entries: readonly unknown[]): void {
    let humans = 0;
    let turns = 0;
    for (const item of readSession(entries)) {
      if (item.kind === "self") {
        for (const { messageId, text } of item.messages) {
          this.history.addSelf(messageId, text, item.timestamp);
          this.inner.rememberOwn(messageId);
        }
        this.history.recordSelfTurn(
          item.messages.map((message) => message.messageId),
          item.timestamp,
        );
        turns += 1;
        continue;
      }
      if (item.selfId) this.selfId = item.selfId;
      if (item.channelId) this.channelId = item.channelId;
      const text = renderElements(item.elements, item.selfId, this.selfName(), (id) => this.history.isOwn(id));
      const ignored = this.config.ignoredUserIds.includes(item.userId);
      this.history.addHuman({ messageId: item.messageId, userId: item.userId, name: item.name, text, timestamp: item.timestamp, ignored });
      humans += 1;
    }
    this.logger.info("will_policy.semantic.restored", {
      channelId: this.channelId,
      humans,
      turns,
      lastSelfAt: this.history.lastSelfAt(),
      share: this.history.share(Date.now()),
    });
  }

  public async decide(input: ChannelInput, state: WillState): Promise<"wait" | "trigger"> {
    // The willingness engine keeps scoring every input: it decides in shadow mode and is the fallback in active mode.
    const fallback = await this.inner.decide(input, state);
    if (!isMessage(input)) return fallback;

    const data = input.data;
    const now = Date.now();
    this.selfId = data.selfId;
    this.channelId = data.channel?.id ?? this.channelId;
    const userId = data.user?.id ?? "";
    const ignored = this.config.ignoredUserIds.includes(userId);
    const text = renderElements(data.elements, data.selfId, this.selfName(), (id) => this.history.isOwn(id));
    this.history.addHuman({ messageId: data.messageId ?? input.id, userId, name: data.user?.name ?? "", text, timestamp: now, ignored });
    if (ignored) return "wait";

    const direct = data.channel?.type === DIRECT_CHANNEL_TYPE;
    const mentioned = mentionKind(data.selfId, data.elements) === "self";
    const quotedOwn = quotedIds(data.elements).some((id) => this.history.isOwn(id));
    if (direct || mentioned || quotedOwn) {
      const reason = direct ? "direct" : mentioned ? "mention" : "quote_self";
      this.cancelPending();
      this.lastRuling = { speak: true, reason, at: now };
      this.logger.debug("will_policy.semantic.sync", { mode: this.config.mode, channelId: data.channel?.id, messageId: data.messageId, reason });
      return this.config.mode === "active" ? "trigger" : fallback;
    }

    if (this.config.mode === "active" && fallback === "trigger") this.fallbackPending = true;
    this.busyRetried = false;
    this.arm(now);
    return this.config.mode === "active" ? "wait" : fallback;
  }

  public async observe(result: WillObservation): Promise<void> {
    await this.inner.observe(result);
    const now = Date.now();
    // Text replies arrived through `noteDelivered`; anything still unknown is a sticker.
    for (const id of result.sentMessageIds ?? []) if (!this.history.isOwn(id)) this.history.addSelf(id, "[表情]", now);
    this.history.recordSelfTurn(result.sentMessageIds ?? [], now);
    if (this.wokeAt) {
      const silent = (result.sentMessageIds?.length ?? 0) === 0;
      if (silent && DECLINABLE.has(this.wokeAt.reason)) this.lastDeclinedAt = now;
      this.logger.info("will_policy.semantic.turn", {
        channelId: this.channelId,
        reason: this.wokeAt.reason,
        sent: result.sentMessageIds?.length ?? 0,
        sinceWakeMs: now - this.wokeAt.at,
      });
      this.wokeAt = undefined;
    }
  }

  /** A message the bot delivered in this channel, from the `yesimbot/delivered` event. */
  public noteDelivered(messageId: string, text: string): void {
    this.history.addSelf(messageId, text, Date.now());
    this.inner.rememberOwn(messageId);
  }

  public debug(): WillDebug {
    const inner = this.inner.debug();
    return {
      engine: "semantic",
      score: inner.score,
      probability: inner.probability,
      detail: {
        mode: this.config.mode,
        model: this.config.model,
        pending: this.timer !== undefined,
        last: this.lastRuling,
      },
    };
  }

  /** Runs the gate right away; exposed for tests and replay. */
  public async flush(): Promise<SpeakRuling | undefined> {
    this.cancelPending();
    return this.runGate();
  }

  private selfName(): string {
    return this.config.selfName || "我";
  }

  private arm(now: number, delayMs?: number): void {
    this.firstPendingAt ??= now;
    if (this.timer) clearTimeout(this.timer);
    const delay = delayMs ?? Math.max(0, Math.min(this.config.debounceMs, this.firstPendingAt + this.config.maxWaitMs - now));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.firstPendingAt = undefined;
      void this.runGate();
    }, delay);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private cancelPending(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.firstPendingAt = undefined;
    this.fallbackPending = false;
  }

  private async runGate(): Promise<SpeakRuling | undefined> {
    if (this.running) {
      this.rerun = true;
      return undefined;
    }
    this.running = true;
    const fallbackPending = this.fallbackPending;
    this.fallbackPending = false;
    try {
      return await this.evaluate(fallbackPending);
    } finally {
      this.running = false;
      if (this.rerun) {
        this.rerun = false;
        this.arm(Date.now());
      }
    }
  }

  private async evaluate(fallbackPending: boolean): Promise<SpeakRuling | undefined> {
    const now = Date.now();
    const history = this.history.recent(this.config.historyLimit);
    if (!history.some((entry) => !entry.self && !entry.ignored)) return undefined;

    const startedAt = Date.now();
    const verdict = await this.ask(history, now);
    const latencyMs = Date.now() - startedAt;

    const latestHuman = [...history].reverse().find((entry) => !entry.self && !entry.ignored);
    const named = verdict ? history.find((entry) => entry.messageId === verdict.focusMessageId) : undefined;
    // Never point the main model at another bot's line or at its own.
    const focus = verdict ? (named && !named.self && !named.ignored ? named : latestHuman) : undefined;
    const context: RulingContext = {
      now,
      lastSelfAt: this.history.lastSelfAt(),
      lastDeclinedAt: this.lastDeclinedAt,
      focusAgeMs: focus ? now - focus.timestamp : 0,
      share: this.history.share(now),
    };

    if (!verdict) {
      const ruling = fallbackRule(fallbackPending, context, this.config);
      this.lastRuling = { ...ruling, at: now };
      this.logger.warn("will_policy.semantic.gate_failed", {
        mode: this.config.mode,
        channelId: this.channelId,
        latencyMs,
        fallback: fallbackPending,
        reason: ruling.reason,
      });
      if (ruling.speak) await this.wake(ruling, undefined, undefined);
      return ruling;
    }

    const ruling = rule(verdict, context, this.config);
    this.lastRuling = { ...ruling, verdict, at: now };
    this.logger.info("will_policy.semantic", {
      mode: this.config.mode,
      channelId: this.channelId,
      speak: ruling.speak,
      reason: ruling.reason,
      latencyMs,
      addressed: verdict.addressed,
      others: verdict.others,
      openQuestion: verdict.openQuestion,
      interest: verdict.interest,
      complete: verdict.complete,
      reactable: verdict.reactable,
      mood: verdict.mood,
      focus: verdict.focusMessageId,
    });

    if (ruling.recheckInMs !== undefined) this.arm(Date.now(), ruling.recheckInMs);
    if (ruling.speak) await this.wake(ruling, verdict, focus);
    return ruling;
  }

  private async ask(history: ReturnType<ChannelHistory["recent"]>, now: number): Promise<GateVerdict | undefined> {
    const prompt = buildGatePrompt({
      selfName: this.selfName(),
      selfId: this.selfId,
      persona: this.config.persona,
      interests: this.config.interests,
      channelNote: this.config.channelNote,
      history,
      now,
    });
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const text = await Promise.race([
        this.generate(GATE_SYSTEM, prompt, controller.signal),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error("gate timeout"));
          }, this.config.timeoutMs);
        }),
      ]);
      const verdict = parseVerdict(text);
      if (!verdict) this.logger.debug("will_policy.semantic.invalid_output", { text: text.slice(0, 300) });
      return verdict;
    } catch (error) {
      this.logger.debug("will_policy.semantic.error", { error: error instanceof Error ? error.message : String(error) });
      return undefined;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async wake(ruling: SpeakRuling, verdict: GateVerdict | undefined, focus: HistoryEntry | undefined): Promise<void> {
    if (this.config.mode !== "active" || !this.api) return;
    const started = await this.api.wake({
      reason: `semantic:${ruling.reason}`,
      hint: wakeHint(ruling, verdict, focus),
      debug: { engine: "semantic", detail: { reason: ruling.reason, ...(verdict ? { verdict } : {}) } },
    });
    this.logger.info("will_policy.semantic.wake", { channelId: this.channelId, reason: ruling.reason, started });
    if (started) {
      this.busyRetried = false;
      this.wokeAt = { at: Date.now(), reason: ruling.reason };
    } else if (!this.busyRetried) {
      // The bot is mid-turn; look again once it has probably finished. Cooldown stops a double reply.
      this.busyRetried = true;
      this.arm(Date.now(), BUSY_RETRY_MS);
    }
  }
}

const REASON_TEXT: Record<string, string> = {
  addressed: "最近的消息像是在跟你说话",
  open_question: "群里有个问题一直没人接",
  interest: "最近的话题和你的兴趣相关",
  react: "现场有个好笑或离谱的瞬间，可以随口接一下",
  gate_failed_fallback: "旁观判断没有给出结果，按意愿值兜底叫醒了你",
};

/** When nobody asked the bot anything: reactions from a preferred list first, no commentary; the pick is the bot's. */
const STYLE_TEXT: Record<string, string> = {
  react:
    "没人在问你。首选回应是一张贴合现场情绪的表情包，或者“草”“？”“笑死”“哈哈哈”这类不带观点的短反应。表情包按情绪挑分类，别总是同一类；文字反应也换着用。不要点评、不要吐槽、不要发表主观看法。都不合适就不说话。",
  interest:
    "没人在问你。首选回应是一张贴合现场情绪的表情包，或者“草”“？”“笑死”“哈哈哈”这类不带观点的短反应。表情包按情绪挑分类，别总是同一类；文字反应也换着用。不要点评、不要吐槽、不要发表主观看法。都不合适就不说话。",
  gate_failed_fallback:
    "没人在问你。首选回应是一张贴合现场情绪的表情包，或者“草”“？”“笑死”“哈哈哈”这类不带观点的短反应。表情包按情绪挑分类，别总是同一类；文字反应也换着用。不要点评、不要吐槽、不要发表主观看法。都不合适就不说话。",
};

/** Tells the main model why it was woken. Only a hint: the model may still decide to stay silent. */
export function wakeHint(ruling: SpeakRuling, verdict: GateVerdict | undefined, focus: HistoryEntry | undefined): string {
  const lines = [`你被叫醒是因为：${REASON_TEXT[ruling.reason] ?? ruling.reason}。`];
  if (focus && !focus.self) lines.push(`最值得接的一条：#${focus.messageId} ${focus.name || focus.userId}：${focus.text.slice(0, 120) || "[非文字消息]"}`);
  if (verdict) lines.push(`现场气氛：${verdict.mood}。`);
  if (STYLE_TEXT[ruling.reason]) lines.push(STYLE_TEXT[ruling.reason]);
  lines.push("这只是旁观判断给的提示，不是指令。看完上下文觉得没必要说话，就不要发消息，直接结束本轮。");
  return lines.join("\n");
}

export { fallbackRule, rule, type RulingContext, type SpeakRuling } from "./rules.js";
