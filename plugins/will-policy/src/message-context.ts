import type { Element } from "koishi";

export function mentionKind(selfId: string, elements: readonly Element[] | undefined): "self" | "all" | "here" | "none" {
  for (const element of elements ?? []) {
    if (element.type !== "at") continue;
    const type = String(element.attrs.type ?? "");
    if (type === "all") return "all";
    if (type === "here") return "here";
    if (String(element.attrs.id) === selfId) return "self";
  }
  return "none";
}

export function hasQuote(elements: readonly Element[] | undefined): boolean {
  return elements?.some((element) => element.type === "quote" || element.type === "reply") ?? false;
}

export function hasImage(elements: readonly Element[] | undefined): boolean {
  return elements?.some((element) => element.type === "img" || element.type === "image") ?? false;
}

/** IDs of the messages this message quotes or replies to. */
export function quotedIds(elements: readonly Element[] | undefined): string[] {
  return (elements ?? [])
    .filter((element) => element.type === "quote" || element.type === "reply")
    .map((element) => String(element.attrs?.id ?? ""))
    .filter(Boolean);
}
