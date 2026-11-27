import {
  type EncodedObject,
  encodeObject,
  type Link,
  type LinkValue,
  linkOf,
  type Reader,
  type ValueMap,
} from "@estoc/object";
import type { BlobSet } from "./scan.ts";
import { ClosureReader, ScannedBlob } from "./scanned-blob.ts";
import { type Rows, SortedRows } from "./sorted-rows.ts";
import {
  type Derivation,
  type FieldNames,
  type ItemFailure,
  LinkedBlobError,
  type Listing,
  type Origin,
} from "./source.ts";

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
  readonly #base: DerivedObjects<F> | undefined;
  readonly #sortedRowsByOrder: Map<string, unknown>;
  readonly #linksByField = new Map<string, Listing>();

  constructor(
    derivation: Derivation<F>,
    objectsByLink: ReadonlyMap<Link<unknown>, EncodedObject<F>> = new Map(),
    listings: ReadonlyMap<Origin, Listing> = new Map(),
    ownFailures: readonly ItemFailure[] = [],
    blobCount = 0,
    base?: DerivedObjects<F>,
    sortedRowsByOrder = new Map<string, unknown>(),
  ) {
    this.#derivation = derivation;
    this.objects = [...objectsByLink.values()];
    this.links = [...objectsByLink.keys()];
    this.#objectsByLink = objectsByLink;
    this.#listings = listings;
    this.#ownFailures = ownFailures;
    this.blobCount = blobCount;
    this.#base = base;
    this.#sortedRowsByOrder = sortedRowsByOrder;
    // Two of the indexes it reads may read one index, whose failures are then listed once.
    this.failures = [...new Set([...[...listings.values()].flatMap((listing) => listing.failures), ...ownFailures])];
  }

  /**
   * For whoever keeps the rows it gives in place of these. Those do not hold these, and take a copy
   * of the orders these keep: they come to be sorted with rows that these do not hold.
   */
  adding(store: Reader, blobSet: BlobSet): Promise<DerivedObjects<F>> {
    return this.#adding(store, blobSet, false);
  }

  /**
   * For rows read while these stay held, as those of a staged batch are with those of its store.
   * They have these put in an order first, so that these keep it for whatever is added to them next.
   */
  addingOnTop(store: Reader, blobSet: BlobSet): Promise<DerivedObjects<F>> {
    return this.#adding(store, blobSet, true);
  }

  async #adding(store: Reader, blobSet: BlobSet, isOnTop: boolean): Promise<DerivedObjects<F>> {
    const { schema, partsByOrigin } = this.#derivation;
    const listings = new Map<Origin, Listing>();
    for (const origin of partsByOrigin.keys()) listings.set(origin, await origin.listingIn(blobSet));
    if ([...listings].every(([origin, listing]) => this.#listings.get(origin) === listing)) return this;
    const objectsByLink = new Map(this.#objectsByLink);
    const ownFailures = [...this.#ownFailures];
    for (const [origin, listing] of listings) {
      const originParts = partsByOrigin.get(origin) ?? [];
      const readCount = this.#listings.get(origin)?.links.length ?? 0;
      const reader: Reader = { get: (link) => listing.bytesOf(link) ?? store.get(link) };
      for (const link of listing.links.slice(readCount)) {
        const closureReader = new ClosureReader(link, reader);
        const blob = new ScannedBlob(link, closureReader);
        for (const part of originParts) {
          const partObjects: EncodedObject<F>[] = [];
          try {
            for await (const data of part.rowsOf(blob)) partObjects.push(encodeObject(schema, data));
          } catch (error) {
            ownFailures.push(error instanceof LinkedBlobError ? error.failure : { item: link, error });
            continue;
          }
          for (const object of partObjects) if (!objectsByLink.has(object.link)) objectsByLink.set(object.link, object);
        }
        // What a part threw because the store failed is not a failure of the part.
        if (closureReader.failure !== undefined) throw closureReader.failure.error;
      }
    }
    return new DerivedObjects(
      this.#derivation,
      objectsByLink,
      listings,
      ownFailures,
      blobSet.blobCount,
      isOnTop ? this : this.#base,
      isOnTop ? undefined : new Map(this.#sortedRowsByOrder),
    );
  }

  orderedBy<const By extends FieldNames<F>>(...by: By): SortedRows<F, By> {
    const order = JSON.stringify(by);
    // The orders kept are of the rows of one index, each under all the fields it is by, in turn. So
    // what is kept under these fields is rows of this schema sorted by them.
    const kept = (this.#sortedRowsByOrder.get(order) as SortedRows<F, By> | undefined) ?? this.#base?.orderedBy(...by);
    const sortedRows = (kept ?? new SortedRows(this.#derivation.schema, by)).including(this.objects);
    this.#sortedRowsByOrder.set(order, sortedRows);
    return sortedRows;
  }

  /**
   * In the order the rows first link to them, so what comes of adding to these rows lists these
   * links first. The same listing is given for these rows each time, by which what reads it sees
   * that nothing was added.
   */
  linksAt<N extends string, T>(this: DerivedObjects<Readonly<Record<N, LinkValue<T>>>>, field: N): Listing<T> {
    // The listings kept are of these rows, each under the field its links are at.
    const kept = this.#linksByField.get(field) as Listing<T> | undefined;
    if (kept !== undefined) return kept;
    const links = new Set(this.objects.map(({ data }) => data[field].link));
    const listing = {
      links: [...links],
      failures: this.failures,
      bytesOf: (link: Link<unknown>) => this.bytesOf(link),
    };
    this.#linksByField.set(field, listing);
    return listing;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<EncodedObject<F>> {
    yield* this.objects;
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
