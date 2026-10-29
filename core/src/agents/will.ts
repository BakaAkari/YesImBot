import type { TurnResult } from "@yesimagent/core";
import type { Awaitable, Session, Universal } from "koishi";

import type { ChannelContext } from "../channels/index.js";
import { isMessage, type AgentMessageOf } from "../messages/index.js";

/** What a `WillEngine` receives: the channel custom-message wrappers, not their payloads. */
export type ChannelInput = AgentMessageOf<"yesimbot.message"> | AgentMessageOf<"yesimbot.event">;

export const defaultWillEngine: WillEngine = {
  decide(input: ChannelInput, _state: WillState): "wait" | "trigger" {
    if (!isMessage(input)) return "wait";
    if (input.data.channel.type === (1 satisfies Universal.Channel.Type)) return "trigger";
    return input.data.elements.some((element) => element.type === "at" && String(element.attrs.id) === input.data.selfId) ? "trigger" : "wait";
  },
  debug(): WillDebug {
    return {
      engine: "default",
      config: { direct: "trigger", mention: "trigger", group: "wait" },
    };
  },
};

export interface WillState {
  readonly activeTurnId: string | null;
}

export interface WillEngine {
  decide(input: ChannelInput, state: WillState): Awaitable<"wait" | "trigger">;
  observe?(result: WillObservation): Awaitable<void>;
  debug?(): WillDebug | undefined;
  /** Called once when the channel runtime starts, so the engine can trigger turns later instead of only inside `decide`. */
  attach?(api: WillRuntimeApi): void;
}

/** A finished passive turn as seen by the engine. */
export interface WillObservation extends TurnResult {
  /** Platform message IDs that `send_message` delivered during the turn; empty when the turn ended silently. */
  readonly sentMessageIds?: readonly string[];
}

export interface WillRuntimeApi {
  /**
   * Starts a passive turn on the channel's latest input, as if `decide` had just returned `trigger` for it.
   * Resolves `false` when nothing ran: the runtime is stopped, nothing has arrived yet, or a turn is already active.
   */
  wake(options: WillWakeOptions): Promise<boolean>;
}

export interface WillWakeOptions {
  /** Short machine-readable cause, recorded in the decision log. */
  readonly reason: string;
  /** Decision details to record instead of the engine's current `debug()` snapshot. */
  readonly debug?: WillDebug;
}

export interface WillDebug {
  readonly engine: "default" | "routing" | "willingness" | "semantic";
  readonly config?: Record<string, unknown>;
  readonly score?: number;
  readonly probability?: number;
  /** Engine-specific details, such as a semantic gate's verdict. */
  readonly detail?: Record<string, unknown>;
}

export interface WillPlugin {
  readonly priority: number;
  match(session: Session): boolean;
  matchContext?(context: ChannelContext): boolean;
  setup(context: ChannelContext): Awaitable<WillEngine>;
}
