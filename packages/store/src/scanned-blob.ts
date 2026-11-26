import {
  decodeObject,
  type EncodedObject,
  type Link,
  namedSchemaOf,
  type Reader,
  type Schema,
  type ValueMap,
} from "@estoc/object";

export class ScannedBlob {
  readonly link: Link<unknown>;
  readonly reader: { get(link: Link<unknown>): Promise<Uint8Array> };
  #namedSchema: { readonly link: Link<unknown> | undefined } | undefined;
  readonly #objects = new Map<object, unknown>();
  readonly #blobsByLink = new Map<Link<unknown>, ScannedBlob>();
  #readFailure: { readonly error: unknown } | undefined;

  /** `object` is what `link` names where an index derived it, so that it is not read and validated again. */
  constructor(link: Link<unknown>, store: Reader, object?: { readonly schema: object }) {
    this.link = link;
    if (object !== undefined) this.#objects.set(object.schema, object);
    this.reader = readerOnce(async (blob) => {
      try {
        const bytes = await store.get(blob);
        if (bytes === undefined) throw new Error(`the store lists ${link} but does not hold ${blob} of its closure`);
        return bytes;
      } catch (error) {
        this.#readFailure ??= { error };
        throw error;
      }
    });
  }

  get readFailure(): { readonly error: unknown } | undefined {
    return this.#readFailure;
  }

  /** A blob of the closure of this one, the same one for a link however often it is asked for. */
  blobAt(link: Link<unknown>): ScannedBlob {
    const blob = this.#blobsByLink.get(link) ?? new ScannedBlob(link, this.reader);
    this.#blobsByLink.set(link, blob);
    return blob;
  }

  async objectOf<F extends ValueMap>(schema: Schema<F>): Promise<EncodedObject<F> | undefined> {
    if (!this.#objects.has(schema)) {
      const bytes = await this.reader.get(this.link);
      this.#namedSchema ??= { link: namedSchemaOf(bytes) };
      const isOfSchema = this.#namedSchema.link === schema.link;
      this.#objects.set(schema, isOfSchema ? decodeObject(bytes, schema) : undefined);
    }
    return this.#objects.get(schema) as EncodedObject<F> | undefined;
  }
}

function readerOnce(get: (link: Link<unknown>) => Promise<Uint8Array>): {
  get(link: Link<unknown>): Promise<Uint8Array>;
} {
  const blobs = new Map<Link<unknown>, Promise<Uint8Array>>();
  return {
    get(link) {
      const bytes = blobs.get(link) ?? get(link);
      blobs.set(link, bytes);
      return bytes;
    },
  };
}
