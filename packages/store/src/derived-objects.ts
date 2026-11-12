import { type EncodedObject, encodeObject, type Fields, type Link, type Reader } from "@estoc/object";
import type { RowsByIndex } from "./scan.ts";
import { ScannedBlob } from "./scanned-blob.ts";
import type { Derivation, SourceIndex, SourceObjects } from "./source.ts";

type Links = Iterable<Link<unknown>> | AsyncIterable<Link<unknown>>;

/** The records and blobs that a store lists, or those it has listed since some rows were derived. */
export interface Listed {
  readonly records: Links;
  readonly blobs: Links;
}

/**
 * The rows that an index gives of what a store lists, each once, in the order it first gave them.
 * They are kept beside the store, which does not hold them: an index over this one reads them from
 * here, by link as it reads any blob, and whatever else it reads from the store.
 */
export class DerivedObjects<D, F extends Fields<D>> implements SourceObjects {
  readonly objects: readonly EncodedObject<D, F>[];
  readonly #derivation: Derivation<D, F>;
  readonly #objectsByLink: ReadonlyMap<Link<unknown>, EncodedObject<D, F>>;
  /** The rows of each index that the index reads, all of which these are of. */
  readonly #sources: ReadonlyMap<SourceIndex, SourceObjects>;

  constructor(
    derivation: Derivation<D, F>,
    objectsByLink: ReadonlyMap<Link<unknown>, EncodedObject<D, F>> = new Map(),
    sources: ReadonlyMap<SourceIndex, SourceObjects> = new Map(),
  ) {
    this.#derivation = derivation;
    this.objects = [...objectsByLink.values()];
    this.#objectsByLink = objectsByLink;
    this.#sources = sources;
  }

  /**
   * These rows, then those that the index gives of `records` and `blobs`, each read from `store`,
   * and of the rows that each index it reads has in `rows` beyond those these are of.
   *
   * @throws as `scan` does.
   */
  async adding({ records, blobs }: Listed, store: Reader, rows: RowsByIndex): Promise<DerivedObjects<D, F>> {
    const { schema, parts } = this.#derivation;
    const objectsByLink = new Map(this.#objectsByLink);
    const sources = new Map<SourceIndex, SourceObjects>();
    for (const [origin, originParts] of parts) {
      let links: Links;
      let reader = store;
      if (origin === "records") links = records;
      else if (origin === "blobs") links = blobs;
      else {
        const sourceObjects = await origin.objectsIn(rows);
        const readCount = this.#sources.get(origin)?.objects.length ?? 0;
        links = sourceObjects.objects.slice(readCount).map(({ link }) => link);
        reader = { get: (link) => sourceObjects.bytesOf(link) ?? store.get(link) };
        sources.set(origin, sourceObjects);
      }
      for await (const link of links) {
        const blob = new ScannedBlob(link, reader);
        for (const part of originParts) {
          const partObjects: EncodedObject<D, F>[] = [];
          try {
            for await (const data of part(blob)) partObjects.push(encodeObject(schema, data));
          } catch (error) {
            // Anyone can send a blob, and a scan that threw on one would fail from then on.
            // A store that failed still fails the scan, by the blob's `readFailure`.
            if (origin !== "blobs") throw error;
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
      [...sources].every(([origin, sourceObjects]) => this.#sources.get(origin) === sourceObjects);
    return isSame ? this : new DerivedObjects(this.#derivation, objectsByLink, sources);
  }

  bytesOf(link: Link<unknown>): Uint8Array | undefined {
    const object = this.#objectsByLink.get(link);
    if (object !== undefined) return object.bytes;
    for (const source of this.#sources.values()) {
      const bytes = source.bytesOf(link);
      if (bytes !== undefined) return bytes;
    }
    return undefined;
  }
}
