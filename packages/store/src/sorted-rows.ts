import type { EncodedObject, Encoding, Fields } from "@estoc/object";
import { DerivedObjects } from "./derived-objects.ts";
import { derivationOf, type FieldNames, type KeyOf, type OrderedIndex, orderOf, type Prefix } from "./source.ts";

/** The rows of an ordered index, each once however many records give it. */
export interface Rows<D, F extends Fields<D>, By extends FieldNames<F>> {
  /**
   * The rows that hold `prefix` in the first fields of the order, one value for each, in the order of
   * the index.
   */
  range(prefix: Prefix<KeyOf<F, By>>): AsyncIterable<EncodedObject<D, F>>;
}

/** What a row holds in a field of the order, as rows are compared by it. */
type KeyPart = number | string | Uint8Array | undefined;

interface KeyedRow<D, F extends Fields<D>> {
  readonly key: readonly KeyPart[];
  readonly row: EncodedObject<D, F>;
}

// biome-ignore-start lint/style/noNonNullAssertion: each index is below the length it is checked against
/** The rows of an ordered index in its order. */
export class SortedRows<D, F extends Fields<D>, By extends FieldNames<F>> implements Rows<D, F, By> {
  readonly #index: OrderedIndex<D, F, By>;
  readonly #derivedObjects: DerivedObjects<D, F>;
  readonly #rows: readonly KeyedRow<D, F>[];

  constructor(
    index: OrderedIndex<D, F, By>,
    derivedObjects: DerivedObjects<D, F> = new DerivedObjects(derivationOf(orderOf(index).index)),
    rows: readonly KeyedRow<D, F>[] = [],
  ) {
    this.#index = index;
    this.#derivedObjects = derivedObjects;
    this.#rows = rows;
  }

  /** The rows of `derivedObjects` in the order: those these are of, then any the index gave after them. */
  including(derivedObjects: DerivedObjects<D, F>): SortedRows<D, F, By> {
    const newRows = derivedObjects.objects.slice(this.#derivedObjects.objects.length);
    if (newRows.length === 0) return this;
    const { index, by } = orderOf(this.#index);
    const { encoding } = derivationOf(index).schema;
    const keyedRows = newRows.map((row) => {
      const data: Fields<D> = row.data;
      // A row that leaves a field out does not hold what every object inherits under its name, such as `constructor`.
      const key = by.map((name) => keyPartOf(Object.hasOwn(data, name) ? data[name] : undefined, encoding));
      return { key, row };
    });
    return new SortedRows(
      this.#index,
      derivedObjects,
      [...this.#rows, ...keyedRows].sort((a, b) => compareKeys(a.key, b.key) || compareParts(a.row.link, b.row.link)),
    );
  }

  async *range(prefix: Prefix<KeyOf<F, By>>): AsyncIterable<EncodedObject<D, F>> {
    const { encoding } = derivationOf(orderOf(this.#index).index).schema;
    const start = prefix.map((value) => keyPartOf(value as D | undefined, encoding));
    const rows = this.#rows;
    let low = 0;
    for (let high = rows.length; low < high; ) {
      const middle = (low + high) >>> 1;
      if (compareKeys(rows[middle]!.key, start) < 0) low = middle + 1;
      else high = middle;
    }
    for (let at = low; at < rows.length && compareKeys(rows[at]!.key.slice(0, start.length), start) === 0; at++)
      yield rows[at]!.row;
  }
}

function keyPartOf<D>(value: D | undefined, encoding: Encoding<D>): KeyPart {
  if (value === undefined) return undefined;
  if (typeof value === "number" || typeof value === "string") return value;
  return encoding.encode(value);
}

/** A key comes before every longer key that starts with it. */
function compareKeys(a: readonly KeyPart[], b: readonly KeyPart[]): number {
  for (let i = 0; i < a.length && i < b.length; i++) {
    const order = compareParts(a[i], b[i]);
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

function compareParts(a: KeyPart, b: KeyPart): number {
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    for (let i = 0; i < a.length && i < b.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return a.length - b.length;
  }
  if (typeof a !== typeof b) return rankOf(a) - rankOf(b);
  return a === b ? 0 : (a as number | string) < (b as number | string) ? -1 : 1;
}

function rankOf(part: KeyPart): number {
  return part === undefined ? 0 : typeof part === "number" ? 1 : typeof part === "string" ? 2 : 3;
}
// biome-ignore-end lint/style/noNonNullAssertion: each index is below the length it is checked against
