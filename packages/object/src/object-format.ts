import { bytesToHex } from "@noble/hashes/utils.js";
import { decode, encode, rfc8949EncodeOptions, Tagged } from "cborg";
import { digestOf, isLink, type Link } from "./link.ts";

// "eof?" in ASCII, so that the bytes of every object start with the name of the format.
const objectTag = 0x656f663f;
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
 * CBOR marks a link with a tag, so in memory it is a value of its own, and a string or bytes are
 * what they are whatever they hold.
 */
// `T` is kept out of the class, which TypeScript would resolve when it checks that data holding
// the link is data of the format: two schemas whose objects link to each other would then refer to
// themselves.
export type LinkValue<T> = UntypedLinkValue & { readonly link: Link<T> };

export const LinkValue = UntypedLinkValue as new <T>(link: Link<T>) => LinkValue<T>;

/** A blob cannot hold its own hash, so the object format writes `"self"` in place of the link. */
export const itself: unique symbol = Symbol("itself");
export type Itself = typeof itself;

export class ObjectValue {
  readonly schema: Link<unknown> | Itself;
  readonly data: ValueMap;

  constructor(schema: Link<unknown> | Itself, data: ValueMap) {
    this.schema = schema;
    this.data = data;
  }
}

export interface ValueMap {
  readonly [key: string]: Value;
}

export type Value = boolean | number | string | Uint8Array | readonly Value[] | ValueMap | UntypedLinkValue;

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
 * ([RFC 8949 section 4.2.1](https://www.rfc-editor.org/rfc/rfc8949#section-4.2.1)). Bytes that are
 * anything but what `encode` writes for the object they hold are refused, not normalized, so that an
 * object has one encoding and one link.
 */
export const objectFormat = {
  encode(object: ObjectValue): Uint8Array {
    const schema = object.schema === itself ? itselfText : cborValueOf(new LinkValue(object.schema));
    const bytes = encode(new Tagged(objectTag, [schema, cborMapOf(object.data)]), rfc8949EncodeOptions);
    // In Node cborg gives some values as a Buffer, whose `slice` shares memory where that of bytes copies.
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  },
  decode(bytes: Uint8Array): ObjectValue {
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
  /**
   * It may give more than the readers of the object follow, but leaves none out: a reader checks
   * each blob it follows, and a blob left out would be missing when it is followed.
   */
  *links(object: ObjectValue): Iterable<Link<unknown>> {
    if (object.schema !== itself) yield object.schema;
    for (const field of Object.values(object.data)) yield* linksIn(field);
  },
};
