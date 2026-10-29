/**
 * aka-yesimbot publishes every package under `koishi-plugin-aka-yesimbot*`, so koishi.yml
 * keys look like `aka-yesimbot-will-policy`. The console's labels and checks are written
 * against upstream keys; map ours back to them so that logic stays unchanged.
 */
export function canonicalPluginKey(key: string): string {
  if (key === "aka-yesimbot") return "yesimbot";
  if (key.startsWith("aka-yesimbot-provider-")) return `@yesimbot/provider-${key.slice("aka-yesimbot-provider-".length)}`;
  if (key.startsWith("aka-yesimbot-")) return key.slice("aka-".length);
  return key;
}
