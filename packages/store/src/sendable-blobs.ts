import { linkOf } from "@estoc/object";
import { secretSchema } from "@estoc/schema";
import { recordSchema } from "./record.ts";
import { namedSchemaOf } from "./scanned-blob.ts";

/**
 * For blobs on their way to another party.
 *
 * - What sends an object sends its closure, so an object that links to a key, or to an object that
 *   does, would carry the key out. A store gives a Secret like any blob, so this is asked where
 *   the blobs leave.
 * - The store of the other party refuses a bundle with a Record in it, so one is refused here,
 *   where the sender sees it.
 * - Each blob is passed on before the next is asked for, since a source may give them all in turn
 *   in the one array.
 */
export function* sendableBlobs<Blob extends Uint8Array>(blobs: Iterable<Blob>): Generator<Blob> {
  for (const bytes of blobs) {
    const namedSchema = namedSchemaOf(bytes);
    if (namedSchema === secretSchema.link) throw new Error(`${linkOf(bytes)} is a Secret, which is not sent`);
    if (namedSchema === recordSchema.link) throw new Error(`${linkOf(bytes)} is a Record, which is not sent`);
    yield bytes;
  }
}
