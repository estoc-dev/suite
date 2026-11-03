import { base64urlnopad } from "@scure/base";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Reads UTF-8, refusing bytes that are not. */
export function textOf(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function base64url(bytes: Uint8Array): string {
  return base64urlnopad.encode(bytes);
}

/** Reads base64url without padding, refusing anything else, so one value has one encoding. */
export function fromBase64url(text: unknown, what: string): Uint8Array {
  if (typeof text !== "string") throw new Error(`${what} is not a string`);
  try {
    return base64urlnopad.decode(text);
  } catch (cause) {
    throw new Error(`${what} is not base64url without padding`, { cause });
  }
}

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseObject(text: string, what: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${what} is not JSON`, { cause });
  }
  if (!isObject(value)) throw new Error(`${what} is not a JSON object`);
  return value;
}

/** A JSON object written as base64url of its UTF-8, as JOSE writes a protected header. */
export function readEncodedObject(text: unknown, what: string): JsonObject {
  return parseObject(textOf(fromBase64url(text, what)), what);
}

export function optionalString(object: JsonObject, name: string, what: string): string | undefined {
  const value = object[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${what}: ${name} is not a string`);
  return value;
}

export function requiredString(object: JsonObject, name: string, what: string): string {
  const value = optionalString(object, name, what);
  if (value === undefined) throw new Error(`${what}: ${name} is missing`);
  return value;
}

/** 32 bits, big-endian. */
export function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}
