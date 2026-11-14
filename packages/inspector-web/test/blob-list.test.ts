import { decodeBundle, encodeBundle } from "@estoc/bundle";
import { encodeObject, LinkValue, linkOf } from "@estoc/object";
import { array, link, rootSchema, schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { blobListOf } from "../src/blob-list.ts";

const noteSchema = schema("Note", { text: string(), replies: array(link()) });
const photo = new TextEncoder().encode("a photo");
const reply = encodeObject(noteSchema, { text: "a reply", replies: [new LinkValue(linkOf(photo))] });
const note = encodeObject(noteSchema, { text: "a note", replies: [new LinkValue(reply.link)] });
const stray = new TextEncoder().encode("a stray blob");

const listOf = (root: { readonly bytes: Uint8Array }, blobs: Iterable<Uint8Array>) =>
  blobListOf(decodeBundle(encodeBundle(root, blobs)));

describe("the blob list of a bundle", () => {
  it("has the root, then the blobs as the bundle carries them", async () => {
    const blobs = await listOf(note, [photo, reply.bytes]);
    expect(blobs.map(({ inspection }) => inspection.link)).toEqual([note.link, linkOf(photo), reply.link]);
    expect(blobs.map(({ bytes }) => bytes)).toEqual([note.bytes, photo, reply.bytes]);
    expect(blobs.map(({ isRoot }) => isRoot)).toEqual([true, false, false]);
  });

  it("has what each blob reads as through the bundle", async () => {
    const blobs = await listOf(note, [photo, ...noteSchema.blobs]);
    expect(blobs.map(({ inspection }) => inspection.kind)).toEqual(["object", "bytes", "object", "object"]);
    expect(blobs.map(({ inspection }) => inspection.kind === "object" && inspection.schema.kind)).toEqual([
      "schema",
      false,
      "schema",
      "schema",
    ]);
  });

  it("reaches from the root the blobs that links in data and the schemas named lead to", async () => {
    const blobs = await listOf(note, [reply.bytes, photo, ...noteSchema.blobs]);
    expect(blobs.map(({ inspection }) => inspection.link)).toEqual([
      note.link,
      reply.link,
      linkOf(photo),
      noteSchema.link,
      rootSchema.link,
    ]);
    expect(blobs.map(({ isReachedFromRoot }) => isReachedFromRoot)).toEqual([true, true, true, true, true]);
  });

  it("does not reach a blob that nothing in the bundle links to", async () => {
    const blobs = await listOf(note, [reply.bytes, stray]);
    expect(blobs.map(({ isReachedFromRoot }) => isReachedFromRoot)).toEqual([true, true, false]);
  });

  it("does not reach a blob through one that the bundle leaves out", async () => {
    const blobs = await listOf(note, [photo]);
    expect(blobs.map(({ isReachedFromRoot }) => isReachedFromRoot)).toEqual([true, false]);
  });

  it("reaches each blob once where blobs link to the same one", async () => {
    const both = encodeObject(noteSchema, {
      text: "two replies",
      replies: [new LinkValue(reply.link), new LinkValue(reply.link), new LinkValue(note.link)],
    });
    const blobs = await listOf(both, [note.bytes, reply.bytes]);
    expect(blobs.map(({ isReachedFromRoot }) => isReachedFromRoot)).toEqual([true, true, true]);
  });
});
