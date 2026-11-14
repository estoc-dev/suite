// @vitest-environment happy-dom
import { inspect } from "@estoc/inspector";
import { encodeObject, type Link, LinkValue, linkOf } from "@estoc/object";
import { link, schema } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { inspectionView } from "../src/inspection-view.ts";

const photo = Uint8Array.of(0, 10, 255);
const albumSchema = schema("Album", { cover: link() });
const album = encodeObject(albumSchema, { cover: new LinkValue(linkOf(photo)) });
const reader = new Map<Link<unknown>, Uint8Array>(
  [album.bytes, photo, ...albumSchema.blobs].map((blob) => [linkOf(blob), blob]),
);

const viewOf = async (link: Link<unknown>) => inspectionView(await inspect(link, reader));

const textsOf = (view: HTMLElement, selector: string) =>
  Array.from(view.querySelectorAll(selector), (node) => node.textContent);

describe("the view of an inspection", () => {
  it("shows the link alone where no blob is given", async () => {
    const absentLink = linkOf(Uint8Array.of(1));
    const view = await viewOf(absentLink);
    expect(textsOf(view, "dd")).toEqual([absentLink]);
    expect(textsOf(view, ".note")).toEqual(["No blob is given for it."]);
  });

  it("shows the size and the hex of bytes that are not an object", async () => {
    const view = await viewOf(linkOf(photo));
    expect(textsOf(view, "dd")).toEqual([linkOf(photo), "3 bytes"]);
    expect(textsOf(view, ".dump")).toEqual(["000aff"]);
  });

  it("leads from an object to the schema it names and to each link in its data", async () => {
    const view = await viewOf(album.link);
    expect(Array.from(view.querySelectorAll("a"), (anchor) => anchor.getAttribute("href"))).toEqual([
      `#${albumSchema.link}`,
      `#${linkOf(photo)}`,
    ]);
  });
});
