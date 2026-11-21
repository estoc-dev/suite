import { type EncodedObject, encodeObject, type Link, linkOf, type Reader, type ValueMap } from "@estoc/object";
import type { RowsByIndex } from "./scan.ts";
import { ScannedBlob } from "./scanned-blob.ts";
import type { Derivation, ItemFailure, Listing, Origin } from "./source.ts";

export class DerivedObjects<F extends ValueMap> implements Listing {
  readonly objects: readonly EncodedObject<F>[];
  readonly links: readonly Link<unknown>[];
  readonly failures: readonly ItemFailure[];
  readonly #derivation: Derivation<F>;
  readonly #objectsByLink: ReadonlyMap<Link<unknown>, EncodedObject<F>>;
  readonly #listings: ReadonlyMap<Origin, Listing>;
  readonly #ownFailures: readonly ItemFailure[];

  constructor(
    derivation: Derivation<F>,
    objectsByLink: ReadonlyMap<Link<unknown>, EncodedObject<F>> = new Map(),
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

  async adding(store: Reader, rows: RowsByIndex): Promise<DerivedObjects<F>> {
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
          const partObjects: EncodedObject<F>[] = [];
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
