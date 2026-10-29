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
  readonly focusAgeMs: number;
  readonly share: { human: number; self: number; topHuman: number };
}

/** Deterministic speak rules over a gate verdict; no randomness. */
export function rule(verdict: GateVerdict, context: RulingContext, config: PolicySemanticConfig): SpeakRuling {
  if (verdict.addressed) return { speak: true, reason: "addressed" };
  if (!verdict.complete) return { speak: false, reason: "incomplete" };
  if (verdict.others) return { speak: false, reason: "others" };
  if (context.lastSelfAt !== undefined && context.now - context.lastSelfAt < config.cooldownMs) return { speak: false, reason: "cooldown" };
  if (verdict.openQuestion) {
    if (context.focusAgeMs >= config.questionGraceMs) return { speak: true, reason: "open_question" };
    return { speak: false, reason: "question_grace", recheckInMs: config.questionGraceMs - context.focusAgeMs };
  }
  if (verdict.interest >= 2) {
    if (verdict.mood === "冲突") return { speak: false, reason: "conflict" };
    const { human, self, topHuman } = context.share;
    // Big groups: stay near shareCap of human traffic. Small groups: never out-talk the most active human.
    const limit = Math.max(1, Math.min(config.shareCap * human, topHuman));
    if (self >= limit) return { speak: false, reason: "share_cap" };
    return { speak: true, reason: "interest" };
  }
  return { speak: false, reason: "not_interesting" };
}
