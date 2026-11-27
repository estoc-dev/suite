import {
  decodeObject,
  type EncodedObject,
  type Link,
  namedSchemaAt,
  type Reader,
  type Schema,
  type ValueMap,
} from "@estoc/object";
import { linksIn } from "./batch.ts";

/** The store is asked for a blob once, however often the blob is read here. */
export class ClosureReader {
  readonly #start: Link<unknown>;
  readonly #store: Reader;
  readonly #blobs = new Map<Link<unknown>, Promise<Uint8Array>>();
  #failure: { readonly error: unknown } | undefined;

  constructor(start: Link<unknown>, store: Reader) {
    this.#start = start;
    this.#store = store;
  }

  /** The first read that the store failed, or gave no blob for. */
  get failure(): { readonly error: unknown } | undefined {
    return this.#failure;
  }

  get(link: Link<unknown>): Promise<Uint8Array> {
    const bytes = this.#blobs.get(link) ?? this.#read(link);
    this.#blobs.set(link, bytes);
    return bytes;
  }

  async #read(link: Link<unknown>): Promise<Uint8Array> {
    try {
      const bytes = await this.#store.get(link);
      if (bytes === undefined)
        throw new Error(`a scan reads ${this.#start}, and the store does not hold ${link} of its closure`);
      return bytes;
    } catch (error) {
      this.#failure ??= { error };
      throw error;
    }
  }
}

export class ScannedBlob {
  readonly link: Link<unknown>;
  readonly reader: ClosureReader;

  constructor(link: Link<unknown>, reader: ClosureReader) {
    this.link = link;
    this.reader = reader;
  }

  blobAt(link: Link<unknown>): ScannedBlob {
    return link === this.link ? this : new ScannedBlob(link, this.reader);
  }

  /** None where the blob is not an object. */
  async namedSchema(): Promise<Link<Schema> | undefined> {
    return namedSchemaAt(this.link, await this.reader.get(this.link));
  }

  /** The links written in the object, and none where the blob is not an object. */
  async links(): Promise<Iterable<Link<unknown>>> {
    return linksIn(this.link, await this.reader.get(this.link));
  }

  async objectOf<F extends ValueMap>(schema: Schema<F>): Promise<EncodedObject<F> | undefined> {
    const bytes = await this.reader.get(this.link);
    return namedSchemaAt(this.link, bytes) === schema.link ? decodeObject(bytes, schema) : undefined;
  }
}
