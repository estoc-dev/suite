import type { Fields, Reader } from "@estoc/object";
import { type Index, type Key, type Rows, scan } from "./scan.ts";
import type { Store } from "./store.ts";

/**
 * A value worked out from the rows of an index when they are read, such as
 * the latest of the objects that give rows under one prefix: what depends on
 * what else is written. The index says which objects are read and `read`
 * what their rows come to, so an application can give the one and a module
 * that knows what the objects mean the other.
 */
export interface View<D, K extends Key, V, F extends Fields<D> = Fields<D>> {
  readonly index: Index<D, K, F>;
  /** The value of `rows`, with `reader` giving by link the objects they name. */
  read(rows: Rows<K>, reader: Reader): V;
}

/**
 * The value of `view` for what `store` holds now: its index scanned from the
 * store, read with the store as the reader, so that the rows and the objects
 * they name come from one store. Later writes do not change the value; it
 * takes them in when viewed again.
 */
export async function view<D, K extends Key, V, F extends Fields<D>>(store: Store, view: View<D, K, V, F>): Promise<V> {
  return view.read(await scan(store, view.index), store);
}
