import { linkOf } from "@estoc/object";
import { secretSchema } from "@estoc/schema";
import { namedSchemaOf } from "./scanned-blob.ts";

/**
 * For blobs on their way to another party. What sends an object sends its closure, so an object
 * that links to a key, or to an object that does, would carry the key out. A store gives a Secret
 * like any blob, so this is asked where the blobs leave.
 */
export function refuseSecrets(blobs: Iterable<Uint8Array>): void {
  for (const bytes of blobs)
    if (namedSchemaOf(bytes) === secretSchema.link) throw new Error(`${linkOf(bytes)} is a Secret, which is not sent`);
}
