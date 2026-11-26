import { type EncodedObject, encodeObject, type Link, linkOf, type Reader, type ValueMap } from "@estoc/object";
import type { BlobSet } from "./scan.ts";
import { ScannedBlob } from "./scanned-blob.ts";
import { type Rows, SortedRows } from "./sorted-rows.ts";
import type { Derivation, FieldNames, ItemFailure, Listing, Origin } from "./source.ts";

export class DerivedObjects<F extends ValueMap> implements Listing, Rows<F> {
  /** What comes of adding to these starts with them, in this order. */
  readonly objects: readonly EncodedObject<F>[];
  readonly links: readonly Link<unknown>[];
  readonly failures: readonly ItemFailure[];
  readonly blobCount: number;
  readonly #derivation: Derivation<F>;
  readonly #objectsByLink: ReadonlyMap<Link<unknown>, EncodedObject<F>>;
  readonly #listings: ReadonlyMap<Origin, Listing>;
  readonly #ownFailures: readonly ItemFailure[];
  readonly #sortedRowsByOrder: Map<string, unknown>;

  constructor(
    derivation: Derivation<F>,
    objectsByLink: ReadonlyMap<Link<unknown>, EncodedObject<F>> = new Map(),
    listings: ReadonlyMap<Origin, Listing> = new Map(),
    ownFailures: readonly ItemFailure[] = [],
    blobCount = 0,
    sortedRowsByOrder: ReadonlyMap<string, unknown> = new Map(),
  ) {
    this.#derivation = derivation;
    this.objects = [...objectsByLink.values()];
    this.links = [...objectsByLink.keys()];
    this.#objectsByLink = objectsByLink;
    this.#listings = listings;
    this.#ownFailures = ownFailures;
    this.blobCount = blobCount;
    // A copy, as these come to be sorted with rows that those they were added to do not hold.
    this.#sortedRowsByOrder = new Map(sortedRowsByOrder);
    // Two of the indexes it reads may read one index, whose failures are then listed once.
    this.failures = [...new Set([...[...listings.values()].flatMap((listing) => listing.failures), ...ownFailures])];
  }

  async adding(store: Reader, blobSet: BlobSet): Promise<DerivedObjects<F>> {
    const { schema, parts } = this.#derivation;
    const listings = new Map<Origin, Listing>();
    for (const origin of parts.keys()) listings.set(origin, await origin.listingIn(blobSet));
    if ([...listings].every(([origin, listing]) => this.#listings.get(origin) === listing)) return this;
    const objectsByLink = new Map(this.#objectsByLink);
    const ownFailures = [...this.#ownFailures];
    for (const [origin, listing] of listings) {
      const originParts = parts.get(origin) ?? [];
      const readCount = this.#listings.get(origin)?.links.length ?? 0;
      const reader: Reader = { get: (link) => listing.bytesOf(link) ?? store.get(link) };
      for (const link of listing.links.slice(readCount)) {
        const blob = new ScannedBlob(link, reader, listing.objectOf(link));
        for (const part of originParts) {
          const partObjects: EncodedObject<F>[] = [];
          try {
            for await (const data of part.rowsOf(blob)) partObjects.push(encodeObject(schema, data));
          } catch (error) {
            ownFailures.push({ item: link, error });
            continue;
          }
          for (const object of partObjects) if (!objectsByLink.has(object.link)) objectsByLink.set(object.link, object);
        }
        // What a part threw because the store failed is not a failure of the part.
        const readFailure = blob.readFailure;
        if (readFailure !== undefined) throw readFailure.error;
      }
    }
    return new DerivedObjects(
      this.#derivation,
      objectsByLink,
      listings,
      ownFailures,
      blobSet.blobCount,
      this.#sortedRowsByOrder,
    );
  }

  orderedBy<const By extends FieldNames<F>>(...by: By): SortedRows<F, By> {
    const order = JSON.stringify(by);
    // What is kept under the names of some fields are rows sorted by those fields.
    const kept = this.#sortedRowsByOrder.get(order) as SortedRows<F, By> | undefined;
    const sortedRows = (kept ?? new SortedRows(this.#derivation.schema, by)).including(this.objects);
    this.#sortedRowsByOrder.set(order, sortedRows);
    return sortedRows;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<EncodedObject<F>> {
    yield* this.objects;
  }

  objectOf(link: Link<unknown>): EncodedObject<F> | undefined {
    return this.#objectsByLink.get(link);
  }

  bytesOf(link: Link<unknown>): Uint8Array | undefined {
    const object = this.#objectsByLink.get(link);
    if (object !== undefined) return object.bytes;
    const schemaBlob = this.#derivation.schema.blobs.find((bytes) => linkOf(bytes) === link);
    if (schemaBlob !== undefined) return schemaBlob;
    for (const listing of this.#listings.values()) {
      const bytes = listing.bytesOf(link);
      if (bytes !== undefined) return bytes;
    }
    return undefined;
  }
}
