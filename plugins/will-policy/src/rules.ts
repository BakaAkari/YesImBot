import type { GateVerdict } from "./gate.js";
import type { PolicySemanticConfig } from "./types.js";

export interface SpeakRuling {
  readonly speak: boolean;
  readonly reason: string;
  /** Ask again after this long, e.g. when an open question has not waited long enough. */
  readonly recheckInMs?: number;
}

export interface RulingContext {
  readonly now: number;
  readonly lastSelfAt: number | undefined;
  /** The last time an interest wake ended with the bot choosing not to speak. */
  readonly lastDeclinedAt?: number;
  readonly focusAgeMs: number;
  readonly share: { human: number; self: number; topHuman: number };
}

function inCooldown(context: RulingContext, config: PolicySemanticConfig): boolean {
  return context.lastSelfAt !== undefined && context.now - context.lastSelfAt < config.cooldownMs;
}

/** The bot recently looked at an interesting stretch and chose silence; respect that for a cooldown. */
function recentlyDeclined(context: RulingContext, config: PolicySemanticConfig): boolean {
  return context.lastDeclinedAt !== undefined && context.now - context.lastDeclinedAt < config.cooldownMs;
}

/** Big groups: stay near shareCap of human traffic. Small groups: never out-talk the most active human. */
function shareReached(context: RulingContext, config: PolicySemanticConfig): boolean {
  const { human, self, topHuman } = context.share;
  return self >= Math.max(1, Math.min(config.shareCap * human, topHuman));
}

/** When the gate fails, the willingness fallback may still speak, but only within cooldown and share. */
export function fallbackRule(fallbackPending: boolean, context: RulingContext, config: PolicySemanticConfig): SpeakRuling {
  if (!fallbackPending) return { speak: false, reason: "gate_failed" };
  if (inCooldown(context, config)) return { speak: false, reason: "gate_failed_cooldown" };
  if (recentlyDeclined(context, config)) return { speak: false, reason: "gate_failed_declined" };
  if (shareReached(context, config)) return { speak: false, reason: "gate_failed_share_cap" };
  return { speak: true, reason: "gate_failed_fallback" };
}

/** Deterministic speak rules over a gate verdict; no randomness. */
export function rule(verdict: GateVerdict, context: RulingContext, config: PolicySemanticConfig): SpeakRuling {
  if (verdict.addressed) return { speak: true, reason: "addressed" };
  if (!verdict.complete) return { speak: false, reason: "incomplete" };
  if (verdict.others) return { speak: false, reason: "others" };
  if (inCooldown(context, config)) return { speak: false, reason: "cooldown" };
  if (verdict.openQuestion) {
    if (context.focusAgeMs >= config.questionGraceMs) return { speak: true, reason: "open_question" };
    return { speak: false, reason: "question_grace", recheckInMs: config.questionGraceMs - context.focusAgeMs };
  }
  if (verdict.interest >= 2) {
    if (verdict.mood === "冲突") return { speak: false, reason: "conflict" };
    if (recentlyDeclined(context, config)) return { speak: false, reason: "declined" };
    if (shareReached(context, config)) return { speak: false, reason: "share_cap" };
    return { speak: true, reason: "interest" };
  }
  return { speak: false, reason: "not_interesting" };
}
