import {
  type EncodedObject,
  memberOf,
  ObjectValue,
  objectFormat,
  type Schema,
  type Value,
  type ValueMap,
} from "@estoc/object";
import type { FieldNames, ItemFailure, KeyOf, Prefix } from "./source.ts";

/**
 * Going through them gives each row once. The order they come in is no part of what a scan gives,
 * and `orderedBy` is how to ask for one.
 */
export interface Rows<F extends ValueMap> extends AsyncIterable<EncodedObject<F>> {
  /**
   * - Rows keep each order they are asked for, so the same order asked again sorts nothing.
   * - Those of a later scan of the store take the orders kept by then with the sort keys in them,
   *   and work out keys for the rows added alone.
   * - Those of a staged batch have the rows of its store put in the order first, which those keep,
   *   and work out keys for the rows the batch adds alone.
   */
  orderedBy<const By extends FieldNames<F>>(...by: By): OrderedRows<F, By>;
  /**
   * What the index, and each index it reads, failed on. These rows are short of whatever those
   * would have given, in any order and under any prefix: what failed gave no row to tell where it
   * belongs.
   */
  readonly failures: readonly ItemFailure[];
  /**
   * How many blobs were held where the rows were read: by the store, or by the staged store with
   * its batch, which is not the count of the store it is staged on. Either only grows and the rows
   * come of the blobs held alone, so the rows of the same index read there while it holds as many
   * are these. Of a collection it is how many members it has, which is the same at every scan.
   */
  readonly blobCount: number;
}

export interface OrderedRows<F extends ValueMap, By extends FieldNames<F>> {
  range(prefix: Prefix<KeyOf<F, By>>): AsyncIterable<EncodedObject<F>>;
}

type KeyPart = number | string | Uint8Array | undefined;

interface KeyedRow<F extends ValueMap> {
  readonly key: readonly KeyPart[];
  readonly row: EncodedObject<F>;
}

// biome-ignore-start lint/style/noNonNullAssertion: each index is below the length it is checked against
export class SortedRows<F extends ValueMap, By extends FieldNames<F>> implements OrderedRows<F, By> {
  readonly #schema: Schema<F>;
  readonly #by: By;
  readonly #rows: readonly KeyedRow<F>[];

  constructor(schema: Schema<F>, by: By, rows: readonly KeyedRow<F>[] = []) {
    this.#schema = schema;
    this.#by = by;
    this.#rows = rows;
  }

  /** `rows` start with the rows that these were sorted from, in the same order. */
  including(rows: readonly EncodedObject<F>[]): SortedRows<F, By> {
    if (rows.length === this.#rows.length) return this;
    const keyedRows = rows.slice(this.#rows.length).map((row) => ({
      key: this.#by.map((name) => keyPartOf(name, memberOf(row.data, name), this.#schema)),
      row,
    }));
    return new SortedRows(
      this.#schema,
      this.#by,
      [...this.#rows, ...keyedRows].sort((a, b) => compareKeys(a.key, b.key) || compareParts(a.row.link, b.row.link)),
    );
  }

  async *range(prefix: Prefix<KeyOf<F, By>>): AsyncIterable<EncodedObject<F>> {
    const start = prefix.map((value, at) => keyPartOf(this.#by[at]!, value as Value | undefined, this.#schema));
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

function keyPartOf(name: string, value: Value | undefined, { link }: Schema): KeyPart {
  if (value === undefined) return undefined;
  if (typeof value === "number" || typeof value === "string") return value;
  // The object format writes objects, not a value on its own, so the bytes are those of the row
  // that would hold the value in that field alone.
  return objectFormat.encode(new ObjectValue(link, { [name]: value }));
}

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
