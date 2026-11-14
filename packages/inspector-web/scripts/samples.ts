import { mkdirSync, writeFileSync } from "node:fs";
import { encodeBundle } from "@estoc/bundle";
import { encodeObject, LinkValue, linkOf, ObjectValue, objectFormat } from "@estoc/object";
import { any, array, boolean, bytes, integer, link, optional, rootSchema, schema, string } from "@estoc/schema";

// Files to open in the page by hand: one of each thing it shows. They are written beside the
// package and kept out of git, since this script writes them again.
const directory = new URL("../samples/", import.meta.url);

const noteSchema = schema("Note", {
  text: string(),
  at: integer(),
  isDraft: boolean(),
  key: bytes(),
  replies: array(link()),
  more: optional(any()),
  summary: optional(string()),
});
const photo = new TextEncoder().encode("a photo");
const reply = encodeObject(noteSchema, {
  text: "a reply",
  at: 1763078400001,
  isDraft: true,
  key: Uint8Array.of(),
  replies: [],
});
const note = encodeObject(noteSchema, {
  text: 'a note\nof two lines, with a <b>tag</b> and a "quote"',
  at: 1763078400000,
  isDraft: false,
  key: Uint8Array.from({ length: 32 }, (_, index) => index * 7),
  replies: [new LinkValue(reply.link)],
  more: { tags: ["first", "second"], files: [{ name: "photo.jpg", photo: new LinkValue(linkOf(photo)) }], empty: {} },
});
const misfit = {
  bytes: objectFormat.encode(
    new ObjectValue(noteSchema.link, {
      text: 7,
      replies: [new LinkValue(reply.link), "a reply", [new LinkValue(reply.link)]],
      title: "Hello",
    }),
  ),
};
const writtenToNote = {
  bytes: objectFormat.encode(new ObjectValue(note.link, { text: "written to a note, which is not a schema" })),
};

const files: { readonly [name: string]: Uint8Array } = {
  "note.eof": encodeBundle(note, [reply.bytes, photo, ...noteSchema.blobs]),
  "misfit.eof": encodeBundle(misfit, [reply.bytes, ...noteSchema.blobs]),
  "schema-absent.eof": encodeBundle(note, []),
  "schema-refused.eof": encodeBundle(writtenToNote, [note.bytes]),
  "note-schema.eof": encodeBundle(noteSchema, noteSchema.blobs),
  "root-schema.eof": encodeBundle(rootSchema, []),
  "not-a-bundle.eof": photo,
  "blob-twice.eof": Uint8Array.from([
    ...encodeBundle(note, [photo]),
    ...encodeBundle(note, [photo]).slice(note.bytes.length),
  ]),
};

mkdirSync(directory, { recursive: true });
for (const [name, file] of Object.entries(files)) writeFileSync(new URL(name, directory), file);
console.log(`wrote ${Object.keys(files).length} files to ${directory.pathname}`);
