import {
  defaultRoutingConfig,
  defaultSemanticConfig,
  defaultWillingnessConfig,
  type PolicyRoutingConfig,
  type PolicySemanticConfig,
  type PolicyWillingnessConfig,
  type WillPolicyConfig,
} from "./types.js";

export interface ResolvedPolicy {
  readonly engine: "routing" | "willingness" | "semantic";
  readonly routing: PolicyRoutingConfig;
  readonly willingness: PolicyWillingnessConfig;
  readonly semantic: PolicySemanticConfig;
}

export function resolvePolicy(config: WillPolicyConfig): ResolvedPolicy {
  return {
    engine: config.engine,
    routing: { ...defaultRoutingConfig(), ...config.routing },
    willingness: { ...defaultWillingnessConfig(), ...config.willingness },
    semantic: { ...defaultSemanticConfig(), ...config.semantic },
  };
}
