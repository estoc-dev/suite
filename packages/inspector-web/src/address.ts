import { type Link, LinkValue } from "@estoc/object";

/** The fragment of the page's address that names `link`, so that the browser's history goes from link to link. */
export function fragmentOf(link: Link<unknown>): string {
  return `#${link}`;
}

/** The link that a fragment names. Nothing when it names none, as the empty fragment does. */
export function linkIn(fragment: string): Link<unknown> | undefined {
  try {
    return new LinkValue(fragment.slice(1) as Link<unknown>).link;
  } catch {
    return undefined;
  }
}
