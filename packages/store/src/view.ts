import type { Fields } from "@estoc/object";
import { scan } from "./scan.ts";
import type { Rows } from "./sorted-rows.ts";
import type { FieldNames, OrderedIndex } from "./source.ts";
import type { Store } from "./store.ts";

/**
 * A value worked out from the rows of an index when they are read, such as
 * the latest of the objects that give rows under one prefix: what depends on
 * what else is written. The index says which objects are read and `read`
 * what their rows come to, so an application can give the one and a module
 * that knows what the objects mean the other.
 */
export interface View<D, F extends Fields<D>, By extends FieldNames<F>, V> {
  readonly index: OrderedIndex<D, F, By>;
  /**
   * The value of `rows`, with `store` giving by link the objects they name,
   * and where it took each in. It may be a promise, as when the value is
   * worked out from all the rows at once.
   */
  read(rows: Rows<D, F, By>, store: Pick<Store, "get" | "positionOf">): V;
}

/**
 * The value of `view` for what `store` holds now. The store may also be a `PrivateStore` or a
 * `StagedStore`.
 *
 * - The index is scanned from the store and read with the store, so the rows, the objects they name
 *   and where each was taken in come from one store.
 * - Later writes do not change the rows the value is worked out from; it takes them in when viewed
 *   again. A value that asks the store later where a blob was taken in finds where the store has
 *   taken it in by then, as for a blob of a staged batch once it is committed.
 *
 * @throws as `scan` does.
 */
export async function view<D, F extends Fields<D>, By extends FieldNames<F>, V>(
  store: Pick<Store, "get" | "records" | "positionOf">,
  view: View<D, F, By, V>,
): Promise<Awaited<V>> {
  return await view.read(await scan(store, view.index), store);
}
