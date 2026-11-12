import {
  decodeObject,
  type EncodedObject,
  type Fields,
  type Link,
  type Reader,
  type Schema,
  schemaOf,
} from "@estoc/object";

/**
 * A record, another blob a store holds, or a row of another index, as the parts of an index read
 * it, so that what they share is done once.
 */
export class ScannedBlob {
  readonly link: Link<unknown>;
  /** The blobs of its closure, each read from the store once. */
  readonly reader: { get(link: Link<unknown>): Promise<Uint8Array> };
  readonly #schemas = new Map<object, Link<unknown>>();
  readonly #objects = new Map<object, unknown>();
  #readFailure: { readonly error: unknown } | undefined;

  constructor(link: Link<unknown>, store: Reader) {
    this.link = link;
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

  /** The first error that reading a blob of its closure threw, whether or not what read it caught it. */
  get readFailure(): { readonly error: unknown } | undefined {
    return this.#readFailure;
  }

  /**
   * The object read with `schema`, or `undefined` when it is written to another schema. The schema
   * it names is read once for each encoding, and the object once for each schema.
   *
   * @throws where `schemaOf` and `decodeObject` throw.
   */
  async objectOf<D, F extends Fields<D>>(schema: Schema<D, F>): Promise<EncodedObject<D, F> | undefined> {
    if (!this.#objects.has(schema)) {
      const bytes = await this.reader.get(this.link);
      const schemaLink = this.#schemas.get(schema.encoding) ?? schemaOf(bytes, schema.encoding);
      this.#schemas.set(schema.encoding, schemaLink);
      this.#objects.set(schema, schemaLink === schema.link ? decodeObject(bytes, schema) : undefined);
    }
    return this.#objects.get(schema) as EncodedObject<D, F> | undefined;
  }
}

/** A reader that gets each blob with `get` once and keeps it: a link names one blob. */
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
