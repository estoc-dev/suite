import { bytes, type DataOf, schema } from "./fields.ts";

/**
 * Anyone can write an object of this schema, and doing so only narrows where it goes: what shows a
 * store to an app leaves it out, and what sends blobs to another party refuses it. A store keeps it
 * like any blob.
 */
export const secretSchema = schema("Secret", { bytes: bytes() });

export type SecretData = DataOf<typeof secretSchema>;
