import { type Link, LinkValue } from "@estoc/object";

export function fragmentOf(link: Link<unknown>): string {
  return `#${link}`;
}

export function linkIn(fragment: string): Link<unknown> | undefined {
  try {
    return new LinkValue(fragment.slice(1) as Link<unknown>).link;
  } catch {
    return undefined;
  }
}
