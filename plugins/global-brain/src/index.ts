import path from "node:path";

import { Context, Logger, Schema, type Bot } from "koishi";
import type { AgentPlugin, ChannelResources, ChannelContext } from "koishi-plugin-aka-yesimbot";

import { formatBrainDigest } from "./digest.js";
import { formatBrainPrompt } from "./prompt.js";
import { createGlobalBrainStore, type GlobalBrainStore } from "./store.js";
import { createBrainTools } from "./tools.js";
import { buildForwardEvent, buildImmediateShareEvent, type BrainThread, type GlobalBrainConfig, scopeKey } from "./types.js";

interface ActiveScope {
  readonly scope: ChannelContext;
  readonly selfId: string;
}

export default class GlobalBrainPlugin {
  public static readonly name = "yesimbot-global-brain";
  public static readonly description =
    " 全局脑插件：让同一个 Bot 在多个群聊和私聊之间共享值得保留的知识、问题与经验。某个会话写入的内容会持久化到全局脑，其他会话按需读取，并自行判断是否回复、转发或吸收。";
  public static readonly inject = ["yesimbot"];
  public static readonly Config: Schema<GlobalBrainConfig> = Schema.object({
    shareImmediately: Schema.boolean().default(false).description("允许 brain_deposit 在请求时立即向其他 session 唤起一次请求"),
    storageDir: Schema.string().default("").description("全局脑存储目录；留空时使用 <baseDir>/global-brain"),
    brainPrompt: Schema.string().role("textarea").default("").description("全局脑对 agent 的提示词；留空使用内置默认提示词"),
    maxDigestThreads: Schema.number().min(1).max(20).default(5).description("每次自然 turn 最多摘要的全局脑新内容数量"),
    maxDigestReplies: Schema.number().min(1).max(20).default(5).description("每次自然 turn 最多摘要的回复线程数量"),
    maxDigestContentLength: Schema.number().min(1).max(2000).default(80).description("全局脑摘要中每条内容的最大字符数"),
    maxBlobBytes: Schema.number()
      .min(1)
      .default(5 * 1024 * 1024)
      .description("asset/artifact 物化到全局脑 blob 的最大字节数"),
    allowedChannels: Schema.array(Schema.string()).default([]).description("仅允许参与全局脑的频道 ID 白名单（按 channelId 匹配）；留空 = 全部频道参与"),
    scheduledShare: Schema.object({
      channelId: Schema.string().default("").description("定时转发的目标群号；留空关闭"),
      idleMinutes: Schema.number().min(1).default(20).description("目标群安静多久后才转发(分钟)"),
      minGapMinutes: Schema.number().min(1).default(120).description("两次转发之间至少间隔(分钟)"),
      dailyLimit: Schema.number().min(0).default(4).description("每天最多转发几条"),
      freshHours: Schema.number().min(1).default(72).description("只转发多少小时内存入的内容"),
      startHour: Schema.number().min(0).max(24).default(9).description("每天几点开始可以转发"),
      endHour: Schema.number().min(0).max(24).default(24).description("每天几点之后不再转发"),
      checkIntervalMinutes: Schema.number().min(1).default(5).description("检查间隔(分钟)"),
    }).description("定时转发：目标群安静时，把别的群存入的分享交给 bot 原样转发"),
  });

  public readonly ctx: Context;
  public readonly config: GlobalBrainConfig;
  public readonly logger: Logger;

  private readonly scopes = new Map<string, ActiveScope>();
  private readonly allowedChannels: Set<string> | undefined;
  private store: GlobalBrainStore | undefined;
  private dispose: (() => unknown) | undefined;
  private forwardTimer: ReturnType<typeof setInterval> | undefined;
  /** Last human or bot message in the scheduled-share target channel. */
  private targetActiveAt = Date.now();

  public constructor(ctx: Context, config: GlobalBrainConfig) {
    this.ctx = ctx;
    this.config = config;
    this.logger = ctx.logger("yesimbot.global-brain");
    this.allowedChannels = config.allowedChannels && config.allowedChannels.length > 0 ? new Set(config.allowedChannels) : undefined;
    ctx.on("ready", this.start.bind(this));
    ctx.on("yesimbot/message", (input) => this.noteActivity(input.data.channel?.id));
    ctx.on("yesimbot/delivered", (payload) => this.noteActivity(payload.channel?.id));
    ctx.on("dispose", this.stop.bind(this));
  }

  public async start(): Promise<void> {
    this.dispose?.();
    this.dispose = undefined;
    const storageDir = this.config.storageDir ? path.resolve(this.ctx.baseDir, this.config.storageDir) : path.join(this.ctx.baseDir, "global-brain");
    const store = createGlobalBrainStore({
      filePath: path.join(storageDir, "brain.jsonl"),
      maxDigestThreads: this.config.maxDigestThreads,
      maxDigestReplies: this.config.maxDigestReplies,
      maxBlobBytes: this.config.maxBlobBytes,
      logger: this.logger,
    });
    await store.init();
    this.store = store;
    this.dispose = this.ctx.yesimbot.agent.use(this);
    const share = this.config.scheduledShare;
    if (share?.channelId) {
      this.targetActiveAt = Date.now();
      this.forwardTimer = setInterval(() => void this.offerForward(), share.checkIntervalMinutes * 60_000);
      (this.forwardTimer as { unref?: () => void }).unref?.();
    }
  }

  public async stop(): Promise<void> {
    if (this.forwardTimer) clearInterval(this.forwardTimer);
    this.forwardTimer = undefined;
    this.dispose?.();
    this.dispose = undefined;
    this.scopes.clear();
    this.store = undefined;
  }

  public async setup(scope: ChannelContext, bot: Bot): Promise<AgentPlugin | null> {
    if (!this.isAllowed(scope)) return null;
    this.scopes.set(scopeKey(scope), { scope, selfId: bot.selfId });
    const resources = await this.ctx.yesimbot.resource.get(scope);
    return this.createAgentPlugin(scope, resources);
  }

  private noteActivity(channelId: string | undefined): void {
    if (channelId && channelId === this.config.scheduledShare?.channelId) this.targetActiveAt = Date.now();
  }

  /** When the target group has gone quiet, offers it one fresh share from another group to forward as is. */
  public async offerForward(now = Date.now()): Promise<BrainThread | undefined> {
    const share = this.config.scheduledShare;
    const store = this.store;
    if (!share?.channelId || !store) return undefined;
    const target = [...this.scopes.values()].find((entry) => entry.scope.channelId === share.channelId);
    if (!target) return undefined;
    const hour = new Date(now).getHours();
    if (hour < share.startHour || hour >= share.endHour) return undefined;
    if (now - this.targetActiveAt < share.idleMinutes * 60_000) return undefined;
    if ((await store.forwardOffers(target.scope, now - share.minGapMinutes * 60_000)) > 0) return undefined;
    const dayStart = new Date(now).setHours(0, 0, 0, 0);
    if ((await store.forwardOffers(target.scope, dayStart)) >= share.dailyLimit) return undefined;
    const thread = await store.forwardCandidate(target.scope, now - share.freshHours * 3_600_000);
    if (!thread) return undefined;
    await store.markForwardOffered(thread.id, target.scope);
    this.targetActiveAt = now;
    this.logger.info("global_brain.forward_offer", { channelId: share.channelId, threadId: thread.id });
    try {
      await this.ctx.yesimbot.messenger.post(buildForwardEvent(target.scope, target.selfId, thread));
    } catch (error) {
      this.logger.warn("global_brain.forward_failed", { threadId: thread.id, cause: error instanceof Error ? error.message : String(error) });
    }
    return thread;
  }

  private isAllowed(scope: ChannelContext): boolean {
    return this.allowedChannels === undefined || this.allowedChannels.has(scope.channelId);
  }

  private createAgentPlugin(scope: ChannelContext, resources: ChannelResources): AgentPlugin | null {
    const store = this.store;
    if (!store) return null;
    const { assets, artifacts } = resources;
    let injectedTurn: string | undefined;
    return {
      name: "global-brain",
      extendTools: () =>
        createBrainTools({
          store,
          scope,
          assets,
          artifacts,
          defaultShareImmediately: this.config.shareImmediately,
          onImmediateShare: (thread) => this.enqueueImmediateShare(thread, scope),
        }),
      extendInstructions: () => (this.config.brainPrompt && this.config.brainPrompt.trim().length > 0 ? this.config.brainPrompt : formatBrainPrompt()),
      prepareStep: async (options) => {
        if (injectedTurn === options.turnId) return options;
        injectedTurn = options.turnId;
        const digest = await store.digest(scope);
        const text = formatBrainDigest(digest, this.config.maxDigestContentLength);
        return text ? { ...options, messages: [...options.messages, { role: "user", content: `[全局脑摘要，不要回复本段]\n\n${text}` }] } : options;
      },
    } satisfies AgentPlugin;
  }

  private enqueueImmediateShare(thread: BrainThread, sourceScope: ChannelContext): void {
    const sourceKey = scopeKey(sourceScope);
    for (const target of this.scopes.values()) {
      if (scopeKey(target.scope) === sourceKey) continue;
      void this.runImmediateShare(thread, target);
    }
  }

  private async runImmediateShare(thread: BrainThread, target: ActiveScope): Promise<void> {
    try {
      await this.ctx.yesimbot.messenger.post(buildImmediateShareEvent(target.scope, target.selfId, thread));
    } catch (error) {
      this.logger.warn("global_brain.immediate_trigger_failed", {
        threadId: thread.id,
        targetScope: target.scope,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export type { GlobalBrainStore } from "./store.js";

export { BrainStoreError, createGlobalBrainStore } from "./store.js";

export { formatBrainDigest } from "./digest.js";

export { formatBrainPrompt } from "./prompt.js";

export { createBrainTools } from "./tools.js";

export { buildImmediateShareEvent } from "./types.js";

export type {
  BrainDigest,
  BrainImmediateShare,
  BrainPostKind,
  BrainReply,
  BrainReplySource,
  BrainStatus,
  BrainThread,
  BrainThreadStatus,
  BrainThreadView,
  GlobalBrainConfig,
} from "./types.js";
