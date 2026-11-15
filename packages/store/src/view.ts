import type { Reader, ValueMap } from "@estoc/object";
import type { PrivateStore } from "./private-store.ts";
import { scan } from "./scan.ts";
import type { SecretStore } from "./secret-store.ts";
import type { Rows } from "./sorted-rows.ts";
import type { FieldNames, OrderedIndex } from "./source.ts";
import type { StagedStore, Store } from "./store.ts";

/**
 * A value worked out from the rows of an index when they are read, such as
 * the latest of the objects that give rows under one prefix: what depends on
 * what else is written. The index says which objects are read and `read`
 * what their rows come to, so an application can give the one and a module
 * that knows what the objects mean the other.
 */
export interface View<F extends ValueMap, By extends FieldNames<F>, V> {
  readonly index: OrderedIndex<F, By>;
  /**
   * The value of `rows`, with `reader` giving by link the objects they name.
   * It may be a promise, as when the value is worked out from all the rows at
   * once.
   */
  read(rows: Rows<F, By>, reader: Reader): V;
}

/**
 * The value of `view` for what `store` holds now.
 *
 * - The index is scanned from the store and read with the store, so the rows and the objects they
 *   name come from one store.
 * - Later writes do not change the rows the value is worked out from; it takes them in when viewed
 *   again.
 *
 * @throws as `scan` does.
 */
export async function view<F extends ValueMap, By extends FieldNames<F>, V>(
  store: Store | StagedStore | PrivateStore | SecretStore,
  view: View<F, By, V>,
): Promise<Awaited<V>> {
  return await view.read(await scan(store, view.index), store);
}
