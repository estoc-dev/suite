import { bytes, type DataOf, schema } from "./fields.ts";

/**
 * Anyone can write an object of this schema, and doing so only narrows who reads it: a store gives
 * it to no reader but one made to read Secrets, and refuses a closure that reaches it.
 */
export const secretSchema = schema("Secret", { bytes: bytes() });

export type SecretData = DataOf<typeof secretSchema>;
