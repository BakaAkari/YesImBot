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
import { ChannelHistory, renderElements } from "./history.js";
import { mentionKind, quotedIds } from "./message-context.js";
import { rule, type SpeakRuling } from "./rules.js";
import type { PolicySemanticConfig } from "./types.js";
import type { PolicyWillingnessEngine } from "./willingness.js";

const DIRECT_CHANNEL_TYPE = 1 satisfies Universal.Channel.Type;

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
  private lastRuling?: SpeakRuling & { verdict?: GateVerdict; at: number };

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

  public async decide(input: ChannelInput, state: WillState): Promise<"wait" | "trigger"> {
    // The willingness engine keeps scoring every input: it decides in shadow mode and is the fallback in active mode.
    const fallback = await this.inner.decide(input, state);
    if (!isMessage(input)) return fallback;

    const data = input.data;
    const now = Date.now();
    this.selfId = data.selfId;
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
    this.arm(now);
    return this.config.mode === "active" ? "wait" : fallback;
  }

  public async observe(result: WillObservation): Promise<void> {
    await this.inner.observe(result);
    this.history.recordSelfTurn(result.sentMessageIds ?? [], Date.now());
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

    if (!verdict) {
      const ruling: SpeakRuling = { speak: fallbackPending, reason: "gate_failed_fallback" };
      this.lastRuling = { ...ruling, at: now };
      this.logger.warn("will_policy.semantic.gate_failed", { mode: this.config.mode, latencyMs, fallback: fallbackPending });
      if (ruling.speak) await this.wake(ruling);
      return ruling;
    }

    const focus = history.find((entry) => entry.messageId === verdict.focusMessageId) ?? [...history].reverse().find((entry) => !entry.self);
    const ruling = rule(
      verdict,
      {
        now,
        lastSelfAt: this.history.lastSelfAt(),
        focusAgeMs: focus ? now - focus.timestamp : 0,
        share: this.history.share(now),
      },
      this.config,
    );
    this.lastRuling = { ...ruling, verdict, at: now };
    this.logger.info("will_policy.semantic", {
      mode: this.config.mode,
      speak: ruling.speak,
      reason: ruling.reason,
      latencyMs,
      addressed: verdict.addressed,
      others: verdict.others,
      openQuestion: verdict.openQuestion,
      interest: verdict.interest,
      complete: verdict.complete,
      mood: verdict.mood,
      focus: verdict.focusMessageId,
    });

    if (ruling.recheckInMs !== undefined) this.arm(Date.now(), ruling.recheckInMs);
    if (ruling.speak) await this.wake(ruling, verdict);
    return ruling;
  }

  private async ask(history: ReturnType<ChannelHistory["recent"]>, now: number): Promise<GateVerdict | undefined> {
    const prompt = buildGatePrompt({
      selfName: this.selfName(),
      selfId: this.selfId,
      persona: this.config.persona,
      interests: this.config.interests,
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

  private async wake(ruling: SpeakRuling, verdict?: GateVerdict): Promise<void> {
    if (this.config.mode !== "active" || !this.api) return;
    const started = await this.api.wake({
      reason: `semantic:${ruling.reason}`,
      debug: { engine: "semantic", detail: { reason: ruling.reason, ...(verdict ? { verdict } : {}) } },
    });
    this.logger.debug("will_policy.semantic.wake", { reason: ruling.reason, started });
  }
}

export { rule, type RulingContext, type SpeakRuling } from "./rules.js";
