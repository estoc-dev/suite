import {
  decodeObject,
  type EncodedObject,
  itself,
  type Link,
  type ObjectValue,
  objectFormat,
  type Reader,
  type Schema,
  type ValueMap,
} from "@estoc/object";

export class ScannedBlob {
  readonly link: Link<unknown>;
  readonly reader: { get(link: Link<unknown>): Promise<Uint8Array> };
  #namedSchema: Promise<Link<Schema> | undefined> | undefined;
  #objectValue: Promise<ObjectValue | undefined> | undefined;
  readonly #objects = new Map<object, unknown>();
  readonly #blobsByLink = new Map<Link<unknown>, ScannedBlob>();
  #readFailure: { readonly error: unknown } | undefined;

  /** `object` is what `link` names where an index derived it, so that it is not read and validated again. */
  constructor(link: Link<unknown>, store: Reader, object?: { readonly schema: { readonly link: Link<Schema> } }) {
    this.link = link;
    if (object !== undefined) {
      this.#objects.set(object.schema, object);
      this.#namedSchema = Promise.resolve(object.schema.link);
    }
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
    if (link === this.link) return this;
    const blob = this.#blobsByLink.get(link) ?? new ScannedBlob(link, this.reader);
    this.#blobsByLink.set(link, blob);
    return blob;
  }

  #readObjectValue(): Promise<ObjectValue | undefined> {
    this.#objectValue ??= this.reader.get(this.link).then((bytes) => {
      try {
        return objectFormat.decode(bytes);
      } catch {
        return undefined;
      }
    });
    return this.#objectValue;
  }

  /** None where the blob is not an object. */
  namedSchema(): Promise<Link<Schema> | undefined> {
    this.#namedSchema ??= this.#readObjectValue().then(
      (object) => object && ((object.schema === itself ? this.link : object.schema) as Link<Schema>),
    );
    return this.#namedSchema;
  }

  /** The links written in the object, and none where the blob is not an object. */
  async links(): Promise<Iterable<Link<unknown>>> {
    const object = await this.#readObjectValue();
    return object === undefined ? [] : objectFormat.links(object);
  }

  async objectOf<F extends ValueMap>(schema: Schema<F>): Promise<EncodedObject<F> | undefined> {
    if (!this.#objects.has(schema)) {
      const isOfSchema = (await this.namedSchema()) === schema.link;
      this.#objects.set(schema, isOfSchema ? decodeObject(await this.reader.get(this.link), schema) : undefined);
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
