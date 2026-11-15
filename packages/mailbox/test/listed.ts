import { type Link, objectsOf } from "@estoc/object";
import { type PrivateStore, recordSchema } from "@estoc/store";

const records = objectsOf(recordSchema);

/**
 * What `privateStore` lists, in the order it was written: each mark by its link, and a record by
 * the link of the object it records.
 */
export async function listedIn(privateStore: PrivateStore): Promise<Link<unknown>[]> {
  const links: Link<unknown>[] = [];
  for await (const mark of privateStore.marks()) {
    links.push((await records.read(mark, privateStore))?.data.object.link ?? mark);
  }
  return links;
}
