import { createMessage, type Message } from "koishi-plugin-aka-yesimbot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { buildGatePrompt, parseVerdict, type GateVerdict } from "../src/gate.js";
import { PolicySemanticEngine, rule, type GateGenerate } from "../src/semantic.js";
import { defaultSemanticConfig, defaultWillingnessConfig, type PolicySemanticConfig } from "../src/types.js";
import { matchesKeyword, PolicyWillingnessEngine } from "../src/willingness.js";

const state = { activeTurnId: null };
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

let seq = 0;
function message(elements: unknown[], options: { user?: string; channelType?: 0 | 1 } = {}): Message {
  seq += 1;
  return createMessage({
    platform: "test",
    selfId: "bot-1",
    timestamp: Date.now(),
    channel: { id: "room-1", type: options.channelType ?? 0 },
    user: { id: options.user ?? "user-1", name: "阿强" },
    messageId: `m-${seq}`,
    elements: elements as never,
  });
}

const text = (content: string) => ({ type: "text", attrs: { content }, children: [] });

function verdict(overrides: Partial<GateVerdict> = {}): GateVerdict {
  return { addressed: false, others: false, openQuestion: false, interest: 0, complete: true, mood: "闲", focusMessageId: "m-1", ...overrides };
}

function engine(config: Partial<PolicySemanticConfig>, generate: GateGenerate) {
  const inner = new PolicyWillingnessEngine({ ...defaultWillingnessConfig(), probabilityThreshold: 1_000 }, logger as never);
  const semantic = new PolicySemanticEngine({ ...defaultSemanticConfig(), model: "test:lite", selfName: "米塔", ...config }, inner, generate, logger as never);
  const wake = vi.fn(async () => true);
  semantic.attach({ wake });
  return { semantic, wake };
}

describe("parseVerdict", () => {
  it("accepts a complete verdict, also inside a code fence", () => {
    const json = JSON.stringify(verdict({ interest: 2 }));
    expect(parseVerdict(json)).toEqual(verdict({ interest: 2 }));
    expect(parseVerdict("```json\n" + json + "\n```")).toEqual(verdict({ interest: 2 }));
  });

  it("rejects missing or mistyped fields", () => {
    const { complete: _, ...missing } = verdict();
    expect(parseVerdict(JSON.stringify(missing))).toBeUndefined();
    expect(parseVerdict(JSON.stringify({ ...verdict(), interest: 5 }))).toBeUndefined();
    expect(parseVerdict(JSON.stringify({ ...verdict(), mood: "开心" }))).toBeUndefined();
    expect(parseVerdict("not json")).toBeUndefined();
  });
});

describe("rule", () => {
  const config = defaultSemanticConfig();
  const base = { now: 1_000_000, lastSelfAt: undefined, focusAgeMs: 0, share: { human: 300, self: 0, topHuman: 50 } };

  it("speaks when addressed even during cooldown", () => {
    expect(rule(verdict({ addressed: true, complete: false }), { ...base, lastSelfAt: base.now - 1_000 }, config).speak).toBe(true);
  });

  it("stays quiet while the speaker is mid-thought or others are talking", () => {
    expect(rule(verdict({ complete: false, interest: 3 }), base, config).reason).toBe("incomplete");
    expect(rule(verdict({ others: true, interest: 3 }), base, config).reason).toBe("others");
  });

  it("waits out the grace period before answering an open question", () => {
    const early = rule(verdict({ openQuestion: true }), { ...base, focusAgeMs: 10_000 }, config);
    expect(early).toEqual({ speak: false, reason: "question_grace", recheckInMs: 50_000 });
    expect(rule(verdict({ openQuestion: true }), { ...base, focusAgeMs: 61_000 }, config).speak).toBe(true);
  });

  it("joins interesting topics only within the share cap and outside cooldown", () => {
    expect(rule(verdict({ interest: 2 }), base, config).reason).toBe("interest");
    expect(rule(verdict({ interest: 2, mood: "冲突" }), base, config).speak).toBe(false);
    expect(rule(verdict({ interest: 3 }), { ...base, share: { human: 300, self: 6, topHuman: 50 } }, config).reason).toBe("share_cap");
    expect(rule(verdict({ interest: 3 }), { ...base, share: { human: 20, self: 1, topHuman: 8 } }, config).reason).toBe("share_cap");
    expect(rule(verdict({ interest: 3 }), { ...base, lastSelfAt: base.now - 10_000 }, config).reason).toBe("cooldown");
  });
});

describe("PolicySemanticEngine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("triggers at once on @, and on quotes of its own messages only", async () => {
    const generate = vi.fn<GateGenerate>();
    const { semantic } = engine({ mode: "active" }, generate);
    await semantic.observe({ turnId: "t", status: "done", messages: [], sentMessageIds: ["own-1"] });

    expect(await semantic.decide(message([{ type: "at", attrs: { id: "bot-1" }, children: [] }, text("在吗")]), state)).toBe("trigger");
    expect(await semantic.decide(message([{ type: "reply", attrs: { id: "own-1" }, children: [] }, text("真的吗")]), state)).toBe("trigger");
    expect(await semantic.decide(message([{ type: "reply", attrs: { id: "other" }, children: [] }, text("真的吗")]), state)).toBe("wait");
    expect(await semantic.decide(message([text("hi")], { channelType: 1 }), state)).toBe("trigger");
  });

  it("debounces a burst into one gate call and wakes the runtime", async () => {
    const generate = vi.fn<GateGenerate>(async () => JSON.stringify(verdict({ addressed: true })));
    const { semantic, wake } = engine({ mode: "active" }, generate);

    await semantic.decide(message([text("米塔")]), state);
    await vi.advanceTimersByTimeAsync(3_000);
    await semantic.decide(message([text("你觉得呢")]), state);
    await vi.advanceTimersByTimeAsync(5_999);
    expect(generate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![1]).toContain("你觉得呢");
    expect(wake).toHaveBeenCalledWith(expect.objectContaining({ reason: "semantic:addressed" }));
  });

  it("stops waiting at maxWaitMs during a long burst", async () => {
    const generate = vi.fn<GateGenerate>(async () => JSON.stringify(verdict()));
    const { semantic } = engine({ mode: "active" }, generate);
    for (let index = 0; index < 5; index += 1) {
      await semantic.decide(message([text(`刷屏 ${index}`)]), state);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("only logs in shadow mode and lets willingness decide", async () => {
    const generate = vi.fn<GateGenerate>(async () => JSON.stringify(verdict({ addressed: true })));
    const { semantic, wake } = engine({ mode: "shadow" }, generate);
    expect(await semantic.decide(message([text("米塔 在吗")]), state)).toBe("wait");
    const ruling = await semantic.flush();
    expect(ruling).toEqual({ speak: true, reason: "addressed" });
    expect(wake).not.toHaveBeenCalled();
  });

  it("never acts on ignored senders", async () => {
    const generate = vi.fn<GateGenerate>(async () => JSON.stringify(verdict({ addressed: true })));
    const { semantic } = engine({ mode: "active", ignoredUserIds: ["bot-2"] }, generate);
    expect(await semantic.decide(message([{ type: "at", attrs: { id: "bot-1" }, children: [] }], { user: "bot-2" }), state)).toBe("wait");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(generate).not.toHaveBeenCalled();
  });

  it("falls back to willingness when the gate fails or times out", async () => {
    const generate = vi.fn<GateGenerate>(() => new Promise(() => {}));
    const inner = new PolicyWillingnessEngine({ ...defaultWillingnessConfig(), probabilityThreshold: 0, probabilityAmplifier: 1 }, logger as never);
    const semantic = new PolicySemanticEngine(
      { ...defaultSemanticConfig(), mode: "active", model: "test:lite", timeoutMs: 100 },
      inner,
      generate,
      logger as never,
    );
    const wake = vi.fn(async () => true);
    semantic.attach({ wake });

    expect(await semantic.decide(message([text("随便聊聊")]), state)).toBe("wait");
    await vi.advanceTimersByTimeAsync(6_000 + 100);
    expect(wake).toHaveBeenCalledWith(expect.objectContaining({ reason: "semantic:gate_failed_fallback" }));
  });
});

describe("gate prompt", () => {
  it("marks bots and the member's own lines", () => {
    const prompt = buildGatePrompt({
      selfName: "米塔",
      selfId: "bot-1",
      persona: "",
      interests: ["显卡"],
      now: 10_000,
      history: [
        { messageId: "a", userId: "u1", name: "阿强", text: "显卡降价了", timestamp: 5_000, self: false, ignored: false },
        { messageId: "b", userId: "b2", name: "鲸鲸", text: "我是机器人", timestamp: 6_000, self: false, ignored: true },
        { messageId: "c", userId: "", name: "", text: "多少", timestamp: 8_000, self: true, ignored: false },
      ],
    });
    expect(prompt).toContain("[-5s] #a 阿强(u1): 显卡降价了");
    expect(prompt).toContain("鲸鲸(b2) [bot]");
    expect(prompt).toContain("#c 米塔(你): 多少");
  });
});

describe("willingness fixes", () => {
  it("charges reply cost per sent message and nothing for silent turns", async () => {
    const willingness = new PolicyWillingnessEngine({ ...defaultWillingnessConfig(), initialScore: 100, replyCost: 10 }, logger as never);
    await willingness.observe({ turnId: "t1", status: "done", messages: [], sentMessageIds: [] });
    expect(willingness.getCurrentWillingness()).toBe(100);
    await willingness.observe({ turnId: "t2", status: "done", messages: [], sentMessageIds: ["a", "b", "c"] });
    expect(willingness.getCurrentWillingness()).toBe(70);
    await willingness.observe({ turnId: "t3", status: "done", messages: [] });
    expect(willingness.getCurrentWillingness()).toBe(60);
  });

  it("forces on quotes of its own messages only", async () => {
    const willingness = new PolicyWillingnessEngine({ ...defaultWillingnessConfig(), probabilityThreshold: 1_000, quoteForce: true }, logger as never);
    const quote = (id: string) => message([{ type: "reply", attrs: { id }, children: [] }, text("嗯")]);
    expect(await willingness.decide(quote("mine"), state)).toBe("wait");
    willingness.rememberOwn("mine");
    expect(await willingness.decide(quote("mine"), state)).toBe("trigger");
    expect(await willingness.decide(quote("someone"), state)).toBe("wait");
  });

  it("matches ASCII keywords as whole words", () => {
    expect(matchesKeyword("he said so", "ai")).toBe(false);
    expect(matchesKeyword("AI 又进步了", "ai")).toBe(true);
    expect(matchesKeyword("用blender建模", "blender")).toBe(true);
    expect(matchesKeyword("我在画画", "画")).toBe(true);
    expect(matchesKeyword("RTX 4090 到了", "/\\d{4}/")).toBe(true);
  });
});
