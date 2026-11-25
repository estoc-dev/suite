import type { Client, PairList } from "@estoc/explorer";
import { decodeObject, type Link, LinkValue } from "@estoc/object";

export const shownLinkLimit = 10;

/**
 * `links` are those that the first rows under a link hold in the second field of the list, and
 * `rowCount` is how many rows are under it.
 */
export interface LinksUnder {
  readonly links: readonly Link<unknown>[];
  readonly rowCount: number;
}

export async function readLinksUnder<First extends string, Second extends string>(
  source: Pick<Client, "page">,
  list: PairList<First, Second>,
  link: Link<unknown>,
): Promise<LinksUnder> {
  const { rows, rowCount } = await source.page(list.name, [new LinkValue(link)], 0, shownLinkLimit);
  const [, second] = list.order;
  return { links: rows.map((bytes) => decodeObject(bytes, list.rowSchema).data[second].link), rowCount };
}
