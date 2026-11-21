import type { Reader, ValueMap } from "@estoc/object";
import { scan } from "./scan.ts";
import type { Rows } from "./sorted-rows.ts";
import type { FieldNames, OrderedIndex } from "./source.ts";
import type { StagedStore, Store } from "./store.ts";

export interface View<F extends ValueMap, By extends FieldNames<F>, V> {
  readonly index: OrderedIndex<F, By>;
  read(rows: Rows<F, By>, reader: Reader): V;
}

/**
 * Later writes do not change the rows the value is worked out from; it takes them in when viewed
 * again.
 */
export async function view<F extends ValueMap, By extends FieldNames<F>, V>(
  store: Store | StagedStore,
  view: View<F, By, V>,
): Promise<Awaited<V>> {
  return await view.read(await scan(store, view.index), store);
}
