import { type Link, objectsOf } from "@estoc/object";
import { recordSchema, type Store } from "@estoc/store";

const records = objectsOf(recordSchema);

/**
 * The marks `store` lists, in the order they were written: each by its link, and a record by the
 * link of the object it records.
 */
export async function listedIn(store: Store): Promise<Link<unknown>[]> {
  const links: Link<unknown>[] = [];
  for await (const mark of store.marks()) {
    links.push((await records.read(mark, store))?.data.object.link ?? mark);
  }
  return links;
}
