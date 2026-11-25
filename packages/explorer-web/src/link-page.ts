import type { Client } from "@estoc/explorer";
import type { Link } from "@estoc/object";
import { pageSize } from "./list-page.ts";
import type { LinkSet } from "./place.ts";

export type LinkSource = Pick<Client, "objectsOf" | "sourcesOf">;

/** How many links of a set are shown where the set is not what the page is of. */
export const shownLinkLimit = 10;

/**
 * - `linkCount` is how many links the set has, and `start` how many of them come before `links`.
 * - `previous` and `next` are where the pages before and after this one begin, each left out where
 *   the set ends.
 */
export interface LinkSetPage {
  readonly links: readonly Link<unknown>[];
  readonly start: number;
  readonly linkCount: number;
  readonly previous?: number;
  readonly next?: number;
}

export async function readLinkSetPage(
  source: LinkSource,
  set: LinkSet,
  from: number | undefined,
): Promise<LinkSetPage> {
  const { links, start, linkCount } = await ("objectsOf" in set
    ? source.objectsOf(set.objectsOf, from ?? 0, pageSize)
    : source.sourcesOf(set.sourcesOf, from ?? 0, pageSize));
  const end = start + links.length;
  return {
    links,
    start,
    linkCount,
    ...(start > 0 && { previous: Math.max(start - pageSize, 0) }),
    ...(end < linkCount && { next: end }),
  };
}
