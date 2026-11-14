import type { Field, Item } from "@estoc/schema";

export function typeNameOf(type: Field | Item): string {
  return type.type === "array" ? `array of ${typeNameOf(type.items)}` : type.type;
}

export function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function sizeOf(bytes: Uint8Array): string {
  return bytes.length === 1 ? "1 byte" : `${bytes.length.toLocaleString("en")} bytes`;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
