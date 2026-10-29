export type Decision = "wait" | "trigger";

export interface PolicyRoutingConfig {
  readonly direct: Decision;
  readonly mention: Decision;
  readonly mentionAll: Decision;
  readonly mentionHere: Decision;
  readonly quote: Decision;
  readonly image: Decision;
  readonly poke: Decision;
  readonly group: Decision;
}

export interface PolicyWillingnessConfig {
  readonly maxScore: number;
  readonly initialScore: number;
  readonly decayHalfLifeSeconds: number;
  readonly probabilityThreshold: number;
  readonly probabilityAmplifier: number;
  readonly replyCost: number;
  readonly textGain: number;
  readonly mentionGain: number;
  readonly quoteGain: number;
  readonly directGain: number;
  readonly imageGain: number;
  readonly pokeGain: number;
  readonly keywords: string[];
  readonly keywordMultiplier: number;
  readonly defaultMultiplier: number;
  readonly hotWindowSeconds: number;
  readonly warmWindowSeconds: number;
  readonly hotDecayWeight: number;
  readonly warmDecayWeight: number;
  readonly mentionForce: boolean;
  readonly quoteForce: boolean;
  readonly directForce: boolean;
  readonly ignoredUserIds: string[];
}

/** Per-group overrides for the semantic gate. */
export interface SemanticChannelConfig {
  readonly channelId: string;
  /** One or two sentences about the group's atmosphere, shown to the gate. */
  readonly note: string;
  /** Overrides `shareCap` for this group. */
  readonly shareCap?: number;
}

export interface PolicySemanticConfig {
  /** `shadow` runs the gate and logs it while willingness decides; `active` lets the gate decide. */
  readonly mode: "shadow" | "active";
  /** Full chat model id, e.g. `openai:gemini-3.5-flash-lite`. */
  readonly model: string;
  readonly selfName: string;
  readonly persona: string;
  readonly interests: string[];
  readonly timeoutMs: number;
  readonly historyLimit: number;
  readonly debounceMs: number;
  readonly maxWaitMs: number;
  readonly questionGraceMs: number;
  readonly shareWindowMs: number;
  readonly shareCap: number;
  readonly cooldownMs: number;
  readonly ignoredUserIds: string[];
  readonly channels: SemanticChannelConfig[];
  /** Resolved from `channels` for the engine's own channel. */
  readonly channelNote?: string;
}

export interface WillPolicyConfig {
  readonly engine: "routing" | "willingness" | "semantic";
  readonly routing?: PolicyRoutingConfig;
  readonly willingness?: PolicyWillingnessConfig;
  readonly semantic?: PolicySemanticConfig;
  readonly priority?: number;
}

export function defaultRoutingConfig(): PolicyRoutingConfig {
  return { direct: "trigger", mention: "trigger", mentionAll: "wait", mentionHere: "wait", quote: "wait", image: "wait", poke: "wait", group: "wait" };
}

export function defaultWillingnessConfig(): PolicyWillingnessConfig {
  return {
    maxScore: 100,
    initialScore: 0,
    decayHalfLifeSeconds: 600,
    probabilityThreshold: 55,
    probabilityAmplifier: 0.04,
    replyCost: 35,
    textGain: 12,
    mentionGain: 100,
    quoteGain: 15,
    directGain: 40,
    imageGain: 8,
    pokeGain: 80,
    keywords: [],
    keywordMultiplier: 1.2,
    defaultMultiplier: 1,
    hotWindowSeconds: 15,
    warmWindowSeconds: 60,
    hotDecayWeight: 0.3,
    warmDecayWeight: 0.7,
    mentionForce: false,
    quoteForce: false,
    directForce: false,
    ignoredUserIds: [],
  };
}

export function defaultSemanticConfig(): PolicySemanticConfig {
  return {
    mode: "shadow",
    model: "",
    selfName: "",
    persona: "",
    interests: [],
    timeoutMs: 4_000,
    historyLimit: 15,
    debounceMs: 6_000,
    maxWaitMs: 20_000,
    questionGraceMs: 60_000,
    shareWindowMs: 2 * 60 * 60 * 1_000,
    shareCap: 0.02,
    cooldownMs: 90_000,
    ignoredUserIds: [],
    channels: [],
  };
}
