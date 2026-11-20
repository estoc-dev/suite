import { type Bundle, decodeBundle, encodeBundle } from "@estoc/bundle";
import { type EncodedObject, encodeObject, LinkValue } from "@estoc/object";
import { mailboxSchema } from "../src/index.ts";

/** A mailbox sealed to `key` at `transport`, in a bundle with its closure, as it is handed out on its own. */
export function mailboxBundle(key: Uint8Array, transport: EncodedObject): Bundle {
  const mailbox = encodeObject(mailboxSchema, { key, transport: new LinkValue(transport.link) });
  const closure = [mailbox.bytes, ...mailboxSchema.blobs, transport.bytes, ...transport.schema.blobs];
  return decodeBundle(encodeBundle(mailbox.link, closure));
}
