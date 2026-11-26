import { mkdirSync, writeFileSync } from "node:fs";
import { markdownBodyOf, markdownBodySchema, postSchema } from "@estoc/blog";
import { encodeBundle } from "@estoc/bundle";
import { ed25519, loadIdentity, SoftwareSigner } from "@estoc/identity";
import { encodeObject, LinkValue, linkOf, ObjectValue, objectFormat, rootSchema } from "@estoc/object";
import { any, array, boolean, bytes, integer, link, optional, schema, string } from "@estoc/schema";

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
const misfit = objectFormat.encode(
  new ObjectValue(noteSchema.link, {
    text: 7,
    replies: [new LinkValue(reply.link), "a reply", [new LinkValue(reply.link)]],
    title: "Hello",
  }),
);
const pathSchema = schema("Paths", { a: any(), "a/0": string(), label: string(), "label: detail": string() });
const unplacedExample = objectFormat.encode(
  new ObjectValue(pathSchema.link, { a: ["a string"], "a/0": 7, label: "a string", "label: detail": 8 }),
);
const writtenToNote = objectFormat.encode(
  new ObjectValue(note.link, { text: "written to a note, which is not a schema" }),
);
const body = markdownBodyOf(
  [
    "## A heading",
    "",
    "A paragraph with *emphasis*, `code`, a [link](https://estoc.dev) and <b>a tag</b>.",
    "",
    "- one item",
    "- another, with an image the page does not load: ![a diagram](https://estoc.dev/diagram.png)",
    "",
    "> A quote.",
    "",
    "```ts",
    "const a = 1 < 2;",
    "```",
    "",
  ].join("\n"),
);
const misfitBody = objectFormat.encode(new ObjectValue(markdownBodySchema.link, { text: 7 }));
const post = encodeObject(postSchema, {
  title: "A post",
  description: "What a post links to.",
  date: "2026-10-20",
  body: new LinkValue(body.link),
});

const { publish, signatures } = loadIdentity([ed25519]);
const identityVersionInHand = async <T>(inHand: T) => inHand;
const root = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1));
const agent = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(2));
const signedIdentity = await publish(root, { agents: [agent.key], at: 1763078400000 });
const signature = await signatures.actor(agent, signedIdentity, identityVersionInHand).sign(post);
const signedPost = [
  ...signatures.schema.blobs,
  post.bytes,
  body.bytes,
  ...postSchema.blobs,
  ...markdownBodySchema.blobs,
];
const signatureAlone = signature.blobs.filter((bytes) => linkOf(bytes) === signature.link);
const unverifiedSignature = encodeObject(signatures.schema, {
  signedIdentity: new LinkValue(signedIdentity.link),
  object: new LinkValue(signature.object),
  signature: signature.signature.map((byte, index) => (index === 1 ? byte ^ 1 : byte)),
});

const files: { readonly [name: string]: Uint8Array } = {
  "note.eof": encodeBundle(note.link, [note.bytes, reply.bytes, photo, ...noteSchema.blobs]),
  "post.eof": encodeBundle(post.link, [post.bytes, body.bytes, ...postSchema.blobs, ...markdownBodySchema.blobs]),
  "body-misfit.eof": encodeBundle(linkOf(misfitBody), [misfitBody, ...markdownBodySchema.blobs]),
  "body-misfit-schema-absent.eof": encodeBundle(linkOf(misfitBody), [misfitBody]),
  "signature.eof": encodeBundle(signature.link, [...signature.blobs, ...signedPost]),
  "signature-identity-absent.eof": encodeBundle(signature.link, [...signatureAlone, ...signedPost]),
  "signature-unverified.eof": encodeBundle(unverifiedSignature.link, [
    unverifiedSignature.bytes,
    ...signedIdentity.blobs,
    ...signedPost,
  ]),
  "misfit.eof": encodeBundle(linkOf(misfit), [misfit, reply.bytes, ...noteSchema.blobs]),
  "unplaced.eof": encodeBundle(linkOf(unplacedExample), [unplacedExample, ...pathSchema.blobs]),
  "left-out.eof": encodeBundle(note.link, [
    note.bytes,
    ...noteSchema.blobs,
    misfit,
    new TextEncoder().encode("a stray blob"),
  ]),
  "schema-absent.eof": encodeBundle(note.link, [note.bytes]),
  "schema-refused.eof": encodeBundle(linkOf(writtenToNote), [writtenToNote, note.bytes]),
  "note-schema.eof": encodeBundle(noteSchema.link, noteSchema.blobs),
  "root-schema.eof": encodeBundle(rootSchema.link, [rootSchema.bytes]),
  "not-a-bundle.eof": photo,
  "blob-twice.eof": Uint8Array.from([
    ...encodeBundle(note.link, [note.bytes, photo]),
    ...encodeBundle(note.link, [note.bytes, photo]).slice(note.bytes.length),
  ]),
};

mkdirSync(directory, { recursive: true });
for (const [name, file] of Object.entries(files)) writeFileSync(new URL(name, directory), file);
console.log(`wrote ${Object.keys(files).length} files to ${directory.pathname}`);
