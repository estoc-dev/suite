import type { Reader, ValueMap } from "@estoc/object";
import type { Index } from "./collection.ts";
import type { Rows } from "./sorted-rows.ts";
import type { StagedStore, Store } from "./store.ts";

export interface View<F extends ValueMap, V> {
  readonly index: Index<F>;
  read(rows: Rows<F>, reader: Reader): V;
}

/**
 * Later writes do not change the rows the value is worked out from; it takes them in when viewed
 * again.
 */
export async function view<F extends ValueMap, V>(store: Store | StagedStore, view: View<F, V>): Promise<Awaited<V>> {
  return await view.read(await store.scan(view.index), store);
}
