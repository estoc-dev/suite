import type { Field, Item } from "@estoc/schema";

export function typeNameOf(type: Field | Item): string {
  return type.type === "array" ? `array of ${typeNameOf(type.items)}` : type.type;
}

export function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function quantityOf(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en")} ${count === 1 ? one : many}`;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
