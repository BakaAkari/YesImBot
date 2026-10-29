import { randomUUID } from "node:crypto";

import { Context, Logger, Schema, type Command, type Session } from "koishi";
import { generateText, type ChannelContext, type WillEngine, type WillPlugin } from "koishi-plugin-aka-yesimbot";

import { resolvePolicy } from "./policy.js";
import { PolicyRoutingEngine } from "./routing.js";
import { PolicySemanticEngine } from "./semantic.js";
import type { WillPolicyConfig } from "./types.js";
import { PolicyWillingnessEngine } from "./willingness.js";

const WillingnessSchema = Schema.object({
  maxScore: Schema.number().default(100).description("意愿值上限"),
  initialScore: Schema.number().default(0).description("初始意愿值"),
  decayHalfLifeSeconds: Schema.number().default(600).description("意愿值半衰期(秒)"),
  probabilityThreshold: Schema.number().default(55).description("触发概率阈值"),
  probabilityAmplifier: Schema.number().default(0.04).description("超过阈值后的概率放大系数"),
  replyCost: Schema.number().default(35).description("每实际发出一条消息扣除的意愿值；沉默结束的轮次不扣"),
  textGain: Schema.number().default(12).description("普通消息基础增益"),
  mentionGain: Schema.number().default(100).description("被 @ 时的增益"),
  quoteGain: Schema.number().default(15).description("引用/回复时的增益"),
  directGain: Schema.number().default(40).description("私聊时的增益"),
  imageGain: Schema.number().default(8).description("含图片消息的增益"),
  pokeGain: Schema.number().default(80).description("拍一拍事件的增益"),
  keywords: Schema.array(Schema.string())
    .default([])
    .description("高兴趣关键词。纯英文/数字关键词按整词匹配（ai 不命中 said）；中文按子串匹配，建议用较长的词；写成 /正则/ 则按正则匹配"),
  keywordMultiplier: Schema.number().default(1.2).description("命中关键词时的乘数"),
  defaultMultiplier: Schema.number().default(1).description("未命中关键词时的默认乘数"),
  hotWindowSeconds: Schema.number().default(15).description("热窗口秒数"),
  warmWindowSeconds: Schema.number().default(60).description("温窗口秒数"),
  hotDecayWeight: Schema.number().default(0.3).description("热窗口衰减权重"),
  warmDecayWeight: Schema.number().default(0.7).description("温窗口衰减权重"),
  mentionForce: Schema.boolean().default(false).description("被 @ 时强制触发"),
  quoteForce: Schema.boolean().default(false).description("引用机器人自己的消息时强制触发（引用别人的消息不算）"),
  directForce: Schema.boolean().default(false).description("私聊强制触发"),
  ignoredUserIds: Schema.array(Schema.string()).default([]).description("忽略的发送者 ID：不累计意愿值、不触发回复"),
});

const SemanticSchema = Schema.object({
  mode: Schema.union([Schema.const("shadow").description("影子：只记录判断，由意愿值引擎决策"), Schema.const("active").description("生效：由语义门决策")])
    .default("shadow")
    .description("运行模式；先用 shadow 观察日志再切 active"),
  model: Schema.string().required().description("语义门模型，完整 ID，如 openai:gemini-3.5-flash-lite；需在 provider 的 chatModels 中登记"),
  selfName: Schema.string().default("").description("机器人在群里的名字"),
  persona: Schema.string().role("textarea").default("").description("给语义门看的一两句人设"),
  interests: Schema.array(Schema.string()).default([]).description("兴趣话题，语义门按实际话题判断贴合度"),
  timeoutMs: Schema.number().default(4000).description("语义门超时(毫秒)，超时回退到意愿值引擎"),
  historyLimit: Schema.number().default(15).description("给语义门看的最近消息条数"),
  debounceMs: Schema.number().default(6000).description("频道安静多久后判断(毫秒)"),
  maxWaitMs: Schema.number().default(20000).description("持续刷屏时最多等多久(毫秒)"),
  questionGraceMs: Schema.number().default(60000).description("开放提问无人回答多久后才接(毫秒)"),
  shareWindowMs: Schema.number().default(7200000).description("发言份额统计窗口(毫秒)"),
  shareCap: Schema.number().default(0.02).description("非直接对话时，机器人发言轮数占真人消息数的上限"),
  cooldownMs: Schema.number().default(90000).description("发言后的冷却(毫秒)；被 @、被引用、被直接搭话不受影响"),
  ignoredUserIds: Schema.array(Schema.string()).default([]).description("忽略的发送者 ID（如其他 bot）：只作为上下文，不触发"),
  channels: Schema.array(
    Schema.object({
      channelId: Schema.string().required().description("频道/群号"),
      note: Schema.string().role("textarea").default("").description("这个群的氛围，一两句，给语义门看"),
      shareCap: Schema.number().description("覆盖该群的发言份额上限；留空用全局 shareCap"),
    }),
  )
    .default([])
    .description("按群设置"),
});

export const WillPolicyConfigSchema: Schema<WillPolicyConfig> = Schema.intersect([
  Schema.object({
    engine: Schema.union([
      Schema.const("routing").description("固定规则（routing）"),
      Schema.const("willingness").description("意愿值引擎(willingness)"),
      Schema.const("semantic").description("语义门(semantic)：小模型判断何时接话"),
    ])
      .default("routing")
      .description("该克隆实例使用的引擎；routing 适合稳定规则，willingness 适合动态活跃度，semantic 在 willingness 之上加小模型判断"),
    priority: Schema.number().default(1000).description("WillEngine 优先级，数值小者先执行"),
  }),
  Schema.union([
    Schema.object({
      engine: Schema.const("routing"),
      routing: Schema.object({
        direct: Schema.union(["wait", "trigger"]).default("trigger").description("私聊消息"),
        mention: Schema.union(["wait", "trigger"]).default("trigger").description("@ 机器人"),
        mentionAll: Schema.union(["wait", "trigger"]).default("wait").description("@全体成员"),
        mentionHere: Schema.union(["wait", "trigger"]).default("wait").description("@在线成员"),
        quote: Schema.union(["wait", "trigger"]).default("wait").description("引用/回复消息"),
        image: Schema.union(["wait", "trigger"]).default("wait").description("含图片的消息"),
        poke: Schema.union(["wait", "trigger"]).default("wait").description("拍一拍事件"),
        group: Schema.union(["wait", "trigger"]).default("wait").description("普通群消息"),
      })
        .required()
        .description("固定规则引擎配置；仅在 engine 为 routing 时生效"),
    }),
    Schema.object({
      engine: Schema.const("willingness"),
      willingness: WillingnessSchema.required().description("意愿值引擎配置；仅在 engine 为 willingness 时生效"),
    }),
    Schema.object({
      engine: Schema.const("semantic"),
      semantic: SemanticSchema.required().description("语义门配置"),
      willingness: WillingnessSchema.required().description("意愿值引擎配置；shadow 模式下负责决策，active 模式下作为语义门失败时的回退"),
    }),
  ]),
]);

const DEBUG_COMMAND_NAME = "yesimbot.will-policy";

const DEBUG_PROBES = new WeakMap<Context, Set<WillPolicyPlugin>>();

const DEBUG_COMMANDS = new WeakMap<Context, Command>();

const DEBUG_ACTION: unique symbol = Symbol("yesimbot.will-policy.debug-action");

type DebugCommand = Command & { [DEBUG_ACTION]?: boolean };

export default class WillPolicyPlugin implements WillPlugin {
  public static readonly name = "yesimbot-will-policy";
  public static readonly reusable = true;
  public static readonly inject = ["yesimbot"];
  public static readonly usage = "提供可克隆、可筛选、可组合的 WillEngine 与 routing 策略";
  public static readonly Config: Schema<WillPolicyConfig> = WillPolicyConfigSchema;

  public readonly ctx: Context;
  public readonly config: WillPolicyConfig;
  public readonly logger: Logger;
  public readonly priority: number;

  private readonly instanceId = randomUUID();
  private disposeWillPlugin?: () => void;
  /** Live semantic engines by `platform:channelId`, fed with the bot's delivered messages. */
  private readonly semanticEngines = new Map<string, PolicySemanticEngine>();

  public constructor(ctx: Context, config: WillPolicyConfig) {
    this.ctx = ctx;
    this.config = config;
    this.priority = config.priority ?? 1000;
    this.logger = ctx.logger("yesimbot.will-policy");
    this.logger.level = ctx.yesimbot.config.logLevel ?? 2;
    ctx.on("ready", this.start.bind(this));
    ctx.on("dispose", this.stop.bind(this));
    ctx.on("yesimbot/delivered", (payload) => {
      if (!payload?.channel?.id || !payload.messageId) return;
      this.semanticEngines.get(`${payload.platform}:${payload.channel.id}`)?.noteDelivered(String(payload.messageId), String(payload.text ?? ""));
    });
  }

  public async start(): Promise<void> {
    this.disposeWillPlugin?.();
    this.disposeWillPlugin = this.ctx.yesimbot.agent.will(this);
    this.registerDebugProbe();
    this.logger.success("Will policy plugin started", { instanceId: this.instanceId });
  }

  public match(session: Session): boolean {
    const matched = this.ctx.filter(session);
    this.logger.debug("will_policy.match", {
      instanceId: this.instanceId,
      priority: this.priority,
      engine: this.config.engine,
      platform: session.platform,
      channelId: session.channelId,
      guildId: session.guildId,
      matched,
    });
    return matched;
  }

  public matchContext(context: ChannelContext): boolean {
    const bot =
      this.ctx.bots.find((candidate) => candidate.platform === context.platform && (!context.selfId || candidate.selfId === context.selfId)) ??
      this.ctx.bots[0];
    if (!bot) {
      this.logger.debug("will_policy.match_context", {
        instanceId: this.instanceId,
        priority: this.priority,
        engine: this.config.engine,
        platform: context.platform,
        channelId: context.channelId,
        guildId: context.type === "direct" ? undefined : context.guildId,
        matched: false,
        reason: "no_bot",
      });
      return false;
    }

    const isDirect = context.type === "direct";

    const session = bot.session({
      type: "message-created",
      subtype: isDirect ? "private" : "group",
      platform: context.platform,
      selfId: context.selfId,
      timestamp: Date.now(),
      channel: { id: context.channelId, type: isDirect ? 1 : 0 },
      ...(!isDirect && context.guildId ? { guild: { id: context.guildId } } : {}),
      ...(isDirect ? { user: { id: context.userId, ...(context.userName ? { name: context.userName } : {}) } } : {}),
    } as never) as Session;
    const matched = this.ctx.filter(session);
    this.logger.debug("will_policy.match_context", {
      instanceId: this.instanceId,
      priority: this.priority,
      engine: this.config.engine,
      platform: context.platform,
      channelId: context.channelId,
      guildId: isDirect ? undefined : context.guildId,
      matched,
    });
    return matched;
  }

  public setup(scope: ChannelContext): WillEngine {
    const resolved = resolvePolicy(this.config);
    this.logger.debug("resolve_will_policy", { engine: resolved.engine, routing: resolved.routing, willingness: resolved.willingness });
    if (resolved.engine === "routing") return new PolicyRoutingEngine(resolved.routing, this.logger);
    const willingness = new PolicyWillingnessEngine(resolved.willingness, this.logger);
    if (resolved.engine !== "semantic") return willingness;

    const semantic = resolved.semantic;
    const channel = semantic.channels.find((entry) => entry.channelId === scope.channelId);
    const engine = new PolicySemanticEngine(
      {
        ...semantic,
        ignoredUserIds: [...new Set([...semantic.ignoredUserIds, ...resolved.willingness.ignoredUserIds])],
        shareCap: channel?.shareCap ?? semantic.shareCap,
        channelNote: channel?.note,
      },
      willingness,
      async (system, prompt, abortSignal) => {
        const { model } = this.ctx.yesimbot.model.resolveChatModel(semantic.model, scope);
        const { text } = await generateText({ model, system, prompt, temperature: 0, abortSignal });
        return text;
      },
      this.logger,
    );
    this.semanticEngines.set(`${scope.platform}:${scope.channelId}`, engine);
    return engine;
  }

  public async stop(): Promise<void> {
    const root = this.ctx.root;
    const probes = DEBUG_PROBES.get(root);
    probes?.delete(this);
    if (probes?.size === 0) {
      DEBUG_COMMANDS.get(root)?.dispose();
      DEBUG_COMMANDS.delete(root);
      DEBUG_PROBES.delete(root);
    }
    this.disposeWillPlugin?.();
    this.disposeWillPlugin = undefined;
    this.semanticEngines.clear();
  }

  private registerDebugProbe(): void {
    const root = this.ctx.root;
    const probes = DEBUG_PROBES.get(root) ?? new Set<WillPolicyPlugin>();
    probes.add(this);
    DEBUG_PROBES.set(root, probes);

    let command = DEBUG_COMMANDS.get(root);
    if (!command) {
      command = root.command(DEBUG_COMMAND_NAME, "检查当前 WillEngine 策略实例", { authority: 4 });
      DEBUG_COMMANDS.set(root, command);
    }
    const debugCommand = command as DebugCommand;
    if (debugCommand[DEBUG_ACTION]) return;
    Object.defineProperty(debugCommand, DEBUG_ACTION, { value: true });
    debugCommand.action(async ({ session }) => {
      if (!session) return;
      const matches = [...probes].filter((probe) => probe.ctx.filter(session));
      if (matches.length === 0) return;
      return matches.map((probe) => probe.instanceDescription()).join("\n");
    });
  }

  private instanceDescription(): string {
    return [`WillPolicy[${this.instanceId.slice(0, 8)}]`, `engine=${this.config.engine}`, `priority=${this.priority}`].join(" ");
  }
}
