import { type EncodedObject, encodeObject, type Fields, type Link, type Reader } from "@estoc/object";
import type { RowsByIndex } from "./scan.ts";
import { ScannedBlob } from "./scanned-blob.ts";
import type { Derivation, ItemFailure, Listing, Origin } from "./source.ts";

/**
 * The rows that an index gives of what a store lists, each once, in the order it first gave them.
 * They are kept beside the store, which does not hold them: an index over this one reads them from
 * here, by link as it reads any blob, with the schema they are written to, which the store need not
 * hold either, and whatever else it reads from the store.
 */
export class DerivedObjects<D, F extends Fields<D>> implements Listing {
  readonly objects: readonly EncodedObject<D, F>[];
  readonly links: readonly Link<unknown>[];
  /**
   * What the index failed on, and what the indexes it reads failed on: these rows are short of
   * whatever those would have come to.
   */
  readonly failures: readonly ItemFailure[];
  readonly #derivation: Derivation<D, F>;
  readonly #objectsByLink: ReadonlyMap<Link<unknown>, EncodedObject<D, F>>;
  /** What each origin of the index listed, all of which these rows are of. */
  readonly #listings: ReadonlyMap<Origin, Listing>;
  readonly #ownFailures: readonly ItemFailure[];

  constructor(
    derivation: Derivation<D, F>,
    objectsByLink: ReadonlyMap<Link<unknown>, EncodedObject<D, F>> = new Map(),
    listings: ReadonlyMap<Origin, Listing> = new Map(),
    ownFailures: readonly ItemFailure[] = [],
  ) {
    this.#derivation = derivation;
    this.objects = [...objectsByLink.values()];
    this.links = [...objectsByLink.keys()];
    this.#objectsByLink = objectsByLink;
    this.#listings = listings;
    this.#ownFailures = ownFailures;
    // Two of the indexes it reads may read one index, whose failures are then listed once.
    this.failures = [...new Set([...[...listings.values()].flatMap((listing) => listing.failures), ...ownFailures])];
  }

  /**
   * These rows, then those that the index gives of what each of its origins lists in `rows` beyond
   * what these are of, each read from `store`. What a source of the index or its `rows` throw on, or
   * give a row of that does not fit the schema, gives no rows of that source and is among the
   * failures from then on, without being read again.
   *
   * @throws when `store` throws, or gives no blob, for a link that is read. Nothing is added then,
   *   as it may give the blob later.
   */
  async adding(store: Reader, rows: RowsByIndex): Promise<DerivedObjects<D, F>> {
    const { schema, parts } = this.#derivation;
    const objectsByLink = new Map(this.#objectsByLink);
    const ownFailures = [...this.#ownFailures];
    const listings = new Map<Origin, Listing>();
    for (const [origin, originParts] of parts) {
      const listing = await origin.listingIn(rows);
      listings.set(origin, listing);
      const readCount = this.#listings.get(origin)?.links.length ?? 0;
      const reader: Reader = { get: (link) => listing.bytesOf(link) ?? store.get(link) };
      for (const link of listing.links.slice(readCount)) {
        const blob = new ScannedBlob(link, reader, listing.objectOf(link));
        for (const part of originParts) {
          const partObjects: EncodedObject<D, F>[] = [];
          try {
            for await (const data of part(blob)) partObjects.push(encodeObject(schema, data));
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
    const isSame = [...listings].every(([origin, listing]) => this.#listings.get(origin) === listing);
    return isSame ? this : new DerivedObjects(this.#derivation, objectsByLink, listings, ownFailures);
  }

  objectOf(link: Link<unknown>): EncodedObject<D, F> | undefined {
    return this.#objectsByLink.get(link);
  }

  bytesOf(link: Link<unknown>): Uint8Array | undefined {
    const object = this.#objectsByLink.get(link);
    if (object !== undefined) return object.bytes;
    const { schema } = this.#derivation;
    if (link === schema.link) return schema.bytes;
    for (const listing of this.#listings.values()) {
      const bytes = listing.bytesOf(link);
      if (bytes !== undefined) return bytes;
    }
    return undefined;
  }
}
