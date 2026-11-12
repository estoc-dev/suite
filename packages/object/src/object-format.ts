import { bytesToHex } from "@noble/hashes/utils.js";
import { decode, encode, rfc8949EncodeOptions, Tagged } from "cborg";
import { type Encoding, type Fields, type Itself, itself } from "./encoding.ts";
import { digestOf, isLink, type Link } from "./link.ts";

// "eof!" in ASCII, so that the bytes of every object start with the name of the format.
const objectTag = 0x656f6621;
// Registered with IANA as a SHA-256 hash value.
const linkTag = 18540;
const itselfText = "self";

declare const marksLink: unique symbol;

class UntypedLinkValue {
  // Keeps a map with a `link` member from passing as a link where the types are checked.
  declare readonly [marksLink]: true;
  readonly link: Link<unknown>;

  constructor(link: Link<unknown>) {
    if (!isLink(link)) throw new Error("a link is sha256: and 64 lowercase hex digits");
    this.link = link;
  }
}

/**
 * A link in data. CBOR marks a link with a tag, so in memory it is a value of
 * its own, and a string or bytes are what they are whatever they hold. `T` is
 * what the blob it names is read as, as in a `Link<T>`.
 */
// `T` is kept out of the class, which TypeScript would resolve when it checks that data holding
// the link is data of the format: two schemas whose objects link to each other would then refer to
// themselves.
export type LinkValue<T> = UntypedLinkValue & { readonly link: Link<T> };

/** @throws when `link` is not a link. */
export const LinkValue = UntypedLinkValue as new <T>(link: Link<T>) => LinkValue<T>;

/** An object: the fields of its data, and the schema they are written to. */
export class ObjectValue {
  readonly schema: Link<unknown> | Itself;
  readonly data: Fields<Value>;

  constructor(schema: Link<unknown> | Itself, data: Fields<Value>) {
    this.schema = schema;
    this.data = data;
  }
}

export interface ValueMap {
  readonly [key: string]: Value;
}

/**
 * A value of the object format. In data it is an integer, bytes, a string, a
 * boolean, an array, a map by string keys or a link. An `ObjectValue` is the
 * value that a blob holds as a whole, and is refused inside data.
 */
export type Value =
  | boolean
  | number
  | string
  | Uint8Array
  | readonly Value[]
  | ValueMap
  | UntypedLinkValue
  | ObjectValue;

function isMap(value: object): value is ValueMap {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isValueMap(value: Value): value is ValueMap {
  return typeof value === "object" && isMap(value);
}

function integerOf(value: number | bigint): number {
  if (!Number.isSafeInteger(value)) throw new Error("a number is an integer of magnitude up to 2^53 - 1");
  return value as number;
}

const loneSurrogate = /\p{Surrogate}/u;

function stringOf(value: string): string {
  if (loneSurrogate.test(value)) throw new Error("a string holds no lone surrogate");
  return value;
}

function cborValueOf(value: Value): unknown {
  if (typeof value === "boolean" || value instanceof Uint8Array) return value;
  if (typeof value === "number" || typeof value === "bigint") return integerOf(value);
  if (typeof value === "string") return stringOf(value);
  if (Array.isArray(value)) return Array.from(value, cborValueOf);
  if (value instanceof LinkValue) return new Tagged(linkTag, digestOf(value.link));
  if (value instanceof ObjectValue) throw new Error("an object is a blob as a whole, and data holds none");
  if (typeof value === "object" && value !== null && isMap(value)) return cborMapOf(value);
  throw new Error("not a value of the object format");
}

function cborMapOf(map: ValueMap): Map<string, unknown> {
  return new Map(Object.entries(map).map(([key, value]) => [stringOf(key), cborValueOf(value)]));
}

function dataValueOf(value: unknown): Value {
  if (typeof value === "boolean" || typeof value === "string" || value instanceof Uint8Array) return value;
  if (typeof value === "number" || typeof value === "bigint") return integerOf(value);
  if (Array.isArray(value)) return value.map(dataValueOf);
  if (value instanceof Map) return dataMapOf(value);
  if (value instanceof Tagged && value.tag === linkTag) {
    const digest: unknown = value.value;
    if (!(digest instanceof Uint8Array) || digest.length !== 32) throw new Error("a link is the 32 bytes of a SHA-256");
    return new LinkValue(`sha256:${bytesToHex(digest)}` as const);
  }
  if (value instanceof Tagged) throw new Error("an object is a blob as a whole, and data holds none");
  throw new Error("not a value of the object format");
}

function dataMapOf(map: Map<unknown, unknown>): ValueMap {
  return Object.fromEntries(
    Array.from(map, ([key, value]) => {
      if (typeof key !== "string") throw new Error("the keys of a map are strings");
      return [key, dataValueOf(value)];
    }),
  );
}

function objectValueOf(value: unknown): ObjectValue {
  if (!(value instanceof Tagged) || value.tag !== objectTag)
    throw new Error("a blob of the object format is an object");
  const parts: unknown = value.value;
  if (!Array.isArray(parts) || parts.length !== 2) throw new Error("an object is its schema and its data");
  const [schema, data] = parts;
  if (!(data instanceof Map)) throw new Error("the data of an object is a map of its fields");
  if (schema === itselfText) return new ObjectValue(itself, dataMapOf(data));
  const schemaValue = dataValueOf(schema);
  if (!(schemaValue instanceof LinkValue))
    throw new Error('an object names its schema by link, or "self" when it is its own');
  return new ObjectValue(schemaValue.link, dataMapOf(data));
}

function* linksIn(value: Value): Generator<Link<unknown>> {
  if (value instanceof LinkValue) yield value.link;
  else if (Array.isArray(value)) for (const item of value) yield* linksIn(item);
  else if (typeof value === "object" && !(value instanceof Uint8Array) && isMap(value))
    for (const member of Object.values(value)) yield* linksIn(member);
}

function isSame(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, at) => byte === b[at]);
}

/**
 * The Estoc Object Format: objects written in deterministic CBOR
 * ([RFC 8949 section 4.2.1](https://www.rfc-editor.org/rfc/rfc8949#section-4.2.1)).
 *
 * - A blob of the format is one object: a tag of the format around an array of two, the schema
 *   of the object and the map of its fields. Any other bytes are refused, and are a blob of bytes
 *   that links to nothing.
 * - A value in data is an integer of magnitude up to 2^53 - 1, bytes, a string, a boolean, an
 *   array, a map by string keys or a link. Floats, null, other tags and an object inside data are
 *   refused.
 * - A link is tag 18540, the SHA-256 hash value, around the 32 bytes of the hash. A hash that
 *   names no blob to follow is written as bytes.
 * - An object names its schema by link, or by the string `"self"` when it is written to itself.
 * - Bytes that are anything but what `encode` writes for the value they hold are refused, not
 *   normalized: heads longer than the shortest, keys out of order or repeated, indefinite
 *   lengths, invalid UTF-8, and bytes after the object.
 */
export const objectFormat: Encoding<Value> = {
  encode(value) {
    if (!(value instanceof ObjectValue)) throw new Error("a blob of the object format is an object");
    const schema = value.schema === itself ? itselfText : cborValueOf(new LinkValue(value.schema));
    const bytes = encode(new Tagged(objectTag, [schema, cborMapOf(value.data)]), rfc8949EncodeOptions);
    // In Node cborg gives some values as a Buffer, whose `slice` shares memory where that of bytes copies.
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  },
  decode(bytes) {
    const value = objectValueOf(
      decode(bytes, {
        strict: true,
        strictUtf8: true,
        allowIndefinite: false,
        allowUndefined: false,
        rejectDuplicateMapKeys: true,
        useMaps: true,
        tags: Tagged.preserve(objectTag, linkTag),
      }),
    );
    if (!isSame(objectFormat.encode(value), bytes)) throw new Error("not in the deterministic encoding of RFC 8949");
    return value;
  },
  object: (data, schema) => new ObjectValue(schema, data),
  fields(value) {
    if (!(value instanceof ObjectValue)) throw new Error("not an object");
    return { data: value.data, schema: value.schema as Link<never> | Itself };
  },
  *links(value) {
    if (!(value instanceof ObjectValue)) return;
    if (value.schema !== itself) yield value.schema;
    for (const field of Object.values(value.data)) yield* linksIn(field);
  },
};
