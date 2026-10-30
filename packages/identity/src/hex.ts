import type { JsonObject } from "@estoc/object";

/** Bytes in lowercase hex, the one way of writing each byte string. */
export const hexSchema: JsonObject = { type: "string", pattern: "^(?:[0-9a-f]{2})*$" };
