import { type Link, readObjectNaming } from "@estoc/object";
import { type Store, writtenObjectSchema } from "@estoc/store";

/**
 * What `store` recorded, in the order it was written: each statement by its link, and a Written
 * Object by the link of the object it links to.
 */
export async function recordedIn(store: Store): Promise<Link<unknown>[]> {
  const links: Link<unknown>[] = [];
  for await (const statement of store.records()) {
    links.push((await readObjectNaming(store, statement, writtenObjectSchema))?.data.object.link ?? statement);
  }
  return links;
}
