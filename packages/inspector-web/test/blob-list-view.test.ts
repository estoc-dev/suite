// @vitest-environment happy-dom
import { decodeBundle, encodeBundle } from "@estoc/bundle";
import { encodeObject, LinkValue, linkOf, ObjectValue, objectFormat } from "@estoc/object";
import { link, rootSchema, schema } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { blobListOf } from "../src/blob-list.ts";
import { blobListView } from "../src/blob-list-view.ts";

const photo = Uint8Array.of(0, 10, 255);
const albumSchema = schema("Album", { cover: link() });
const album = encodeObject(albumSchema, { cover: new LinkValue(linkOf(photo)) });
const stray = objectFormat.encode(new ObjectValue(album.link, {}));

const textsOf = (view: HTMLElement, selector: string) =>
  Array.from(view.querySelectorAll(selector), (node) => node.textContent);

describe("the view of a blob list", () => {
  it("has a blob an item, with what it reads as and its size", async () => {
    const bundle = decodeBundle(encodeBundle(album.link, [album.bytes, photo, ...albumSchema.blobs, stray]));
    const view = blobListView(await blobListOf(bundle), linkOf(photo));
    const sizeOf = (bytes: Uint8Array) => `${bytes.length} bytes`;
    expect(textsOf(view, "li")).toEqual([
      `${album.link}root` + `Album ${albumSchema.link}${sizeOf(album.bytes)}`,
      `${linkOf(photo)}bytes3 bytes`,
      `${albumSchema.link}Schema ${rootSchema.link}${sizeOf(albumSchema.bytes)}`,
      `${rootSchema.link}Schema ${rootSchema.link}${sizeOf(rootSchema.bytes)}`,
      `${linkOf(stray)}not reached from the root` +
        `object written to ${album.link}, which is not a schema of Estoc Schema${sizeOf(stray)}`,
    ]);
  });

  it("marks as shown the blob of the link given, and no other", async () => {
    const bundle = decodeBundle(encodeBundle(album.link, [album.bytes, photo]));
    const view = blobListView(await blobListOf(bundle), linkOf(photo));
    expect(Array.from(view.querySelectorAll("li"), (item) => item.getAttribute("aria-current"))).toEqual([
      null,
      "true",
    ]);
  });

  it("says of an object whose schema the bundle leaves out that no blob is given for it", async () => {
    const bundle = decodeBundle(encodeBundle(album.link, [album.bytes]));
    const view = blobListView(await blobListOf(bundle), album.link);
    expect(textsOf(view, "li")).toEqual([
      `${album.link}root` +
        `object written to ${albumSchema.link}, for which no blob is given${album.bytes.length} bytes`,
    ]);
  });
});
