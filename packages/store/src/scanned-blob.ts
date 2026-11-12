import {
  decodeObject,
  type EncodedObject,
  type Encoding,
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
  readonly #schemas = new Map<object, Link<unknown> | undefined>();
  readonly #objects = new Map<object, unknown>();
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

  /** The first error that reading a blob of its closure threw, whether or not what read it caught it. */
  get readFailure(): { readonly error: unknown } | undefined {
    return this.#readFailure;
  }

  /**
   * The object read with `schema`, or `undefined` when it is not an object in the encoding of
   * `schema`, as an attachment is not, or is written to another schema. The schema it names is read
   * once for each encoding, and the object once for each schema.
   *
   * @throws where `decodeObject` throws, as when it names `schema` and does not fit it.
   */
  async objectOf<D, F extends Fields<D>>(schema: Schema<D, F>): Promise<EncodedObject<D, F> | undefined> {
    if (!this.#objects.has(schema)) {
      const bytes = await this.reader.get(this.link);
      if (!this.#schemas.has(schema.encoding))
        this.#schemas.set(schema.encoding, namedSchemaOf(bytes, schema.encoding));
      const isOfSchema = this.#schemas.get(schema.encoding) === schema.link;
      this.#objects.set(schema, isOfSchema ? decodeObject(bytes, schema) : undefined);
    }
    return this.#objects.get(schema) as EncodedObject<D, F> | undefined;
  }
}

/** The schema that `bytes` name as an object in `encoding`, or `undefined` when they are not one. */
function namedSchemaOf<D>(bytes: Uint8Array, encoding: Encoding<D>): Link<unknown> | undefined {
  try {
    return schemaOf(bytes, encoding);
  } catch {
    return undefined;
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
