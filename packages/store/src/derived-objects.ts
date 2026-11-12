import { type EncodedObject, encodeObject, type Fields, type Link, type Reader } from "@estoc/object";
import type { RowsByIndex } from "./scan.ts";
import { ScannedBlob } from "./scanned-blob.ts";
import type { Derivation, Listing, Origin } from "./source.ts";

/**
 * The rows that an index gives of what a store lists, each once, in the order it first gave them.
 * They are kept beside the store, which does not hold them: an index over this one reads them from
 * here, by link as it reads any blob, with the schema they are written to, which the store need not
 * hold either, and whatever else it reads from the store.
 */
export class DerivedObjects<D, F extends Fields<D>> implements Listing {
  readonly objects: readonly EncodedObject<D, F>[];
  readonly links: readonly Link<unknown>[];
  readonly #derivation: Derivation<D, F>;
  readonly #objectsByLink: ReadonlyMap<Link<unknown>, EncodedObject<D, F>>;
  /** What each origin of the index listed, all of which these rows are of. */
  readonly #listings: ReadonlyMap<Origin, Listing>;

  constructor(
    derivation: Derivation<D, F>,
    objectsByLink: ReadonlyMap<Link<unknown>, EncodedObject<D, F>> = new Map(),
    listings: ReadonlyMap<Origin, Listing> = new Map(),
  ) {
    this.#derivation = derivation;
    this.objects = [...objectsByLink.values()];
    this.links = [...objectsByLink.keys()];
    this.#objectsByLink = objectsByLink;
    this.#listings = listings;
  }

  /**
   * These rows, then those that the index gives of what each of its origins lists in `rows` beyond
   * what these are of, each read from `store`.
   *
   * @throws as `scan` does.
   */
  async adding(store: Reader, rows: RowsByIndex): Promise<DerivedObjects<D, F>> {
    const { schema, parts } = this.#derivation;
    const objectsByLink = new Map(this.#objectsByLink);
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
            // A store that failed still fails the scan, by the blob's `readFailure`.
            if (!origin.listsWhatAnyoneCanSend) throw error;
            continue;
          }
          for (const object of partObjects) if (!objectsByLink.has(object.link)) objectsByLink.set(object.link, object);
        }
        const failure = blob.readFailure;
        if (failure !== undefined) throw failure.error;
      }
    }
    const isSame =
      objectsByLink.size === this.#objectsByLink.size &&
      [...listings].every(([origin, listing]) => this.#listings.get(origin) === listing);
    return isSame ? this : new DerivedObjects(this.#derivation, objectsByLink, listings);
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
